import { expect, test } from "@playwright/test";
import { freshWorkspace } from "../support/session";
import {
  firstOpenGap,
  iegpAction,
  planAction,
  firstPartialGap,
  runRecord,
  runStage,
  seedMapped,
  stageSignals,
  validateBandHigh,
} from "../support/synapse";

/** The past decisions a stage was shown as worked examples on a given run (KAN-79). */
async function workedExamplesFor(request: Parameters<typeof runRecord>[0], runId: string) {
  const run = await runRecord(request, runId);
  const step = run.steps.find((candidate) => candidate.name === "learning:worked-examples");
  expect(step, "an agentic stage must record the worked examples it was shown").toBeTruthy();
  return (step!.data as { used: { id: string; scope: string; kind: string }[] }).used ?? [];
}

test.describe.configure({ mode: "serial" });

test.describe("Hillclimb from edit rationales", () => {
  freshWorkspace({ name: "hillclimb rationales", seed: async request => {
    await seedMapped(request);
    await runStage(request, "S8");
  } });

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

  test("shows a corrected band only to a related, independent gap", async ({ request }) => {
    const matrix = { x_axis: "decision_impact", y_axis: "time_pressure" };
    async function gap(name: string, statement: string) {
      const created = await iegpAction(request, { action: "create_gap", name, statement, domain: "comparative_effectiveness" });
      const id = String(created.id);
      await iegpAction(request, { action: "validate_gap", gap_id: id });
      return id;
    }
    const original = await gap("Dossier durability", "The dossier lacks durability comparisons for maintenance therapy.");
    const related = await gap("Dossier safety", "Which adverse events belong in the updated dossier?");
    const score = (id: string) => runStage<{ placements: { suggested_band: string }[] }>(request, "S8", { gap_ids: [id], ...matrix });
    const suggestion = (await score(original)).output.placements[0]!;
    await planAction(request, { action: "validate_band", gap_id: original, ...matrix,
      band: suggestion.suggested_band === "high" ? "low" : "high", rationale: "Adjust the band for the dossier deadline." });

    const relatedExamples = await workedExamplesFor(request, (await score(related)).run_id);
    const corrected = relatedExamples.filter(example => example.kind === "s8_band" && example.scope === "this_plan");
    expect(corrected).toHaveLength(1);
    const originalExamples = await workedExamplesFor(request, (await score(original)).run_id);
    expect(originalExamples.map(example => example.id)).not.toContain(corrected[0]!.id);
  });

  test("a split run records the worked examples it was shown", async ({ request }) => {
    const partial = await firstPartialGap(request);
    if (!partial) return;
    const correction = `Keep the comparator question out of the addressed slice ${Date.now()}`;
    const proposed = await runStage<{ proposal: { expected_resolution: string; addressed_name: string; addressed_statement: string; open_name: string; open_statement: string; addressed_tactic_ids: string[] } | null }>(
      request,
      "S6",
      { gap_id: partial.gap_id },
    );
    const proposal = proposed.output.proposal!;
    await runStage(request, "S6", {
      gap_id: partial.gap_id,
      apply: {
        expected_resolution: proposal.expected_resolution,
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
    // The rationale is no longer pasted in as a rule (KAN-79); the run lists the past cases it saw.
    expect(Array.isArray(await workedExamplesFor(request, rerun.run_id))).toBe(true);
  });

  test("shows the rationale trail and the open signals on the runs page", async ({ page, request }) => {
    const gap = await firstOpenGap(request);
    await runStage(request, "S8");
    await validateBandHigh(request, gap.gap_id, "Blocks the payer submission this cycle");

    await page.goto("/admin/runs");
    await expect(page.getByRole("heading", { name: /^edit rationales$/i })).toBeVisible();
    await expect(page.getByRole("heading", { name: /^hillclimb signals$/i })).toBeVisible();
    await expect(page.getByText(/Blocks the payer submission this cycle/).first()).toBeVisible();
    await expect(page.getByText(/Signals record feedback from live runs and reviewers/)).toBeVisible();
  });

  test("files an eval run for the stage that produced it", async ({ page, request }) => {
    await runStage(request, "S2", { dry_run: true });
    await page.goto("/admin/runs");
    await expect(page.getByRole("heading", { name: /^eval runs$/i })).toBeVisible();
    await expect(page.getByText(/S2 · s2-gap-extract\.pcj/).first()).toBeVisible();
    await expect(page.getByText(/exchanges 3/).first()).toBeVisible();
  });
});
