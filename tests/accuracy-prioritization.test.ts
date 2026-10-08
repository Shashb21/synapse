import { afterEach, expect, it } from "vitest";
import { createOrganization, createWorkspace, deleteWorkspace } from "@/accuracy/store/tenant";
import { applyClaimValidation, insertClaim } from "@/accuracy/store/claim-store";
import { setAccuracyPlacement, listAccuracyPlacements } from "@/accuracy/store/priority-store";
import { newId } from "@/modules/kernel/ids";
import { coverageProvenance } from "./support/coverage-provenance";
import { prioritizeModule } from "@/accuracy/modules/prioritize/module";
import { saveAccuracyPriorityConfig } from "@/accuracy/store/priority-store";
import { scriptedPriorityContext as scriptedContext } from "./support/accuracy-priority";
import { updateClaim } from "@/accuracy/store/claim-edit";
import { copyExperimentWorkspace } from "@/accuracy/experiments/copy-workspace";
import { getClaim, claimMetadata } from "@/accuracy/store/claim-store";
import { coveragePairRevisions, upsertCoverageDecision } from "@/accuracy/store/coverage-store";
import { readAccuracyPriorityInputs, loadAccuracyPriorityConfig } from "@/accuracy/store/priority-store";
import { suggestPriorities } from "@/modules/stages/s8-prioritization/scoring";
import { PriorityError } from "@/accuracy/store/priority-store";
import { editParseBlock } from "@/accuracy/store/parse-store";
import { listPlacements as listPlanPlacements } from "@/modules/stages/s8-prioritization/module";
import { claimFactualRevision } from "@/accuracy/domain/structured-fields";
import { persistClaimPatch } from "@/accuracy/store/claim-store";
import { updateWorkspacePlanLabel } from "@/accuracy/store/tenant";
const workspaces: string[] = [];
export const actor = { name: "Priority reviewer", function: "heor" as const };
afterEach(async () => { for (const id of workspaces.splice(0)) await deleteWorkspace(id); });
async function fixture(statement = "Comparative patient outcomes and payer evidence are missing.") {
  const org_id = await createOrganization("Priority tests");
  const workspace_id = await createWorkspace({ org_id, name: "Priority", slug: newId("priority") });
  workspaces.push(workspace_id);
  const evidence = await coverageProvenance(workspace_id, statement);
  const gap = await insertClaim({ workspace_id, claim_type: "gap", source_file_id: evidence[0].source_file_id,
    statement, metadata: { provenance: evidence } });
  await applyClaimValidation({ workspace_id, claim_ids: [gap.id], action: "validate", actor, rationale: "Verified original evidence" });
  return { workspace_id, org_id, gap, evidence };
}
it("manually validates an Open gap on reversed cost axes without a model and isolates workspace storage", async () => {
  const f = await fixture(), other = await fixture();
  const placed = await setAccuracyPlacement({ workspace_id: f.workspace_id, gap_id: f.gap.id,
    x_axis: "effort_cost", y_axis: "decision_impact", axis_scores: { effort_cost: 90, decision_impact: 10 },
    validate: true, rationale: "Low impact and high effort this cycle", actor });
  expect(placed).toMatchObject({ band: "defer", axis_scores: { effort_cost: 90, decision_impact: 10 },
    human_band: true, human_axes: ["effort_cost", "decision_impact"], validated: true, validation: { freshness: "current" } });
  expect(await listAccuracyPlacements(other.workspace_id)).toEqual([]);
  await expect(setAccuracyPlacement({ workspace_id: other.workspace_id, gap_id: f.gap.id, band: "high", rationale: "Wrong workspace", actor })).rejects.toMatchObject({ code: "unknown_gap" });
});


it("uses saved cost axes, returns bounded S8 Defer suggestions with missing context, and dry run writes no placements", async () => {
  const f = await fixture();
  await saveAccuracyPriorityConfig({ workspace_id: f.workspace_id, scope: "all", x_axis: "effort_cost", y_axis: "decision_impact", actor, rationale: "Use effort and decision impact" });
  const before = process.env.SYNAPSE_TEST_STUB_LLM; process.env.SYNAPSE_TEST_STUB_LLM = "";
  try {
    const result = await prioritizeModule.run(prioritizeModule.inputSchema.parse({ workspace_id: f.workspace_id, gap_ids: [f.gap.id], dry_run: true }), scriptedContext(f));
    expect(result.output.placements).toEqual([expect.objectContaining({ axis_scores: { effort_cost: 90, decision_impact: 10 }, suggested_band: "defer", band: "defer", validated: false,
      limitations: expect.arrayContaining(["Missing context: guideline_evidence"]), references: f.evidence })]);
    expect(await listAccuracyPlacements(f.workspace_id)).toEqual([]);
  } finally { process.env.SYNAPSE_TEST_STUB_LLM = before; }
});

it("keeps factual priority invalidation stale after the original wording is restored and revalidated", async () => {
  const f = await fixture();
  const placed = await setAccuracyPlacement({ workspace_id: f.workspace_id, gap_id: f.gap.id, band: "high", validate: true, rationale: "A human decision on current facts", actor });
  await updateClaim({ workspace_id: f.workspace_id, claim_id: f.gap.id, patch: { statement: "Revised comparative question" }, rationale: "Change the evidence question", actor });
  expect((await listAccuracyPlacements(f.workspace_id))[0]).toMatchObject({ validated: false, validation: { freshness: "stale", by: actor.name }, band: "high", human_band: true });
  await updateClaim({ workspace_id: f.workspace_id, claim_id: f.gap.id, patch: { statement: f.gap.statement }, rationale: "Restore wording for new review", actor });
  await applyClaimValidation({ workspace_id: f.workspace_id, claim_ids: [f.gap.id], action: "validate", actor, rationale: "Revalidated restored facts" });
  const retained = (await listAccuracyPlacements(f.workspace_id))[0];
  expect(retained).toMatchObject({ validated: false, validation: { freshness: "stale", by: actor.name }, rationale: placed.rationale, band: placed.band });
  expect(retained.history).toEqual(expect.arrayContaining(placed.history));
});

it("copies current placements and typed references with current rebased validation while preserving prose and original isolation", async () => {
  const f = await fixture();
  const original = await setAccuracyPlacement({ workspace_id: f.workspace_id, gap_id: f.gap.id, band: "defer", validate: true, actor, rationale: `Human review of ${f.gap.id}` });
  const copied = await copyExperimentWorkspace({ source_workspace_id: f.workspace_id, source_file_ids: [f.evidence[0].source_file_id] }); workspaces.push(copied.workspace_id);
  const row = (await listAccuracyPlacements(copied.workspace_id))[0];
  expect(row).toMatchObject({ gap_id: copied.claim_id_map[f.gap.id], workspace_id: copied.workspace_id, band: "defer", validated: true, validation: { freshness: "current" }, rationale: original.rationale });
  expect(row.references).toEqual(f.evidence.map(e => ({ ...e, source_file_id: copied.source_id_map[e.source_file_id], block_id: copied.block_id_map[e.block_id] })));
  await setAccuracyPlacement({ workspace_id: copied.workspace_id, gap_id: row.gap_id, band: "high", actor, rationale: "Change the copied decision only" });
  expect(await listAccuracyPlacements(f.workspace_id)).toEqual([original]);
  const deletion = await deleteWorkspace(copied.workspace_id); workspaces.splice(workspaces.indexOf(copied.workspace_id), 1);
  expect(deletion.deleted.priority_placements).toBe(1); expect(deletion.deleted.priority_configs).toBe(1);
});

async function realRun(f: Awaited<ReturnType<typeof fixture>>, extra: Record<string, unknown> = {}, ctx = scriptedContext(f)) {
  const before = process.env.SYNAPSE_TEST_STUB_LLM; process.env.SYNAPSE_TEST_STUB_LLM = "";
  try { return await prioritizeModule.run(prioritizeModule.inputSchema.parse({ workspace_id: f.workspace_id, gap_ids: [f.gap.id], x_axis: "effort_cost", y_axis: "decision_impact", ...extra }), ctx); }
  finally { if (before === undefined) delete process.env.SYNAPSE_TEST_STUB_LLM; else process.env.SYNAPSE_TEST_STUB_LLM = before; }
}
it("gives the identical suggestion through the shared S8 scoring seam and the Accuracy adapter", async () => {
  const f = await fixture(), state = await readAccuracyPriorityInputs({ workspace_id: f.workspace_id, gap_id: f.gap.id, x_axis: "effort_cost", y_axis: "decision_impact" });
  const accuracy = (await realRun(f, { dry_run: true })).output.placements[0];
  const ctx = scriptedContext(f), before = process.env.SYNAPSE_TEST_STUB_LLM; process.env.SYNAPSE_TEST_STUB_LLM = "";
  try {
    const s8 = await suggestPriorities({ gaps: [{ id: f.gap.id, name: f.gap.statement, statement: f.gap.statement, domain: "unknown" }],
      axes: state.axes, xAxis: state.xAxis, yAxis: state.yAxis, context: state.context, considerations: state.considerations, reviewerHints: "" },
    { workspace_id: f.workspace_id, actor, role: "heor", ai: true, route: { ...ctx.route, stage: "S8" }, run: ctx.run, complete: async request => JSON.parse((await ctx.complete(request)).raw) });
    expect(accuracy.axis_scores).toEqual(s8.accepted[0].axis_scores); expect(accuracy.suggested_band).toBe(s8.accepted[0].suggested_band);
    expect(s8.accepted[0]).toMatchObject({ axis_scores: { effort_cost: 90, decision_impact: 10 }, score: 10, suggested_band: "defer" });
  } finally { process.env.SYNAPSE_TEST_STUB_LLM = before; }
});
it("protects the judged suggestion and human scores on rerun, and keeps suggestion separate from an unvalidated human band", async () => {
  const f = await fixture();
  await realRun(f);
  const human = await setAccuracyPlacement({ workspace_id: f.workspace_id, gap_id: f.gap.id, x_axis: "effort_cost", y_axis: "decision_impact", axis_scores: { effort_cost: 10, decision_impact: 90 }, validate: true, actor, rationale: "Human prioritizes this evidence" });
  await realRun(f, {}, scriptedContext(f, { effort_cost: 60, decision_impact: 40 }));
  expect((await listAccuracyPlacements(f.workspace_id))[0]).toMatchObject({ axis_scores: human.axis_scores, band: "high", validated: true,
    suggested_band: "defer", suggested_rationale: human.suggested_rationale, validation: human.validation, history: human.history });
  await setAccuracyPlacement({ workspace_id: f.workspace_id, gap_id: f.gap.id, band: "low", actor, rationale: "Human changes the working band" });
  const rerun = (await realRun(f, {}, scriptedContext(f, { effort_cost: 0, decision_impact: 100 }))).output.placements[0];
  expect(rerun).toMatchObject({ band: "low", suggested_band: "high", validated: false, axis_scores: human.axis_scores, actor_name: actor.name });
});
it("detects saved axis definition/configuration changes and requires fresh manual validation without losing the decision history", async () => {
  const f = await fixture();
  const human = await setAccuracyPlacement({ workspace_id: f.workspace_id, gap_id: f.gap.id, band: "defer", validate: true, actor, rationale: "Human decision before configuration changed" });
  const cfg = await loadAccuracyPriorityConfig(f.workspace_id);
  await saveAccuracyPriorityConfig({ workspace_id: f.workspace_id, config: { ...cfg.catalog, axes: cfg.catalog.axes.map(a => a.id === "effort_cost" ? { ...a, higher_is_priority: true, description: "Changed axis direction" } : a) }, actor, rationale: "Change saved effort direction", expected_config_revision: cfg.revision });
  const stale = (await listAccuracyPlacements(f.workspace_id))[0];
  expect(stale).toMatchObject({ band: human.band, axis_scores: human.axis_scores, validated: false, validation: { freshness: "stale", by: actor.name } });
  expect(stale.history).toEqual(expect.arrayContaining(human.history));
  await expect(setAccuracyPlacement({ workspace_id: f.workspace_id, gap_id: f.gap.id, band: "high", validate: true, actor, rationale: "Stale review must not validate", expected_config_revision: human.config_revision })).rejects.toMatchObject({ code: "stale_revision" });
  expect((await setAccuracyPlacement({ workspace_id: f.workspace_id, gap_id: f.gap.id, band: "defer", validate: true, actor, rationale: "Reconfirm against changed axes" })).validation?.freshness).toBe("current");
});
it("guards model application against intervening human placement edits and serializes concurrent reruns into one row", async () => {
  const f = await fixture(), ctx = scriptedContext(f);
  const provider = ctx.complete; let edited = false;
  ctx.complete = async request => {
    if (!edited) {
      edited = true;
      await setAccuracyPlacement({ workspace_id: f.workspace_id, gap_id: f.gap.id, x_axis: "effort_cost", y_axis: "decision_impact",
        axis_scores: { effort_cost: 15, decision_impact: 95 }, validate: true, actor, rationale: "Human decides while model is running" });
    }
    return provider(request);
  };
  const before = process.env.SYNAPSE_TEST_STUB_LLM; process.env.SYNAPSE_TEST_STUB_LLM = "";
  try {
    const input = prioritizeModule.inputSchema.parse({ workspace_id: f.workspace_id, gap_ids: [f.gap.id], x_axis: "effort_cost", y_axis: "decision_impact" });
    await Promise.all([prioritizeModule.run(input, ctx), prioritizeModule.run(input, scriptedContext(f))]);
    const rows = await listAccuracyPlacements(f.workspace_id); expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ band: "high", validated: true, axis_scores: { effort_cost: 15, decision_impact: 95 }, actor_name: actor.name });
    const rerun = await prioritizeModule.run({ ...input, only_missing: true }, scriptedContext(f));
    expect(rerun.output.skipped).toEqual([{ gap_id: f.gap.id, reason: "already_placed" }]); expect(await listAccuracyPlacements(f.workspace_id)).toEqual(rows);
  } finally { process.env.SYNAPSE_TEST_STUB_LLM = before; }
});
it("refuses late factual inputs and configuration changes before applying model suggestions", async () => {
  for (const mutation of ["facts", "config"]) {
    const f = await fixture(), ctx = scriptedContext(f), complete = ctx.complete; let changed = false;
    ctx.complete = async request => {
      if (!changed) {
        changed = true;
        if (mutation === "facts") await updateClaim({ workspace_id: f.workspace_id, claim_id: f.gap.id, patch: { statement: "Revised evidence question" }, rationale: "Edit during scoring", actor });
        else await saveAccuracyPriorityConfig({ workspace_id: f.workspace_id, scope: "all", x_axis: "patient_impact", y_axis: "payer_value", actor, rationale: "Change configuration during scoring" });
      }
      return complete(request);
    };
    const result = await realRun(f, {}, ctx);
    expect(result.output.placements).toEqual([]); expect(result.output.skipped).toEqual([{ gap_id: f.gap.id, reason: mutation === "facts" ? "claim_validation_not_current" : "stale_revision" }]);
    expect(await listAccuracyPlacements(f.workspace_id)).toEqual([]);
  }
});
it("rejects nonfinite or incomplete model scores after retries and bounds finite raw scores without a second scoring formula", async () => {
  const f = await fixture(), ctx = scriptedContext(f), complete = ctx.complete; let scores = 0;
  ctx.complete = async request => {
    if (request.purpose !== "priority-suggester") return complete(request);
    scores++;
    return { raw: JSON.stringify({ gaps: [{ gap_id: f.gap.id, scores: { effort_cost: Infinity, decision_impact: 10 }, rationale: "Invalid nonfinite value" }] }), usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
  };
  await expect(realRun(f, {}, ctx)).rejects.toThrow(/complete score/); expect(scores).toBe(3); expect(await listAccuracyPlacements(f.workspace_id)).toEqual([]);
  const bounded = (await realRun(f, {}, scriptedContext(f, { effort_cost: -12.4, decision_impact: 189.6 }))).output.placements[0];
  expect(bounded).toMatchObject({ axis_scores: { effort_cost: 0, decision_impact: 100 }, score: 100, suggested_band: "high" });
});
it.each([
  ["planned", "full", "computed_addressed"], ["ongoing", "full", "computed_addressed"], ["completed", "full", "computed_addressed"],
  ["planned", "partial", "computed_partial"], ["planned", "limited", "computed_partial"],
  ["proposed", "full", null], ["cancelled", "full", null], ["unknown", "full", null],
] as const)("uses current effective coverage for %s / %s eligibility", async (lifecycle, overall, reason) => {
  const f = await fixture();
  const tactic = await insertClaim({ workspace_id: f.workspace_id, claim_type: "tactic", statement: "A study addresses patient outcomes.", source_file_id: f.evidence[0].source_file_id, metadata: { provenance: f.evidence, tactic_status: lifecycle } });
  await applyClaimValidation({ workspace_id: f.workspace_id, claim_ids: [tactic.id], action: "validate", actor, rationale: "Verify tactic source facts" });
  await upsertCoverageDecision({ workspace_id: f.workspace_id, gap_id: f.gap.id, tactic_id: tactic.id, ...await coveragePairRevisions({ workspace_id: f.workspace_id, gap_id: f.gap.id, tactic_id: tactic.id }), overall, actor, rationale: "Human confirms source-supported coverage" });
  const result = await realRun(f);
  expect(result.output.skipped).toEqual(reason ? [{ gap_id: f.gap.id, reason }] : []);
  expect(result.output.placements).toHaveLength(reason ? 0 : 1);
  if (reason) await expect(setAccuracyPlacement({ workspace_id: f.workspace_id, gap_id: f.gap.id, band: "high", actor, rationale: "Ineligible manual attempt" })).rejects.toMatchObject({ code: "ineligible_gap" });
});
it("excludes draft, inactive, wrong-workspace, stale claims and stale held-Open overrides with explicit reasons", async () => {
  const f = await fixture(), other = await fixture();
  const draft = await insertClaim({ workspace_id: f.workspace_id, claim_type: "gap", statement: "Draft question" });
  const rejected = await insertClaim({ workspace_id: f.workspace_id, claim_type: "gap", statement: "Rejected question" });
  await applyClaimValidation({ workspace_id: f.workspace_id, claim_ids: [rejected.id], action: "reject", actor, rationale: "Reject this question" });
  await updateClaim({ workspace_id: f.workspace_id, claim_id: f.gap.id, patch: { status_override: "open", statement: "New evidence question" }, rationale: "Override then revise evidence", actor });
  await updateClaim({ workspace_id: f.workspace_id, claim_id: f.gap.id, patch: { statement: "Another evidence question" }, rationale: "Make held status stale", actor });
  await applyClaimValidation({ workspace_id: f.workspace_id, claim_ids: [f.gap.id], action: "validate", actor, rationale: "Revalidate the revised question" });
  expect(claimMetadata((await getClaim(f.workspace_id, f.gap.id))!).status_override?.stale).toBe(true);
  const result = await realRun(f, { gap_ids: [f.gap.id, draft.id, rejected.id, other.gap.id] });
  expect(result.output.placements).toEqual([]);
  expect(result.output.skipped).toEqual([{ gap_id: f.gap.id, reason: "stale_status_override" }, { gap_id: draft.id, reason: "claim_validation_not_current" }, { gap_id: rejected.id, reason: "inactive" }, { gap_id: other.gap.id, reason: "unknown_gap" }]);
});
it("copies stale priority validation without freshening it and retains history and human values", async () => {
  const f = await fixture();
  const human = await setAccuracyPlacement({ workspace_id: f.workspace_id, gap_id: f.gap.id, band: "defer", validate: true, actor, rationale: "Review original facts" });
  await updateClaim({ workspace_id: f.workspace_id, claim_id: f.gap.id, patch: { statement: "Changed facts after human decision" }, rationale: "New question requires new review", actor });
  const copied = await copyExperimentWorkspace({ source_workspace_id: f.workspace_id, source_file_ids: [f.evidence[0].source_file_id] }); workspaces.push(copied.workspace_id);
  const row = (await listAccuracyPlacements(copied.workspace_id))[0];
  expect(row).toMatchObject({ validated: false, band: "defer", validation: { freshness: "stale", input_revision: human.validation!.input_revision }, human_band: true });
  expect(row.history).toEqual(expect.arrayContaining(human.history));
});
it("refuses invalid manual axis/band inputs without a partial placement", async () => {
  const f = await fixture();
  const invalidInputs: { axis_scores?: Record<string, number>; x_axis?: string; y_axis?: string }[] = [{ axis_scores: { effort_cost: NaN } }, { axis_scores: { effort_cost: 101 } }, { axis_scores: { absent_axis: 50 } },
    { axis_scores: { effort_cost: 20 }, x_axis: "effort_cost", y_axis: "effort_cost" }, {}, { axis_scores: { effort_cost: 30 } }];
  for (const input of invalidInputs) {
    await expect(setAccuracyPlacement({ workspace_id: f.workspace_id, gap_id: f.gap.id, actor, rationale: "Invalid manual request", ...input })).rejects.toBeInstanceOf(PriorityError);
    expect(await listAccuracyPlacements(f.workspace_id)).toEqual([]);
  }
});

it("invalidates source-backed priority validation after a source block edit, even when quotes survive and the text is later restored", async () => {
  const f = await fixture();
  const human = await setAccuracyPlacement({ workspace_id: f.workspace_id, gap_id: f.gap.id, band: "defer", validate: true, actor, rationale: "Human decision using this source" });
  const block = f.evidence[0];
  await editParseBlock({ workspace_id: f.workspace_id, block_id: block.block_id, text: `${block.quote} New source context.`, actor, rationale: "Change context while retaining original quote" });
  expect((await listAccuracyPlacements(f.workspace_id))[0].validation?.freshness).toBe("stale");
  await editParseBlock({ workspace_id: f.workspace_id, block_id: block.block_id, text: block.quote, actor, rationale: "Restore text but require another priority review" });
  expect((await listAccuracyPlacements(f.workspace_id))[0]).toMatchObject({ validated: false, validation: { freshness: "stale" }, band: human.band, rationale: human.rationale });
});
it("retains stale human placement history when a previously selected custom axis is removed", async () => {
  const f = await fixture(), base = await loadAccuracyPriorityConfig(f.workspace_id);
  const custom = { ...base.catalog.axes[0], id: "custom_impact", label: "Custom impact" };
  await saveAccuracyPriorityConfig({ workspace_id: f.workspace_id, config: { ...base.catalog, axes: [...base.catalog.axes, custom] }, actor, rationale: "Add custom strategy axis" });
  const human = await setAccuracyPlacement({ workspace_id: f.workspace_id, gap_id: f.gap.id, x_axis: "custom_impact", y_axis: "effort_cost", axis_scores: { custom_impact: 90, effort_cost: 10 }, validate: true, actor, rationale: "Human uses configured custom axis" });
  await saveAccuracyPriorityConfig({ workspace_id: f.workspace_id, config: base.catalog, actor, rationale: "Remove the retired custom axis" });
  const rows = await listAccuracyPlacements(f.workspace_id);
  expect(rows[0]).toMatchObject({ band: human.band, axis_scores: human.axis_scores, validated: false, validation: { freshness: "stale" }, history: expect.arrayContaining(human.history) });
  expect((await realRun(f)).output.placements[0]).toMatchObject({ band: human.band, human_band: true, validated: false });
});

it("resolves saved setting axes and entered context, filters settings case-insensitively and leaves plan placements untouched", async () => {
  const f = await fixture("1L patient outcomes and payer evidence are missing."), before = await listPlanPlacements();
  await updateClaim({ workspace_id: f.workspace_id, claim_id: f.gap.id, patch: { structured: { disease_setting: { state: "known", value: "1L", provenance: f.evidence } } }, actor, rationale: "Enter source-backed setting" });
  await applyClaimValidation({ workspace_id: f.workspace_id, claim_ids: [f.gap.id], action: "validate", actor, rationale: "Verify the source-backed 1L setting" });
  const cfg = await loadAccuracyPriorityConfig(f.workspace_id);
  await saveAccuracyPriorityConfig({ workspace_id: f.workspace_id, scope: "1L", x_axis: "effort_cost", y_axis: "decision_impact", context: { key_decision: "Patient outcomes decision" },
    considerations: { payer_relevance: { text: f.gap.statement, references: f.evidence } }, actor, rationale: "Save verified decision context", expected_config_revision: cfg.revision });
  const ctx = scriptedContext(f), complete = ctx.complete;
  ctx.complete = async request => {
    const data = JSON.parse(request.user);
    expect(data.context.key_decision).toBe("Patient outcomes decision");
    expect(data.considerations.payer_relevance).toMatchObject({ state: "supported", references: f.evidence });
    expect(data.axes.map((a: {id: string}) => a.id)).toEqual(["effort_cost", "decision_impact"]);
    return complete(request);
  };
  expect((await realRun(f, { setting: " 1l ", x_axis: undefined, y_axis: undefined }, ctx)).output.placements[0].suggested_band).toBe("defer");
  expect((await realRun(f, { setting: "Perioperative" })).output.skipped).toEqual([{ gap_id: f.gap.id, reason: "outside_setting" }]);
  expect(await listPlanPlacements()).toEqual(before);
});
it("treats unreferenced or unsupported contextual text as missing rather than model evidence", async () => {
  const f = await fixture();
  await saveAccuracyPriorityConfig({ workspace_id: f.workspace_id,
    considerations: { strategic_fit: { text: "Unverified strategy claim", references: [] }, guideline_evidence: { text: "Unsupported guideline endorsement", references: f.evidence } },
    actor, rationale: "Keep missing supporting context explicit" });
  const inputs = await readAccuracyPriorityInputs({ workspace_id: f.workspace_id, gap_id: f.gap.id });
  expect(inputs.considerations.guideline_evidence).toMatchObject({ state: "missing", references: [] });
  expect(inputs.considerations.strategic_fit).toMatchObject({ state: "missing", references: [] });
  expect((await realRun(f)).output.placements[0].limitations).toContain("Missing context: guideline_evidence");
});

it("does not promote a legacy/import validation token without an actual human actor and rationale into Open eligibility", async () => {
  const f = await fixture();
  const row = (await getClaim(f.workspace_id, f.gap.id))!;
  await persistClaimPatch({ workspace_id: f.workspace_id, claim_id: f.gap.id, metadata: { ...claimMetadata(row), validation: {
    action: "validate", factual_revision: claimFactualRevision(row), at: "legacy", by: "", by_function: "", rationale: "" } } });
  expect((await realRun(f)).output.skipped).toEqual([{ gap_id: f.gap.id, reason: "claim_validation_not_current" }]);
  await expect(setAccuracyPlacement({ workspace_id: f.workspace_id, gap_id: f.gap.id, band: "high", actor, rationale: "Cannot validate unproven human facts" })).rejects.toMatchObject({ code: "ineligible_gap" });
});
it("does not stale a human gap priority when unrelated tactic priority bookkeeping changes list order", async () => {
  const f = await fixture();
  const tactics = [];
  for (const statement of ["Proposed patient study A", "Proposed patient study B"]) {
    const tactic = await insertClaim({ workspace_id: f.workspace_id, claim_type: "tactic", statement, source_file_id: f.evidence[0].source_file_id, metadata: { provenance: f.evidence, tactic_status: "proposed" } });
    tactics.push(tactic);
    await applyClaimValidation({ workspace_id: f.workspace_id, claim_ids: [tactic.id], action: "validate", actor, rationale: "Verify proposed inventory source" });
    await upsertCoverageDecision({ workspace_id: f.workspace_id, gap_id: f.gap.id, tactic_id: tactic.id, ...await coveragePairRevisions({ workspace_id: f.workspace_id, gap_id: f.gap.id, tactic_id: tactic.id }), overall: "full", actor, rationale: "Proposal does not address the gap" });
  }
  const human = await setAccuracyPlacement({ workspace_id: f.workspace_id, gap_id: f.gap.id, band: "defer", validate: true, actor, rationale: "Review gap facts and current support" });
  await updateClaim({ workspace_id: f.workspace_id, claim_id: tactics[0].id, patch: { priority: "high" }, actor, rationale: "Update unrelated tactic priority metadata" });
  expect(await listAccuracyPlacements(f.workspace_id)).toEqual([human]);
});

it("retains a human priority when only the workspace plan label changes", async () => {
  const f = await fixture();
  const human = await setAccuracyPlacement({ workspace_id: f.workspace_id, gap_id: f.gap.id, band: "defer", validate: true, actor, rationale: "Validate unchanged decision inputs" });
  await updateWorkspacePlanLabel(f.workspace_id, "IEP");
  expect(await listAccuracyPlacements(f.workspace_id)).toEqual([human]);
});
