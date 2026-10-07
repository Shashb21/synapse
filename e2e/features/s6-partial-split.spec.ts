import { expect, test } from "@playwright/test";
import { fillNameIfAsked, freshWorkspace } from "../support/session";
import {
  consolidate,
  expectRouteIsHonest,
  expectThreeExchanges,
  firstPartialGap,
  runRecord,
  runStage,
  seedMapped,
  iegpAction,
} from "../support/synapse";
import { openInventoryRow } from "../support/inventory";

type SplitOutput = {
  mode: string;
  proposal: {
    parent_gap_id: string;
    addressed_name: string;
    addressed_statement: string;
    addressed_tactic_ids: string[];
    open_name: string;
    open_statement: string;
    uncovered_dimensions: string[];
    confidence: number;
    rationale: string[];
  } | null;
  applied: boolean;
  edit_id: string | null;
};

test.describe.configure({ mode: "serial" });

test.describe("S6 partial gap split", () => {
  freshWorkspace({ name: "S6 current human coverage", seed: seedConfirmedPartial });

  test("a partially addressed gap exists and must be resolved before Prioritize", async ({ page, request }) => {
    const partial = await firstPartialGap(request);
    expect(partial, "the demo corpus should produce a partially addressed gap").toBeTruthy();

    await page.goto("/?place=gaps");
    // The inventory's row actions are client components: wait until they are live.
    await page.waitForLoadState("networkidle");
    await openInventoryRow(page, partial!.gap_id);
    const card = page
      .locator("article")
      .filter({ has: page.getByRole("button", { name: /resolve this partially addressed gap/i }) })
      .first();
    await expect(card).toBeVisible();
    // A Partial card offers split or rewrite, and cannot simply be confirmed.
    await expect(card.getByRole("button", { name: /^confirm status$/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^partial \(/i })).toBeVisible();
  });

  test("proposes the addressed slice and the open leftover through three exchanges", async ({ request }) => {
    const partial = await firstPartialGap(request);
    const result = await runStage<SplitOutput>(request, "S6", { gap_id: partial!.gap_id });
    expect(result.output.proposal).toBeTruthy();
    expect(result.output.applied).toBe(false);

    const proposal = result.output.proposal!;
    expect(proposal.open_name.toLowerCase()).not.toBe(proposal.addressed_name.toLowerCase());
    expect(proposal.rationale.length).toBeGreaterThan(0);

    const { run } = await expectThreeExchanges(request, result.run_id);
    expectRouteIsHonest(run);
  });

  test("fills the split dialog from the proposal and applies only what the user validates", async ({
    page,
    request,
  }) => {
    const partial = await firstPartialGap(request);
    expect(partial).toBeTruthy();
    await page.goto("/?place=gaps");
    await page.waitForLoadState("networkidle");
    await openInventoryRow(page, partial!.gap_id);
    const card = page.locator(`article[data-gap-id="${partial!.gap_id}"]`);
    const gapId = partial!.gap_id;
    await card.getByRole("button", { name: /resolve this partially addressed gap/i }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: /resolve partially addressed gap/i })).toBeVisible();
    await dialog.getByRole("button", { name: /suggest a split/i }).click();
    await expect(dialog.getByText(/Proposed with confidence/)).toBeVisible({ timeout: 30_000 });

    // Accepting the suggestion as-is needs no rationale.
    await fillNameIfAsked(dialog, "A. Rao");
    await expect(dialog.getByText(/needs no rationale/i)).toBeVisible();

    // Editing the suggested title is a change: the gate now requires a rationale.
    const addressedTitle = dialog.getByRole("textbox", { name: /^title$/i }).first();
    const suggestedTitle = await addressedTitle.inputValue();
    await addressedTitle.fill(`${suggestedTitle} (elderly subgroup)`);
    await dialog.getByRole("button", { name: /accept split/i }).click();
    await expect(dialog.getByText(/short rationale is required/i)).toBeVisible();

    await dialog.getByPlaceholder(/why this split or rewrite/i).fill("Chart review covers ≥65 only; comparator is still open");
    await dialog.getByRole("button", { name: /accept split/i }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });

    const after = await consolidate(request);
    expect(after.unresolved_partials.some((row) => row.gap_id === gapId)).toBe(false);
    const children = [...after.open, ...after.addressed];
    expect(children.length).toBeGreaterThan(0);
  });

  test("scores its proposals against the partial gaps as gold cases", async ({ request }) => {
    const partial = await firstPartialGap(request);
    if (!partial) {
      // Every partial has been resolved by the split above; re-seed one to score.
      await seedConfirmedPartial(request);
    }
    const response = await request.post("/api/modules/evals", {
      headers: { "content-type": "application/json" },
      data: JSON.stringify({ stage: "S6", actor_name: "Feature E2E", actor_function: "medical_affairs" }),
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    const body = (await response.json()) as {
      cases: number;
      passed: boolean;
      metrics: { name: string; value: number }[];
    };
    expect(body.cases).toBeGreaterThan(0);
    expect(body.metrics.map((metric) => metric.name)).toEqual([
      "proposal_returned",
      "leftover_is_new_text",
      "addressed_slice_has_a_tactic",
    ]);
    expect(body.metrics.find((metric) => metric.name === "proposal_returned")!.value).toBe(1);
  });

  test("records the split with its rationale for hillclimb", async ({ request }) => {
    const partial = await firstPartialGap(request);
    if (!partial) return;
    const proposed = await runStage<SplitOutput>(request, "S6", { gap_id: partial.gap_id });
    const proposal = proposed.output.proposal!;
    // The addressed slice must carry the tactic that closes it; the proposal names it.
    expect(proposal.addressed_tactic_ids.length).toBeGreaterThan(0);

    const applied = await runStage<SplitOutput>(request, "S6", {
      gap_id: partial.gap_id,
      apply: {
        addressed_name: proposal.addressed_name,
        addressed_statement: proposal.addressed_statement,
        open_name: proposal.open_name,
        open_statement: proposal.open_statement,
        addressed_tactic_ids: proposal.addressed_tactic_ids,
        open_tactic_ids: [],
        rationale: "Split so the comparator question can be prioritized on its own",
      },
    });
    expect(applied.output.applied).toBe(true);
    expect(applied.output.edit_id).toBeTruthy();
    const run = await runRecord(request, applied.run_id);
    expect(run.summary).toMatch(/Split .* into an addressed slice and an open leftover/);
  });
});

/** Model mapping is a draft; only an explicit human decision supplies current Partial. */
async function seedConfirmedPartial(request: import("@playwright/test").APIRequestContext) {
  const seeded = await seedMapped(request);
  expect((await consolidate(request)).unresolved_partials).toHaveLength(0);
  const committed = (seeded.mapping.output as { committed: { gap_id: string; tactic_ids: string[] }[] }).committed.find(row => row.tactic_ids.length);
  expect(committed, "fixture must have a mapped source tactic").toBeTruthy();
  await iegpAction(request, { action: "lock_tactic", tactic_id: committed!.tactic_ids[0], status: "planned", rationale: "Fixture reviewer confirms the committed activity is planned" });
  await iegpAction(request, { action: "validate_gap", gap_id: committed!.gap_id, note: "Verified fixture source and current supporting coverage" });
  // Replace this model-only assignment through the normal human mapping API;
  // accepting an existing mapping alone does not supply a human coverage verdict.
  await iegpAction(request, { action: "unassign_tactic", gap_id: committed!.gap_id, tactic_id: committed!.tactic_ids[0], rationale: "Review this draft mapping with an explicit coverage verdict" });
  await iegpAction(request, { action: "assign_tactic", gap_id: committed!.gap_id, tactic_id: committed!.tactic_ids[0], overall: "partial", rationale: "Fixture reviewer confirms outcomes support and a remaining comparator question" });
  expect((await consolidate(request)).unresolved_partials.some(row => row.gap_id === committed!.gap_id)).toBe(true);
}
