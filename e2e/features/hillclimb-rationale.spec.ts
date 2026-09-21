import { expect, test } from "@playwright/test";
import {
  firstOpenGap,
  firstPartialGap,
  runRecord,
  runStage,
  seedMapped,
  stageSignals,
  validateBandHigh,
} from "../support/synapse";

/** The corrections a stage's proposer was briefed with on a given run. */
async function hintsFor(request: Parameters<typeof runRecord>[0], runId: string) {
  const run = await runRecord(request, runId);
  const step = run.steps.find((candidate) => candidate.name === "hillclimb:hints");
  expect(step, "an agentic stage must record the hints it was given").toBeTruthy();
  return (step!.data as { open: number; corrections: string[] }).corrections ?? [];
}

test.describe.configure({ mode: "serial" });

test.describe("Hillclimb from edit rationales", () => {
  test.beforeAll(async ({ request }) => {
    await seedMapped(request);
    await runStage(request, "S8");
  });

  test("an edit at the validation gate becomes an edit record and a stage signal", async ({ request }) => {
    const gap = await firstOpenGap(request);
    const edit = await runStage(request, "S5", {
      action: "classify",
      gap_id: gap.gap_id,
      status: "validated_open",
      rationale: "Do not treat a publication plan line as coverage",
    });
    const { edits, signals } = await stageSignals(request, edit.run_id);
    expect(edits[0]!.rationale).toBe("Do not treat a publication plan line as coverage");
    expect(edits[0]!.entity_id).toBe(gap.gap_id);
    expect(edits[0]!.field).toBe("computed_status");
    expect(signals[0]!.rationale).toBe("Do not treat a publication plan line as coverage");
    expect(signals[0]!.kind).toBe("user_edit");
    expect(signals[0]!.stage).toBe("S5");
  });

  test("a band rationale briefs the next prioritization proposal", async ({ request }) => {
    const gap = await firstOpenGap(request);
    const correction = `Pricing questions are High when a dossier is in flight ${Date.now()}`;
    await validateBandHigh(request, gap.gap_id, correction);

    const rerun = await runStage(request, "S8");
    const corrections = await hintsFor(request, rerun.run_id);
    expect(
      corrections,
      "the reviewer's own words must reach the proposer that made the suggestion",
    ).toContain(correction);
  });

  test("a split rationale briefs the next split proposal", async ({ request }) => {
    const partial = await firstPartialGap(request);
    if (!partial) return;
    const correction = `Keep the comparator question out of the addressed slice ${Date.now()}`;
    const proposed = await runStage<{ proposal: { addressed_name: string; addressed_statement: string; open_name: string; open_statement: string; addressed_tactic_ids: string[] } | null }>(
      request,
      "S6",
      { gap_id: partial.gap_id },
    );
    const proposal = proposed.output.proposal!;
    await runStage(request, "S6", {
      gap_id: partial.gap_id,
      apply: {
        addressed_name: proposal.addressed_name,
        addressed_statement: proposal.addressed_statement,
        open_name: proposal.open_name,
        open_statement: proposal.open_statement,
        addressed_tactic_ids: proposal.addressed_tactic_ids,
        open_tactic_ids: [],
        rationale: correction,
      },
    });

    const next = await firstPartialGap(request);
    if (!next) return;
    const rerun = await runStage(request, "S6", { gap_id: next.gap_id });
    expect(await hintsFor(request, rerun.run_id)).toContain(correction);
  });

  test("shows the rationale trail and the open signals on the runs page", async ({ page, request }) => {
    const gap = await firstOpenGap(request);
    await runStage(request, "S8");
    await validateBandHigh(request, gap.gap_id, "Blocks the payer submission this cycle");

    await page.goto("/runs");
    await expect(page.getByRole("heading", { name: /^edit rationales$/i })).toBeVisible();
    await expect(page.getByRole("heading", { name: /^hillclimb signals$/i })).toBeVisible();
    await expect(page.getByText(/Blocks the payer submission this cycle/).first()).toBeVisible();
    await expect(page.getByText(/Replayed into the next proposal/)).toBeVisible();
  });

  test("files an eval run for the stage that produced it", async ({ page, request }) => {
    await runStage(request, "S2", { dry_run: true });
    await page.goto("/runs");
    await expect(page.getByRole("heading", { name: /^eval runs$/i })).toBeVisible();
    await expect(page.getByText(/S2 · s2-gap-extract\.pcj/).first()).toBeVisible();
    await expect(page.getByText(/exchanges 3/).first()).toBeVisible();
  });
});
