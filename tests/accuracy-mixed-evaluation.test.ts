import { describe, expect, it } from "vitest";
import { inspectMixedPlan } from "@/accuracy/domain/mixed-plan-invariants";
import { evaluateMixedComparison } from "@/accuracy/eval/mixed-comparison";
import { experimentPackFingerprint, evaluateExperimentVersion } from "@/accuracy/eval/experiment-gold";
import { MIXED_GATE_POLICY, MIXED_GATE_POLICY_FINGERPRINT, mixedComparisonEvaluationSchema, type MixedCandidateEvidence, type MixedSourceInventory } from "@/accuracy/experiments/mixed-types";

const pack_id = "beone-bgb-58067-prmt5i";
const statement = "BGB-58067's long-term data on efficacy, quality-adjusted survival outcomes, safety and tolerability profile patterns";
const tacticName = "Extended follow-up and planned long-term, post-hoc analyses within pivotal trials on key subgroups and long-term responder profiles";
const provenance = [{ source_file_id: "source", block_id: "block", quote: "Source evidence" }];
function inventory(prefix: string): MixedSourceInventory {
  return [
    { claim_id: `${prefix}-gap`, claim_type: "gap", payload: { external_id: "NSCLC_CE_01", statement }, original_item_version_ids: ["gap-version"], original_provenance: provenance },
    { claim_id: `${prefix}-tactic`, claim_type: "tactic", payload: { id: `${prefix}-tactic`, name: tacticName }, original_item_version_ids: ["tactic-version"], original_provenance: provenance },
  ];
}
function candidate(label: "mixed" | "baseline"): MixedCandidateEvidence {
  const entry = inventory(label);
  return {
    label, status: "pending", primary_error: null, attempt_id: `${label}-attempt`, copied_workspace_id: `${label}-workspace`,
    original_assembly: { id: `${label}-assembly`, workspace_id: "workspace", created_at: "now", actor: { name: "Tester", function: "medical_affairs" }, fingerprint: label, source_file_ids: ["source"],
      items: entry.map((item, i) => ({ id: item.original_item_version_ids[0], claim_id: `original-${i}`, run_id: `run-${i}`, snapshot_id: null, iteration: null, item_index: i, payload: item.payload, source_file_id: "source", created_at: "now", claim_type: item.claim_type, canonical_claim_id: `original-${i}`, reason: "Exact selection" })),
      mappings: [], coverage: [], extraction_runs: null, linking_complete: true, output: { gaps: [entry[0].payload], tactics: [entry[1].payload] }, checks: { checker_version: "checker", status: "passed", findings: [] } },
    copy: { source_id_map: { source: `${label}-source` }, block_id_map: { block: `${label}-block` }, claim_id_map: {}, provenance_id_map: {}, original_content_fingerprint: "original", remapped_content_fingerprint: label },
    setup: { source_fingerprint: "source-fingerprint", baseline_fingerprint: "baseline-fingerprint", original_baseline_snapshot: {}, pack_fingerprint: experimentPackFingerprint(pack_id), evaluator_version: "experiment-evaluator-v1", downstream_evaluator_version: "mixed-downstream-v2", gate_policy: MIXED_GATE_POLICY, gate_policy_fingerprint: MIXED_GATE_POLICY_FINGERPRINT, code_identity: "code", configuration: { fingerprint: "configuration", modules: [] }, source_files: [{ id: "source", checksum: "checksum", content_fingerprint: "content" }], parse_blocks: [{ id: "block", source_file_id: "source", content_fingerprint: "block-content" }] },
    lineage: entry.map((item, i) => ({ kind: "selected", original_item_version_id: item.original_item_version_ids[0], original_claim_id: `original-${i}`, original_run_id: `run-${i}`, original_snapshot_id: null, original_iteration: null, original_item_index: i, selection_reason: "Exact selection", copied_claim_id: item.claim_id, copied_evidence_ids: [], original_payload: item.payload, copied_payload: item.payload })),
    gates: [], stages: [], entry_source_inventory: entry, final_source_inventory: structuredClone(entry),
    final_outputs: { inventory: structuredClone(entry), coverage: [], statuses: [{ gap_id: entry[0].claim_id, status: "open", computed: "open", override: false }], residuals: [], priorities: [], proposals: [], plan: { workspace_id: `${label}-workspace`, activities: [] } },
  };
}
function run(mixed = candidate("mixed"), baseline = candidate("baseline")) {
  return evaluateMixedComparison({ mixed, baseline, pack_id });
}

describe("mixed supported inventory evaluation", () => {
  it("assembly_gold_is_not_last_snapshot_gold", async () => {
    const result = await run();
    expect(mixedComparisonEvaluationSchema.safeParse(result).success).toBe(true);
    expect(result.evaluator_version).toBe("mixed-downstream-v2");
    expect(result.source_evaluations).toHaveLength(8);
    const gap = result.source_evaluations.find(row => row.candidate === "mixed" && row.point === "final" && row.claim_type === "gap")!;
    expect(gap.evaluation.score).toMatchObject({ found: 1, partial: 0, missed: 42, wrong: 0, precision: 1, recall: 1 / 43 });
    expect(gap.evaluation.score?.f1).toBeCloseTo(1 / 22);
    const last = evaluateExperimentVersion({ pack_id, call_kind: "need_extract", output: { gaps: [{ statement: "Last snapshot invented need" }] } });
    expect(last.score?.found).toBe(0);
    const tactic = result.source_evaluations.find(row => row.candidate === "mixed" && row.point === "final" && row.claim_type === "tactic")!;
    expect(tactic.evaluation.score).toMatchObject({ found: 1, partial: 0, missed: 35, wrong: 0, precision: 1, recall: 1 / 36 });
    expect(tactic.evaluation.score?.f1).toBeCloseTo(2 / 37);
  });
  it("lost_supported_items_are_regressions", async () => {
    const mixed = candidate("mixed");
    mixed.final_source_inventory = mixed.final_source_inventory!.filter(item => item.claim_type === "tactic");
    mixed.final_outputs!.inventory = structuredClone(mixed.final_source_inventory);
    const result = await run(mixed);
    const gap = result.source_evaluations.find(row => row.candidate === "mixed" && row.point === "final" && row.claim_type === "gap")!;
    expect(gap.evaluation.score).toMatchObject({ found: 0, partial: 0, missed: 43, wrong: 0, precision: 0, recall: 0, f1: 0 });
    expect(result.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "reference_lost", dimension: "source_gaps", proven_error: true }),
      expect.objectContaining({ kind: "correct_removed", dimension: "source_gaps", proven_error: true }),
    ]));
  });
  it("generated_proposals_are_not_false_extracted_items", async () => {
    const mixed = candidate("mixed");
    mixed.lineage.push({ kind: "ideated", copied_claim_id: "proposal", parent_claim_ids: ["mixed-gap"], run_id: "ideate-run", stage: "ideate", payload: { name: "Novel tactic" }, copied_evidence_ids: [] });
    mixed.final_source_inventory!.push({ claim_id: "proposal", claim_type: "tactic", payload: { name: "Novel tactic" }, original_item_version_ids: ["tactic-version"], original_provenance: provenance });
    const result = await run(mixed);
    expect(result.source_evaluations.find(row => row.candidate === "mixed" && row.point === "final" && row.claim_type === "tactic")!.evaluation.score?.wrong).toBe(0);
  });
  it("unlabelled_dimensions_remain_unscored", async () => {
    const mixed = candidate("mixed");
    mixed.final_outputs!.statuses[0].status = "addressed";
    const result = await run(mixed);
    for (const dimension of ["coverage", "status", "residual", "priority", "ideation", "plan"]) {
      expect(result.applicability.find(row => row.dimension === dimension)).toMatchObject({ status: "unscored" });
    }
    expect(result.changes).toContainEqual(expect.objectContaining({ kind: "status_changed", proven_error: false }));
    expect(JSON.stringify(result)).not.toMatch(/promotion_eligibility|overall_accuracy|downstream_f1/);
  });
  it("identity_mismatch_prevents_matched_gain", async () => {
    const baseline = candidate("baseline");
    baseline.setup!.configuration.fingerprint = "different";
    baseline.final_source_inventory = [];
    const result = await run(candidate("mixed"), baseline);
    expect(result.changes.some(change => change.message.includes("Matched final comparison"))).toBe(false);
    expect(result.changes.some(change => change.message.includes("Matched gain unavailable"))).toBe(true);
  });
  it("computed_status_must_agree_with_validated_source_coverage", async () => {
    const mixed = candidate("mixed");
    mixed.final_outputs!.statuses[0] = { gap_id: "mixed-gap", status: "addressed", computed: "addressed", override: false };
    const result = await run(mixed);
    expect(result.changes).toContainEqual(expect.objectContaining({ dimension: "status", kind: "invariant_failure", proven_error: true }));
  });
  it.each([
    { scenario: "reversed dates", patch: { end: "2025-12-01" }, code: "reversed_plan_dates" },
    { scenario: "unknown tactic", patch: { tactic_id: "missing" }, code: "invalid_plan_tactic" },
    { scenario: "unknown gap", patch: { gap_ids: ["missing"] }, code: "invalid_plan_gap" },
    { scenario: "missing dependency", patch: { depends_on: ["missing"] }, code: "invalid_plan_dependency" },
    { scenario: "self dependency", patch: { depends_on: ["a"] }, code: "invalid_plan_dependency" },
    { scenario: "duplicate identity", patch: {}, code: "duplicate_plan_identity" },
    { scenario: "crossed workspace", patch: {}, code: "invalid_plan_workspace" },
    { scenario: "valid plan", patch: {}, code: null },
  ])("gate checks and retained evaluator agree: $scenario", async ({ scenario, patch, code }) => {
    const mixed = candidate("mixed");
    const plan = mixed.final_outputs!.plan;
    plan.activities = [{
      id: "a", tactic_id: "mixed-tactic", start: "2026-01-01", end: "2026-02-01",
      readout: null, depends_on: [], gap_ids: ["mixed-gap"], ...patch,
    }];
    if (scenario === "duplicate identity") plan.activities.push(structuredClone(plan.activities[0]));
    if (scenario === "crossed workspace") plan.workspace_id = "other-workspace";

    const findings = inspectMixedPlan({
      plan, workspace_id: mixed.copied_workspace_id,
      tactic_ids: ["mixed-tactic"], gap_ids: ["mixed-gap"],
    });
    const evaluated = await run(mixed);
    const planErrors = evaluated.changes.filter(row => row.dimension === "plan" && row.kind === "invariant_failure");

    if (code) expect(findings).toContainEqual(expect.objectContaining({ code, severity: "blocking" }));
    else expect(findings).toEqual([]);
    expect(planErrors.map(row => row.message)).toEqual(findings.map(row => `mixed: ${row.message}`));
  });
  it("cyclic_gantt_dependencies_are_proven_structural_failures", async () => {
    const mixed = candidate("mixed");
    mixed.final_outputs!.plan.activities = [
      { id: "a", tactic_id: "mixed-tactic", start: "2026-01-01", end: "2026-02-01", readout: null, depends_on: ["b"], gap_ids: ["mixed-gap"] },
      { id: "b", tactic_id: "mixed-tactic", start: "2026-01-01", end: "2026-02-01", readout: null, depends_on: ["a"], gap_ids: ["mixed-gap"] },
    ];
    const result = await run(mixed);
    expect(result.changes).toContainEqual(expect.objectContaining({ dimension: "plan", kind: "invariant_failure", proven_error: true }));
  });
  it("missing_final_inventory_is_unavailable_not_an_empty_extraction", async () => {
    const mixed = candidate("mixed");
    mixed.status = "blocked";
    mixed.final_source_inventory = null;
    mixed.final_outputs = null;
    const result = await run(mixed);
    const finals = result.source_evaluations.filter(row => row.candidate === "mixed" && row.point === "final");
    expect(finals).toHaveLength(2);
    expect(finals.every(row => row.evaluation.status === "model_error" && row.evaluation.score === undefined)).toBe(true);
    expect(result.changes.some(row => row.kind === "reference_lost")).toBe(false);
  });
  it("partial_and_wrong_source_outcomes_use_exact_only_metrics", async () => {
    const mixed = candidate("mixed");
    mixed.final_source_inventory = [
      { ...mixed.entry_source_inventory[0], payload: { external_id: "NSCLC_CE_01", statement: "Incomplete paraphrase" } },
      { ...mixed.entry_source_inventory[0], claim_id: "unmatched", payload: { statement: "Zebra astrophysics" } },
    ];
    const result = await run(mixed);
    const score = result.source_evaluations.find(row => row.candidate === "mixed" && row.point === "final" && row.claim_type === "gap")!.evaluation.score;
    expect(score).toEqual({ found: 0, partial: 1, missed: 42, wrong: 1, precision: 0, recall: 0, f1: 0 });
  });
  it("lost_and_introduced_provenance_are_proven_errors", async () => {
    const mixed = candidate("mixed");
    mixed.final_source_inventory![0].original_provenance = [{ source_file_id: "unknown", block_id: "unknown-block", quote: "Unretained support" }];
    const result = await run(mixed);
    for (const kind of ["provenance_lost", "unsupported_evidence", "invalid_reference"]) {
      expect(result.changes).toContainEqual(expect.objectContaining({ kind, dimension: "provenance", proven_error: true }));
    }
  });

  it("copied_uuids_alone_do_not_change_downstream_decisions", async () => {
    const result = await run();
    expect(result.changes.filter(row => row.kind === "status_changed" || row.kind === "coverage_changed" || row.message.includes("decisions differ"))).toEqual([]);
  });

  it("matched_completed_candidates_report_supported_reference_gain", async () => {
    const mixed = candidate("mixed");
    const baseline = candidate("baseline");
    mixed.status = "completed";
    baseline.status = "completed";
    baseline.final_source_inventory = baseline.entry_source_inventory.filter(row => row.claim_type === "tactic");
    baseline.final_outputs!.inventory = structuredClone(baseline.final_source_inventory);
    baseline.final_outputs!.statuses = [];
    const result = await run(mixed, baseline);
    expect(result.changes.some(row => row.kind === "reference_recovered" && row.message.includes("Matched final comparison") && !row.proven_error)).toBe(true);
    expect(result.applicability.find(row => row.dimension === "source_gaps")?.status).toBe("scored");
  });
  it("merged_source_versions_preserve_supported_lineage", async () => {
    const mixed = candidate("mixed");
    const extra = { ...structuredClone(mixed.entry_source_inventory[0]), claim_id: "extra-gap", original_item_version_ids: ["extra-version"] };
    mixed.entry_source_inventory.push(extra);
    mixed.final_source_inventory![0].original_item_version_ids.push("extra-version");
    mixed.lineage.push({ kind: "merged", original_item_version_ids: ["gap-version", "extra-version"], predecessor_claim_ids: ["mixed-gap", "extra-gap"], successor_claim_ids: ["mixed-gap"], stage: "inventory_validate", run_id: "merge-run", rationale: "Retained original support" });
    mixed.stages.push({ stage: "inventory_validate", status: "completed", run_ids: ["merge-run"], calls: [], module_id: "validator", module_version: "v1", prompt_version: null, model: null, configuration_fingerprint: "configuration", usage: { latency_ms: null, input_tokens: null, output_tokens: null, estimated_cost: null }, output: { claim_ids: ["mixed-gap", "mixed-tactic"], findings: [] } });
    const config = { stage: "inventory_validate" as const, module_id: "validator", module_version: "v1", prompt_version: null, model: null, parameters: {} };
    mixed.setup!.configuration.modules.push(config);
    const baseline = candidate("baseline");
    baseline.setup!.configuration.modules.push(config);
    mixed.final_outputs!.inventory = structuredClone(mixed.final_source_inventory!);
    const result = await run(mixed, baseline);
    expect(result.changes).toContainEqual(expect.objectContaining({ kind: "source_merged", item_ids: ["extra-version", "gap-version"], proven_error: false }));
    expect(result.changes.filter(row => row.kind === "invalid_reference" || row.kind === "provenance_lost")).toEqual([]);
    expect(result.changes.some(row => row.message.includes('"input_tokens":null'))).toBe(true);
  });
  it("invalid_coverage_and_residual_references_are_proven_failures", async () => {
    const mixed = candidate("mixed");
    mixed.final_outputs!.coverage.push({ id: "coverage", gap_id: "missing-gap", tactic_id: "mixed-tactic", overall: "full", quote_block_ids: ["missing-block"], confidence: 1, rationale: "Unsupported", validated: true });
    mixed.final_outputs!.residuals.push({ parent_gap_id: "mixed-gap", addressed_gap_id: "branch", open_residual_gap_id: "branch" });
    const result = await run(mixed);
    for (const dimension of ["coverage", "residual"]) expect(result.changes).toContainEqual(expect.objectContaining({ dimension, kind: "invariant_failure", proven_error: true }));
  });

  it.each([
    { scenario: "unknown addressed identity", addressed: "missing-gap", parent: "mixed-gap", recordedRun: "split-run", completed: true, invalid: true },
    { scenario: "different existing addressed identity", addressed: "other-gap", parent: "mixed-gap", recordedRun: "split-run", completed: true, invalid: true },
    { scenario: "crossed-parent residual lineage", addressed: "mixed-gap", parent: "other-gap", recordedRun: "split-run", completed: true, invalid: true },
    { scenario: "unrecorded split run", addressed: "mixed-gap", parent: "mixed-gap", recordedRun: "other-run", completed: true, invalid: true },
    { scenario: "incomplete split run", addressed: "mixed-gap", parent: "mixed-gap", recordedRun: "split-run", completed: false, invalid: true },
    { scenario: "legacy parent reused as addressed branch", addressed: "mixed-gap", parent: "mixed-gap", recordedRun: "split-run", completed: true, invalid: true },
  ])("validates residual contract: $scenario", async ({ addressed, parent, recordedRun, completed, invalid }) => {
    const mixed = candidate("mixed");
    const other = { ...structuredClone(mixed.entry_source_inventory[0]), claim_id: "other-gap", original_item_version_ids: ["other-version"] };
    mixed.entry_source_inventory.push(other);
    mixed.final_source_inventory!.push(structuredClone(other));
    mixed.final_outputs!.inventory = structuredClone(mixed.final_source_inventory!);
    mixed.final_outputs!.statuses.push({ gap_id: "other-gap", status: "open", computed: "open", override: false });
    const residual = { parent_gap_id: "mixed-gap", addressed_gap_id: addressed, open_residual_gap_id: "mixed-gap-R" };
    mixed.final_outputs!.residuals.push(residual);
    mixed.lineage.push({ kind: "residual", copied_claim_id: "mixed-gap-R", parent_claim_ids: [parent], run_id: "split-run", stage: "partial_split", payload: { statement: "Residual need" }, copied_evidence_ids: [] });
    if (completed) mixed.stages.push({ stage: "partial_split", status: "completed", run_ids: [recordedRun], calls: [], module_id: "partial-split.agent-v1", module_version: "v1", prompt_version: null, model: null, configuration_fingerprint: "configuration", usage: { latency_ms: null, input_tokens: null, output_tokens: null, estimated_cost: null }, output: { residuals: [residual] } });
    else mixed.stages.push({ stage: "partial_split", status: "pending" });
    mixed.setup!.configuration.modules.push({ stage: "partial_split", module_id: "partial-split.agent-v1", module_version: "v1", prompt_version: null, model: null, parameters: {} });
    const baseline = candidate("baseline");
    baseline.setup = structuredClone(mixed.setup);
    const result = await run(mixed, baseline);
    expect(result.changes.some(row => row.dimension === "residual" && row.kind === "invariant_failure" && row.proven_error)).toBe(invalid);
  });

});
