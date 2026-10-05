/** Supported source gold and descriptive downstream evidence; never a promotion score. */
import { isDeepStrictEqual } from "node:util";
import { asTacticLifecycle, deriveGapStatus } from "../modules/status-derive/engine";
import { evaluateExperimentVersion, experimentPackFingerprint, EXPERIMENT_EVALUATOR_VERSION } from "./experiment-gold";
import {
  MIXED_GATE_POLICY, MIXED_GATE_POLICY_FINGERPRINT, mixedComparisonEvaluationSchema,
  type MixedCandidateEvidence, type MixedComparisonEvaluation, type MixedSourceInventory,
} from "../experiments/mixed-types";

export const MIXED_DOWNSTREAM_EVALUATOR_VERSION = "mixed-downstream-v1";
type Change = MixedComparisonEvaluation["changes"][number];
type Dimension = Change["dimension"];
type Evaluated = MixedComparisonEvaluation["source_evaluations"][number];
const dimensions: Dimension[] = ["source_gaps", "source_tactics", "provenance", "coverage", "status", "residual", "priority", "ideation", "plan"];
const sourceDimension = (kind: "gap" | "tactic"): Dimension => kind === "gap" ? "source_gaps" : "source_tactics";
const generatedIds = (candidate: MixedCandidateEvidence) => new Set(candidate.lineage.flatMap(row =>
  row.kind === "residual" || row.kind === "ideated" ? [row.copied_claim_id] : []));
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, child) => child && typeof child === "object" && !Array.isArray(child)
    ? Object.fromEntries(Object.entries(child).sort(([a], [b]) => a.localeCompare(b))) : child);
}
const keys = (row: Evaluated | undefined) => new Set(row?.evaluation.outcomes.filter(item => item.outcome === "found").flatMap(item => item.gold_item_key ? [item.gold_item_key] : []));

/** Gold stays in evaluator code. Inventories come from exact entry/final evidence, never snapshots. */
export async function evaluateMixedComparison(args: {
  mixed: MixedCandidateEvidence; baseline: MixedCandidateEvidence; pack_id: string;
}): Promise<MixedComparisonEvaluation> {
  const candidates = [args.mixed, args.baseline];
  const changes: Change[] = [];
  const add = (kind: Change["kind"], dimension: Dimension, message: string, item_ids: string[] = [], proven_error = false, severity: Change["severity"] = proven_error ? "blocking" : "info") => {
    changes.push({ kind, dimension, severity, proven_error, item_ids: [...new Set(item_ids)].sort(), message });
  };
  let fingerprint: string | null = null;
  let packError: string | null = null;
  try { fingerprint = experimentPackFingerprint(args.pack_id); }
  catch (error) { packError = error instanceof Error ? error.message : "Reference pack unavailable"; }
  const mismatch: string[] = [];
  const first = args.mixed.setup;
  for (const candidate of candidates) {
    if (!candidate.setup || !candidate.copy || !candidate.original_assembly) {
      mismatch.push(`${candidate.label}: missing setup, copy or original assembly identity`);
      continue;
    }
    const setup = candidate.setup;
    if (canonical(setup) !== canonical(first)) mismatch.push(`${candidate.label}: source/baseline/gold/evaluator/configuration/policy/code identities differ`);
    if (setup.pack_fingerprint !== fingerprint || setup.evaluator_version !== EXPERIMENT_EVALUATOR_VERSION ||
      setup.downstream_evaluator_version !== MIXED_DOWNSTREAM_EVALUATOR_VERSION || setup.gate_policy !== MIXED_GATE_POLICY ||
      setup.gate_policy_fingerprint !== MIXED_GATE_POLICY_FINGERPRINT) mismatch.push(`${candidate.label}: unsupported evaluator/policy or loaded gold fingerprint mismatch`);
    if (candidate.original_assembly.workspace_id !== args.mixed.original_assembly?.workspace_id ||
      canonical([...candidate.original_assembly.source_file_ids].sort()) !== canonical(setup.source_files.map(row => row.id).sort())) mismatch.push(`${candidate.label}: original source scope mismatch`);
    for (const stage of candidate.stages) if (stage.status === "completed") {
      const configuredModule = setup.configuration.modules.find(row => row.stage === stage.stage);
      if (!configuredModule || configuredModule.module_id !== stage.module_id || configuredModule.module_version !== stage.module_version ||
        configuredModule.prompt_version !== stage.prompt_version || configuredModule.model !== stage.model || stage.configuration_fingerprint !== setup.configuration.fingerprint) {
        mismatch.push(`${candidate.label}: actual ${stage.stage} configuration differs from captured setup`);
      }
    }
    if (candidate.gates.some(gate => gate.policy !== setup.gate_policy || gate.policy_fingerprint !== setup.gate_policy_fingerprint)) mismatch.push(`${candidate.label}: actual gate policy mismatch`);
  }
  if (args.mixed.label !== "mixed" || args.baseline.label !== "baseline") mismatch.push("Candidate labels do not match their comparison slots");
  if (args.mixed.copied_workspace_id && args.mixed.copied_workspace_id === args.baseline.copied_workspace_id) mismatch.push("Candidates share a copied workspace");
  if (args.mixed.attempt_id && args.mixed.attempt_id === args.baseline.attempt_id) mismatch.push("Candidates share an attempt");
  if (packError) mismatch.push(packError);

  const source_evaluations: Evaluated[] = [];
  for (const candidate of candidates) {
    for (const point of ["entry", "final"] as const) {
      const inventory = point === "entry" ? candidate.entry_source_inventory : candidate.final_source_inventory;
      // A missing final is unavailable evidence, never an empty scored extraction.
      for (const claim_type of ["gap", "tactic"] as const) {
        const call_kind: "need_extract" | "inventory_extract" = claim_type === "gap" ? "need_extract" : "inventory_extract";
        const generated = generatedIds(candidate);
        const items = inventory?.filter(row => row.claim_type === claim_type && !generated.has(row.claim_id));
        const error = inventory === null ? `${candidate.label}: final source inventory unavailable (${candidate.status})` : packError;
        const evaluation = error || fingerprint === null ? {
          evaluator_version: EXPERIMENT_EVALUATOR_VERSION, pack_id: args.pack_id, pack_fingerprint: fingerprint ?? "unavailable",
          call_kind, status: "model_error" as const, output_shape: { valid: false }, outcomes: [], errors: [error ?? "Reference pack unavailable"],
        } : { ...evaluateExperimentVersion({ pack_id: args.pack_id, call_kind, output: { [claim_type === "gap" ? "gaps" : "tactics"]: items!.map(item => item.payload) } }), call_kind };
        source_evaluations.push({ candidate: candidate.label, point, claim_type, evaluation });
      }
    }
  }
  if (fingerprint !== null) {
    try {
      if (experimentPackFingerprint(args.pack_id) !== fingerprint || source_evaluations.some(row => row.evaluation.pack_fingerprint !== fingerprint)) mismatch.push("Gold pack changed during evaluation");
    } catch { mismatch.push("Gold pack became unavailable during evaluation"); }
  }
  for (const reason of [...new Set(mismatch)]) add("output_changed", "source_gaps", `Matched gain unavailable: ${reason}`, [], false, "advisory");
  const evaluationFor = (candidate: MixedCandidateEvidence, point: "entry" | "final", kind: "gap" | "tactic") =>
    source_evaluations.find(row => row.candidate === candidate.label && row.point === point && row.claim_type === kind);
  const cleanInventory = (candidate: MixedCandidateEvidence, inventory: MixedSourceInventory) => {
    const generated = generatedIds(candidate);
    return inventory.filter(row => !generated.has(row.claim_id));
  };
  for (const candidate of candidates) {
    if (candidate.primary_error) add("output_changed", "plan", `${candidate.label} ${candidate.status}: ${candidate.primary_error.code}: ${candidate.primary_error.message}`, [], false, "advisory");
    for (const gate of candidate.gates) for (const finding of gate.findings) add(finding.severity === "blocking" ? "invariant_failure" : "output_changed", gate.object_type === "claim" ? "provenance" : gate.object_type === "proposal" ? "ideation" : gate.object_type,
      `${candidate.label} gate ${finding.code}: ${finding.message}`, finding.object_ids, finding.severity === "blocking", finding.severity);
    for (const stage of candidate.stages) {
      if (stage.status === "completed") {
        const usage = stage.usage;
        add("output_changed", "plan", `${candidate.label} ${stage.stage} telemetry: ${canonical(usage)} (null means unavailable)`);
        if (stage.stage === "inventory_validate") for (const finding of stage.output.findings) add(finding.severity === "blocking" ? "invariant_failure" : "output_changed", "provenance", `${candidate.label} ${finding.code}: ${finding.message}`, finding.object_ids, finding.severity === "blocking", finding.severity);
      } else if (stage.status === "blocked" || stage.status === "failed") add("output_changed", "plan", `${candidate.label} ${stage.stage} ${stage.status}: ${stage.primary_error.message}; telemetry unavailable`, [], false, "advisory");
    }
    if (!candidate.stages.some(row => row.status === "completed")) add("output_changed", "plan", `${candidate.label}: stage telemetry unavailable`, [], false, "advisory");
    if (candidate.final_source_inventory === null) {
      add("output_changed", "source_gaps", `${candidate.label}: final source inventory unavailable; supported losses and retention cannot be determined`, [], false, "advisory");
      continue;
    }
    const final = cleanInventory(candidate, candidate.final_source_inventory);
    for (const kind of ["gap", "tactic"] as const) {
      const entryEval = evaluationFor(candidate, "entry", kind);
      const finalEval = evaluationFor(candidate, "final", kind);
      if (entryEval?.evaluation.status !== "scored" || finalEval?.evaluation.status !== "scored") continue;
      const before = keys(entryEval); const after = keys(finalEval);
      for (const key of after) if (!before.has(key)) add("reference_recovered", sourceDimension(kind), `${candidate.label} entry to final: exact reference recovered`, [key]);
      for (const key of before) if (!after.has(key)) add("reference_lost", sourceDimension(kind), `${candidate.label} entry to final: exact reference lost`, [key], true);
      const entryItems = cleanInventory(candidate, candidate.entry_source_inventory).filter(row => row.claim_type === kind);
      const finalItems = final.filter(row => row.claim_type === kind);
      for (const outcome of entryEval.evaluation.outcomes) {
        if (outcome.outcome !== "found" || outcome.model_item_index === undefined) continue;
        const original = entryItems[outcome.model_item_index];
        const retained = finalEval.evaluation.outcomes.some(row => row.outcome === "found" && row.gold_item_key === outcome.gold_item_key && row.model_item_index !== undefined && finalItems[row.model_item_index]?.original_item_version_ids.some(id => original.original_item_version_ids.includes(id)));
        add(retained ? "correct_retained" : "correct_removed", sourceDimension(kind), `${candidate.label}: originally correct source item ${retained ? "retained" : "removed or no longer exact"}`, original.original_item_version_ids, !retained);
      }
    }
    inspectSource(candidate, final, add);
    inspectOutputs(candidate, add);
  }
  const matched = mismatch.length === 0 && candidates.every(candidate => candidate.status === "completed" && candidate.final_source_inventory !== null);
  if (matched) for (const kind of ["gap", "tactic"] as const) {
    const mixed = evaluationFor(args.mixed, "final", kind); const baseline = evaluationFor(args.baseline, "final", kind);
    if (mixed?.evaluation.status !== "scored" || baseline?.evaluation.status !== "scored") continue;
    const left = keys(mixed); const right = keys(baseline);
    for (const key of left) if (!right.has(key)) add("reference_recovered", sourceDimension(kind), "Matched final comparison: mixed recovered an exact baseline-missed reference; one observed supported gain", [key]);
    for (const key of right) if (!left.has(key)) add("reference_lost", sourceDimension(kind), "Matched final comparison: mixed lost an exact baseline reference", [key], true);
  }
  if (!matched && mismatch.length === 0) add("output_changed", "plan", "Matched gain unavailable: both candidates must complete with final source inventories", [], false, "advisory");
  describeOutputs(args.mixed, args.baseline, add);
  const applicability: MixedComparisonEvaluation["applicability"] = dimensions.map(dimension => {
    if (dimension === "source_gaps" || dimension === "source_tactics") {
      const rows = source_evaluations.filter(row => sourceDimension(row.claim_type) === dimension);
      const reference_keys = [...new Set(rows.flatMap(row => row.evaluation.outcomes.flatMap(item => item.gold_item_key ? [item.gold_item_key] : [])))].sort();
      if (rows.every(row => row.evaluation.status === "scored") && reference_keys.length && !mismatch.length) return { dimension, status: "scored", reference_keys };
      return { dimension, status: "unscored", reason: "Source gold comparison unavailable: missing/invalid inventory, gold or mismatched setup; retained per-inventory evaluations remain explicit" };
    }
    return { dimension, status: "unscored", reason: dimension === "provenance" ? "No curated provenance accuracy labels; deterministic original-source evidence checks only" : `No curated ${dimension} labels; changes are descriptive and deterministic invariant failures are reported separately` };
  });
  return mixedComparisonEvaluationSchema.parse({ evaluator_version: MIXED_DOWNSTREAM_EVALUATOR_VERSION, source_evaluations, applicability, changes });
}

type Add = (kind: Change["kind"], dimension: Dimension, message: string, ids?: string[], proven?: boolean, severity?: Change["severity"]) => void;
function inspectSource(candidate: MixedCandidateEvidence, final: MixedSourceInventory, add: Add) {
  const entry = candidate.entry_source_inventory;
  const versions = new Set(entry.flatMap(row => row.original_item_version_ids));
  for (const item of entry) if (!final.some(row => row.original_item_version_ids.some(id => item.original_item_version_ids.includes(id)))) add("source_dropped", sourceDimension(item.claim_type), `${candidate.label}: selected source lineage dropped`, item.original_item_version_ids);
  for (const item of final) {
    const predecessors = entry.filter(row => row.original_item_version_ids.some(id => item.original_item_version_ids.includes(id)));
    if (item.original_item_version_ids.some(id => !versions.has(id))) add("invalid_reference", "provenance", `${candidate.label}: unknown original version reference`, [item.claim_id], true);
    const before = predecessors.flatMap(row => row.original_provenance);
    for (const span of before) if (!item.original_provenance.some(row => isDeepStrictEqual(row, span))) add("provenance_lost", "provenance", `${candidate.label}: original support removed`, [item.claim_id, span.block_id], true);
    for (const span of item.original_provenance) {
      if (!before.some(row => isDeepStrictEqual(row, span))) add("unsupported_evidence", "provenance", `${candidate.label}: evidence introduced without retained original selected support`, [item.claim_id, span.block_id], true);
      if (!candidate.setup?.parse_blocks.some(block => block.id === span.block_id && block.source_file_id === span.source_file_id) || !candidate.setup.source_files.some(source => source.id === span.source_file_id)) add("invalid_reference", "provenance", `${candidate.label}: original evidence source/block reference is invalid`, [item.claim_id, span.block_id], true);
    }
    if (predecessors.length > 1) add("source_merged", sourceDimension(item.claim_type), `${candidate.label}: source versions merged`, item.original_item_version_ids);
    const unchanged = predecessors.length === 1 && isDeepStrictEqual(item, predecessors[0]);
    if (!unchanged) {
      add("source_changed", sourceDimension(item.claim_type), `${candidate.label}: source item transformed`, [item.claim_id, ...item.original_item_version_ids]);
      const lineage = candidate.lineage.find(row => (row.kind === "transformed" || row.kind === "merged") && row.successor_claim_ids.includes(item.claim_id) &&
        canonical([...row.original_item_version_ids].sort()) === canonical([...item.original_item_version_ids].sort()) &&
        row.predecessor_claim_ids.every(id => predecessors.some(entry => entry.claim_id === id)) &&
        candidate.stages.some(stage => stage.stage === row.stage && stage.status === "completed" && stage.run_ids.includes(row.run_id)));
      if (!lineage) add("invalid_reference", "provenance", `${candidate.label}: changed source item lacks completed-run transformation lineage`, [item.claim_id], true);
    }
  }
  for (const row of candidate.lineage) if (row.kind === "dropped") add("source_dropped", "provenance", `${candidate.label}: explicit dropped source lineage (${row.rationale})`, row.original_item_version_ids);
}

/** Check final evidence against its own retained inputs and stage outputs. */
function inspectOutputs(candidate: MixedCandidateEvidence, add: Add) {
  const output = candidate.final_outputs;
  if (!output) {
    add("output_changed", "plan", `${candidate.label}: downstream outputs unavailable (${candidate.status})`, [], false, "advisory");
    return;
  }
  const fail = (dimension: Dimension, message: string, ids: string[] = []) =>
    add("invariant_failure", dimension, `${candidate.label}: ${message}`, ids, true);
  const inventory = candidate.final_source_inventory ?? [];
  const gaps = new Set(inventory.filter(item => item.claim_type === "gap").map(item => item.claim_id));
  const tactics = new Set(inventory.filter(item => item.claim_type === "tactic").map(item => item.claim_id));
  const generatedGaps = new Set(candidate.lineage.flatMap(row => row.kind === "residual" ? [row.copied_claim_id] : []));
  const generatedTactics = new Set(candidate.lineage.flatMap(row => row.kind === "ideated" ? [row.copied_claim_id] : []));
  if (candidate.final_source_inventory && !isDeepStrictEqual(output.inventory, inventory)) fail("source_gaps", "retained final inventory differs from source inventory");
  for (const row of output.coverage) {
    if (!gaps.has(row.gap_id) || !tactics.has(row.tactic_id)) fail("coverage", "coverage references an unknown source gap or tactic", [row.id]);
    if (row.quote_block_ids.some(id => !candidate.copy?.block_id_map || !Object.values(candidate.copy.block_id_map).includes(id)))
      fail("coverage", "coverage references a block outside the copied source", [row.id]);
  }
  const coverageIds = new Set(output.coverage.map(row => row.id));
  if (coverageIds.size !== output.coverage.length) fail("coverage", "duplicate coverage identities");
  const tacticLifecycles = inventory.flatMap(item => {
    const status = asTacticLifecycle(item.payload.status);
    return item.claim_type === "tactic" && status ? [{ id: item.claim_id, status }] : [];
  });
  for (const row of output.statuses) {
    if (!gaps.has(row.gap_id) && !generatedGaps.has(row.gap_id)) fail("status", "status references an unknown gap", [row.gap_id]);
    if (!row.override && row.status !== row.computed) fail("status", "status differs from computed status without an override", [row.gap_id]);
    // Missing lifecycle labels prevent recomputation; do not invent a default.
    const applicable = output.coverage.filter(coverage => coverage.gap_id === row.gap_id && coverage.validated && coverage.overall !== "not_relevant");
    if (gaps.has(row.gap_id) && applicable.every(coverage => tacticLifecycles.some(tactic => tactic.id === coverage.tactic_id))) {
      if (row.computed !== deriveGapStatus({ gap_id: row.gap_id, coverages: output.coverage, tactics: tacticLifecycles }))
        fail("status", "computed status disagrees with retained validated coverage and tactic lifecycle", [row.gap_id]);
    } else if (gaps.has(row.gap_id)) add("output_changed", "status", `${candidate.label}: computed status consistency unavailable because tactic lifecycle evidence is missing`, [row.gap_id], false, "advisory");
  }
  for (const gap of gaps) if (!output.statuses.some(row => row.gap_id === gap)) fail("status", "source gap lacks a final status", [gap]);
  for (const row of output.residuals) {
    if (!gaps.has(row.parent_gap_id) || !generatedGaps.has(row.open_residual_gap_id) || row.addressed_gap_id === row.open_residual_gap_id)
      fail("residual", "residual lacks valid parent/generated lineage or has duplicate branch identities", [row.parent_gap_id, row.open_residual_gap_id]);
  }
  for (const row of output.priorities) if (!gaps.has(row.gap_id) && !generatedGaps.has(row.gap_id)) fail("priority", "priority references an unknown gap", [row.gap_id]);
  for (const row of output.proposals) if (!gaps.has(row.gap_id) && !generatedGaps.has(row.gap_id))
    fail("ideation", "proposal references an unknown gap", [row.gap_id]);
  const activities = output.plan.activities;
  if (candidate.copied_workspace_id && output.plan.workspace_id !== candidate.copied_workspace_id) fail("plan", "plan workspace differs from copied workspace");
  const activityIds = new Set(activities.map(row => row.id));
  if (activityIds.size !== activities.length) fail("plan", "duplicate Gantt activity identities");
  for (const row of activities) {
    if (!tactics.has(row.tactic_id) && !generatedTactics.has(row.tactic_id)) fail("plan", "Gantt activity references an unknown tactic", [row.id]);
    if (row.gap_ids.some(id => !gaps.has(id) && !generatedGaps.has(id))) fail("plan", "Gantt activity references an unknown gap", [row.id]);
    if (row.depends_on.some(id => !activityIds.has(id) || id === row.id)) fail("plan", "Gantt dependency is missing or self-referential", [row.id]);
    if (row.start > row.end) fail("plan", "Gantt activity ends before it starts", [row.id]);
  }
  const byId = new Map(activities.map(row => [row.id, row]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const cyclic = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    const found = byId.get(id)?.depends_on.some(dependency => byId.has(dependency) && cyclic(dependency)) ?? false;
    visiting.delete(id);
    visited.add(id);
    return found;
  };
  if (activities.some(row => cyclic(row.id))) fail("plan", "Gantt dependency graph contains a cycle");
}

/** Report decisions as descriptive changes unless a deterministic invariant proves an error. */
function describeOutputs(mixed: MixedCandidateEvidence, baseline: MixedCandidateEvidence, add: Add) {
  const left = mixed.final_outputs;
  const right = baseline.final_outputs;
  if (!left || !right) {
    add("output_changed", "plan", "Final downstream decision comparison unavailable: one candidate has no final outputs", [], false, "advisory");
    return;
  }
  const dimensions = [
    ["coverage", "coverage", "coverage_changed"], ["status", "statuses", "status_changed"],
    ["residual", "residuals", "output_changed"], ["priority", "priorities", "output_changed"],
    ["ideation", "proposals", "output_changed"], ["plan", "plan", "output_changed"],
  ] as const;
  for (const [dimension, field, kind] of dimensions) {
    if (canonical(decisionIdentity(mixed, left[field])) !== canonical(decisionIdentity(baseline, right[field]))) add(kind, dimension, `Mixed and baseline ${dimension} decisions differ; no curated accuracy labels`, [], false);
  }
}

/** Compare semantic decisions using original lineage rather than isolated copy UUIDs. */
function decisionIdentity(candidate: MixedCandidateEvidence, value: unknown): unknown {
  const identities = new Map<string, string>();
  for (const item of candidate.final_source_inventory ?? []) identities.set(item.claim_id, canonical([...item.original_item_version_ids].sort()));
  for (const [original, copied] of Object.entries(candidate.copy?.block_id_map ?? {})) identities.set(copied, original);
  if (candidate.copied_workspace_id) identities.set(candidate.copied_workspace_id, "candidate-workspace");
  for (const row of candidate.lineage) if (row.kind === "residual" || row.kind === "ideated") {
    identities.set(row.copied_claim_id, canonical({ kind: row.kind, parents: row.parent_claim_ids.map(id => identities.get(id) ?? id).sort(), payload: row.payload }));
  }
  for (const activity of candidate.final_outputs?.plan.activities ?? []) identities.set(activity.id, canonical({
    tactic: identities.get(activity.tactic_id) ?? activity.tactic_id, start: activity.start, end: activity.end, readout: activity.readout,
  }));
  const visit = (item: unknown, key = ""): unknown => {
    if (Array.isArray(item)) return item.map(child => visit(child, key)).sort((a, b) => canonical(a).localeCompare(canonical(b)));
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).flatMap(([field, child]) => {
      // Coverage IDs name persisted decisions, not the decision content.
      if (field === "id" && "overall" in item) return [];
      return [[field, visit(child, field)]];
    }));
    return typeof item === "string" && (key === "id" || key.endsWith("_id") || key.endsWith("_ids") || key === "depends_on")
      ? identities.get(item) ?? item : item;
  };
  return visit(value);
}
