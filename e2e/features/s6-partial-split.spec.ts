import { expect, test } from "@playwright/test";
import {
  consolidate,
  expectRouteIsHonest,
  expectThreeExchanges,
  firstPartialGap,
  runRecord,
  runStage,
  seedMapped,
} from "../support/synapse";

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
  test.beforeAll(async ({ request }) => {
    await seedMapped(request);
  });

  test("a partially addressed gap exists and must be resolved before Prioritize", async ({ page, request }) => {
    const partial = await firstPartialGap(request);
    expect(partial, "the demo corpus should produce a partially addressed gap").toBeTruthy();

    await page.goto("/?place=gaps");
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
    const card = page
      .locator("article")
      .filter({ has: page.getByRole("button", { name: /resolve this partially addressed gap/i }) })
      .first();
    const gapId = (await card.locator("p.font-mono").first().textContent())?.trim() ?? "";
    expect(gapId).toMatch(/^GAP-/);
    await card.getByRole("button", { name: /resolve this partially addressed gap/i }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: /resolve partially addressed gap/i })).toBeVisible();
    await dialog.getByRole("button", { name: /suggest a split/i }).click();
    await expect(dialog.getByText(/Proposed with confidence/)).toBeVisible({ timeout: 30_000 });

    // Accepting the suggestion as-is needs no rationale.
    await dialog.getByRole("textbox", { name: /^name$/i }).fill("A. Rao");
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
      await seedMapped(request);
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
