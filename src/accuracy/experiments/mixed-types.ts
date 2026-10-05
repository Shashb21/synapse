/** Durable contracts for exact, isolated mixed-versus-baseline replay. */
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Actor } from "@/accuracy/kernel/contracts";
import { ACTOR_FUNCTIONS } from "@/lib/iegp/enums";
import { coverageDecisionSchema, coverageCriticOutputSchema } from "@/accuracy/modules/coverage-decide/schema";
import { priorityPlacementSchema, splitChildSchema } from "@/accuracy/modules/partial-split/schema";
import { asTacticLifecycle, deriveGapStatus } from "@/accuracy/modules/status-derive/engine";
import { DEFAULT_AXES, bandFor, weightedScore } from "@/modules/stages/s8-prioritization/axes";
import { PRIORITY_SCORING_IDENTITY } from "@/accuracy/modules/partial-split/schema";
import type { ExperimentRecord } from "./records";
import type * as tables from "../store/schema";

export const MIXED_GATE_POLICY = "deterministic_checks_pass_no_edits_v1" as const;
export const MIXED_GATE_POLICY_FINGERPRINT = createHash("sha256").update(MIXED_GATE_POLICY).digest("hex");
const id = z.string().trim().min(1);
const nomination = z.object({ assembly_id: id, fingerprint: id }).strict();
const actorSchema = z.object({ name: id, function: z.enum(ACTOR_FUNCTIONS) }).strict();
export const mixedComparisonInputSchema = z.object({
  source_workspace_id: id, source_file_ids: z.array(id).min(1).refine(ids => new Set(ids).size === ids.length, "Source IDs must be distinct"),
  pack_id: id, mixed: nomination, baseline: nomination,
}).strict();
/** Server-only request; actor must be supplied from the authenticated session. */
export type MixedComparisonRequest = z.infer<typeof mixedComparisonInputSchema> & { actor: Actor };
export const mixedComparisonRequestSchema = mixedComparisonInputSchema.extend({ actor: actorSchema });

export const mixedPrimaryErrorSchema = z.object({
  phase: z.enum(["setup", "pipeline", "evaluation", "persistence"]), code: id, message: id,
  stage: id.nullable(), call_id: id.nullable(),
}).strict();
export type MixedPrimaryError = z.infer<typeof mixedPrimaryErrorSchema>;

type MixedJson = z.infer<ReturnType<typeof z.json>>;
const jsonObject = z.record(z.string(), z.json());
const distinctIds = z.array(id).refine(ids => new Set(ids).size === ids.length, "IDs must be distinct");
export const MIXED_PIPELINE_STAGES = ["inventory_validate", "pair_generate", "coverage_decide", "coverage_critic", "validation_gate", "partial_split", "status_derive", "prioritize", "ideate", "gantt_project"] as const;
const stageName = z.enum(MIXED_PIPELINE_STAGES);
const label = z.enum(["mixed", "baseline"]);
const finding = z.object({ code: id, severity: z.enum(["blocking", "advisory"]), message: id, object_ids: distinctIds }).strict();
const provenance = z.object({ source_file_id: id, block_id: id, quote: z.string() }).strict();

/** The original immutable assembly, including exact unmodified model payloads. */
export const mixedOriginalAssemblySchema = z.object({
  id, workspace_id: id, created_at: id, actor: actorSchema, fingerprint: id, source_file_ids: distinctIds.min(1),
  items: z.array(z.object({ id, claim_id: id, run_id: id, human_origin: z.null().optional(), snapshot_id: id.nullable(), iteration: z.number().int().nonnegative().nullable(),
    item_index: z.number().int().nonnegative(), payload: jsonObject, source_file_id: id, created_at: id,
    claim_type: z.enum(["gap", "tactic"]), canonical_claim_id: id, reason: id }).strict()).min(1),
  mappings: z.array(z.object({ gap_version_id: id, tactic_version_id: id }).strict()),
  coverage: z.array(z.object({ gap_version_id: id, tactic_version_id: id, run_id: id, input: jsonObject, output: z.json(), mode: z.enum(["llm", "stub"]) }).strict()),
  extraction_runs: z.array(z.object({ call_kind: z.enum(["need_extract", "inventory_extract"]), run_id: id, source_file_id: id,
    item_count: z.number().int().nonnegative(), outcome: z.enum(["items", "empty"]), evaluation_context: z.enum(["production", "experiment"]).optional() }).strict()).nullable(),
  linking_complete: z.boolean(), generation_key: id.nullable().optional(),
  output: z.object({ gaps: z.array(jsonObject), tactics: z.array(jsonObject) }).strict(),
  checks: z.object({ checker_version: id, status: z.enum(["passed", "blocked"]), findings: z.array(z.object({
    code: id, severity: z.enum(["blocking", "advisory"]), item_version_ids: distinctIds, message: id }).strict()) }).strict(),
}).strict();
export type MixedOriginalAssembly = z.infer<typeof mixedOriginalAssemblySchema>;

export const mixedSetupIdentitySchema = z.object({
  source_fingerprint: id, baseline_fingerprint: id, original_baseline_snapshot: jsonObject,
  pack_fingerprint: id, evaluator_version: id, downstream_evaluator_version: id,
  gate_policy: z.literal(MIXED_GATE_POLICY), gate_policy_fingerprint: z.literal(MIXED_GATE_POLICY_FINGERPRINT), code_identity: id,
  configuration: z.object({ fingerprint: id, modules: z.array(z.object({ stage: stageName, module_id: id, module_version: id,
    prompt_version: id.nullable(), model: id.nullable(), parameters: jsonObject }).strict()) }).strict(),
  source_files: z.array(z.object({ id, checksum: id, content_fingerprint: id }).strict()),
  parse_blocks: z.array(z.object({ id, source_file_id: id, content_fingerprint: id }).strict()),
}).strict();
export type MixedSetupIdentity = z.infer<typeof mixedSetupIdentitySchema>;

export const mixedCopyIdentitySchema = z.object({
  source_id_map: z.record(id, id), block_id_map: z.record(id, id), claim_id_map: z.record(id, id), provenance_id_map: z.record(id, id),
  original_content_fingerprint: id, remapped_content_fingerprint: id,
}).strict();
export type MixedCopyIdentity = z.infer<typeof mixedCopyIdentitySchema>;

export const mixedLineageSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("selected"), original_item_version_id: id, original_claim_id: id, original_run_id: id, original_snapshot_id: id.nullable(),
    original_iteration: z.number().int().nonnegative().nullable(), original_item_index: z.number().int().nonnegative(), selection_reason: id,
    copied_claim_id: id, copied_evidence_ids: distinctIds, original_payload: jsonObject, copied_payload: jsonObject }).strict(),
  z.object({ kind: z.enum(["residual", "ideated"]), copied_claim_id: id, parent_claim_ids: distinctIds.min(1), run_id: id,
    stage: z.enum(["partial_split", "ideate"]), payload: jsonObject, copied_evidence_ids: distinctIds }).strict(),
  z.object({ kind: z.enum(["transformed", "merged", "dropped"]), original_item_version_ids: distinctIds.min(1),
    predecessor_claim_ids: distinctIds.min(1), successor_claim_ids: distinctIds, stage: stageName, run_id: id, rationale: id }).strict(),
]);
export type MixedItemLineage = z.infer<typeof mixedLineageSchema>;

export const mixedGateDecisionSchema = z.object({
  id, policy: z.literal(MIXED_GATE_POLICY), policy_fingerprint: z.literal(MIXED_GATE_POLICY_FINGERPRINT),
  object_type: z.enum(["claim", "coverage", "residual", "priority", "proposal", "plan"]), object_ids: distinctIds.min(1),
  content_fingerprint: id, check_fingerprint: id, checker_version: id, decision: z.enum(["pass", "block"]),
  rationale: id, automatic: z.literal(true), findings: z.array(finding),
}).strict().superRefine((gate, ctx) => {
  if (gate.decision === "pass" && gate.findings.some(row => row.severity === "blocking")) {
    ctx.addIssue({ code: "custom", message: "A blocking deterministic finding cannot pass the no-edit gate" });
  }
});
export type MixedGateDecision = z.infer<typeof mixedGateDecisionSchema>;

export const mixedSourceInventorySchema = z.array(z.object({ claim_id: id, claim_type: z.enum(["gap", "tactic"]), payload: jsonObject,
  original_item_version_ids: distinctIds.min(1), original_provenance: z.array(provenance).min(1) }).strict());
export type MixedSourceInventory = z.infer<typeof mixedSourceInventorySchema>;
const statusRow = z.object({ gap_id: id, status: z.enum(["open", "partial", "addressed"]), computed: z.enum(["open", "partial", "addressed"]), override: z.boolean() }).strict();
const priority = priorityPlacementSchema;
const residual = z.object({ parent_gap_id: id, addressed_gap_id: id, open_residual_gap_id: id }).strict();
const proposal = z.object({ gap_id: id, name: id, type: id, origin: z.literal("ideated"), status: z.literal("proposed"), design_summary: id, not_from_reference: z.literal(true) }).strict();
export const mixedPlanProjectionSchema = z.object({ workspace_id: id, activities: z.array(z.object({
  id, tactic_id: id, start: id, end: id, readout: z.string().nullable(), depends_on: distinctIds, gap_ids: distinctIds,
}).strict()) }).strict();
const retainedCoverage = coverageDecisionSchema.extend({ id, validated: z.boolean() }).strict();
export const mixedFinalOutputsSchema = z.object({
  inventory: mixedSourceInventorySchema, coverage: z.array(retainedCoverage), statuses: z.array(statusRow), priorities: z.array(priority),
  residuals: z.array(residual), proposals: z.array(proposal), plan: mixedPlanProjectionSchema,
}).strict();
export type MixedFinalOutputs = z.infer<typeof mixedFinalOutputsSchema>;

const stageMetadata = {
  run_ids: distinctIds, calls: z.array(z.object({ call_id: id, version_index: z.number().int().nonnegative() }).strict()),
  module_id: id, module_version: id, prompt_version: id.nullable(), model: id.nullable(), configuration_fingerprint: id,
  usage: z.object({ latency_ms: z.number().nonnegative().nullable(), input_tokens: z.number().int().nonnegative().nullable(),
    output_tokens: z.number().int().nonnegative().nullable(), estimated_cost: z.number().nonnegative().nullable() }).strict(),
};
const completedStage = z.discriminatedUnion("stage", [
  z.object({ stage: z.literal("inventory_validate"), status: z.literal("completed"), ...stageMetadata, output: z.object({ claim_ids: distinctIds, findings: z.array(finding) }).strict() }).strict(),
  z.object({ stage: z.literal("pair_generate"), status: z.literal("completed"), ...stageMetadata, output: z.object({ pairs: z.array(z.object({ gap_id: id, tactic_id: id }).strict()) }).strict() }).strict(),
  z.object({ stage: z.literal("coverage_decide"), status: z.literal("completed"), ...stageMetadata, output: z.object({ decisions: z.array(retainedCoverage) }).strict() }).strict(),
  z.object({ stage: z.literal("coverage_critic"), status: z.literal("completed"), ...stageMetadata, output: z.object({ reviews: z.array(z.object({ coverage_id: id, output: coverageCriticOutputSchema.strict() }).strict()) }).strict() }).strict(),
  z.object({ stage: z.literal("validation_gate"), status: z.literal("completed"), ...stageMetadata, output: z.object({ decisions: z.array(mixedGateDecisionSchema) }).strict() }).strict(),
  z.object({ stage: z.literal("partial_split"), status: z.literal("completed"), ...stageMetadata, output: z.object({ residuals: z.array(residual) }).strict() }).strict(),
  z.object({ stage: z.literal("status_derive"), status: z.literal("completed"), ...stageMetadata, output: z.object({ statuses: z.array(statusRow), open: z.number().int().nonnegative(), partial: z.number().int().nonnegative(), addressed: z.number().int().nonnegative() }).strict() }).strict(),
  z.object({ stage: z.literal("prioritize"), status: z.literal("completed"), ...stageMetadata, output: z.object({ placements: z.array(priority) }).strict() }).strict(),
  z.object({ stage: z.literal("ideate"), status: z.literal("completed"), ...stageMetadata, output: z.object({ mode: z.enum(["llm", "stub"]), eligible_gap_ids: distinctIds, proposals: z.array(proposal) }).strict() }).strict(),
  z.object({ stage: z.literal("gantt_project"), status: z.literal("completed"), ...stageMetadata, output: mixedPlanProjectionSchema }).strict(),
]);
export const mixedStageEvidenceSchema = z.union([
  completedStage,
  z.object({ stage: stageName, status: z.literal("pending") }).strict(),
  z.object({ stage: stageName, status: z.literal("skipped"), applicable: z.literal(false), input_count: z.literal(0), reason: id }).strict(),
  z.object({ stage: stageName, status: z.enum(["blocked", "failed"]), primary_error: mixedPrimaryErrorSchema,
    run_ids: distinctIds, calls: stageMetadata.calls }).strict(),
]);
export type MixedStageEvidence = z.infer<typeof mixedStageEvidenceSchema>;

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonicalJson(child)]));
  return value;
}

/** Only copied identity fields change; every other selected payload byte is retained. */
function remappedPayload(value: MixedJson, copy: MixedCopyIdentity): MixedJson {
  if (Array.isArray(value)) return value.map(child => remappedPayload(child, copy));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => {
    if ((key === "source_file_id" || key === "block_id") && typeof child === "string") {
      return [key, (key === "source_file_id" ? copy.source_id_map : copy.block_id_map)[child] ?? null];
    }
    return [key, remappedPayload(child, copy)];
  }));
  return value;
}

const candidateFields = {
  label, attempt_id: id.nullable(), copied_workspace_id: id.nullable(), original_assembly: mixedOriginalAssemblySchema.nullable(),
  copy: mixedCopyIdentitySchema.nullable(), setup: mixedSetupIdentitySchema.nullable(), lineage: z.array(mixedLineageSchema),
  gates: z.array(mixedGateDecisionSchema), stages: z.array(mixedStageEvidenceSchema), entry_source_inventory: mixedSourceInventorySchema,
  final_source_inventory: mixedSourceInventorySchema.nullable(), final_outputs: mixedFinalOutputsSchema.nullable(),
};
export const mixedCompletedCandidateSchema = z.object({ ...candidateFields, status: z.literal("completed"),
  attempt_id: id, copied_workspace_id: id, original_assembly: mixedOriginalAssemblySchema, copy: mixedCopyIdentitySchema,
  setup: mixedSetupIdentitySchema, final_source_inventory: mixedSourceInventorySchema, final_outputs: mixedFinalOutputsSchema, primary_error: z.null(),
}).strict().superRefine((candidate, ctx) => {
  for (const stage of MIXED_PIPELINE_STAGES) {
    const entries = candidate.stages.filter(row => row.stage === stage);
    if (entries.length !== 1 || !["completed", "skipped"].includes(entries[0].status)) {
      ctx.addIssue({ code: "custom", message: `Completed candidate requires one successful ${stage} stage` });
    }
  }
  for (const stage of ["inventory_validate", "pair_generate", "validation_gate", "status_derive", "gantt_project"]) {
    if (!candidate.stages.some(row => row.stage === stage && row.status === "completed")) {
      ctx.addIssue({ code: "custom", message: `${stage} cannot be skipped for a completed candidate` });
    }
  }
  const issue = (message: string) => ctx.addIssue({ code: "custom", message });
  const same = (a: unknown, b: unknown) => JSON.stringify(canonicalJson(a)) === JSON.stringify(canonicalJson(b));
  const final = candidate.final_outputs;
  const originals = candidate.original_assembly.items;
  const selected = candidate.lineage.filter(row => row.kind === "selected");
  if (selected.length !== originals.length || new Set(selected.map(row => row.original_item_version_id)).size !== originals.length) issue("Every original selected version requires one retained lineage entry");
  for (const original of originals) {
    const lineage = selected.find(row => row.original_item_version_id === original.id);
    const entry = lineage && candidate.entry_source_inventory.find(row => row.claim_id === lineage.copied_claim_id);
    if (!lineage || lineage.original_claim_id !== original.claim_id || lineage.original_run_id !== original.run_id || lineage.original_snapshot_id !== original.snapshot_id ||
      lineage.original_iteration !== original.iteration || lineage.original_item_index !== original.item_index || lineage.selection_reason !== original.reason ||
      !same(lineage.original_payload, original.payload) || !entry || entry.claim_type !== original.claim_type ||
      !same(entry.original_item_version_ids, [original.id]) || !same(entry.payload, lineage.copied_payload)) {
      issue("Entry inventory must preserve exact selected original payload and origin lineage");
    }
    if (lineage) {
      const remapped = remappedPayload(original.payload, candidate.copy) as Record<string, MixedJson>;
      const expected = Object.hasOwn(original.payload, "id") ? { ...remapped, id: lineage.copied_claim_id } : remapped;
      if (!same(lineage.copied_payload, expected)) issue("Copied selected payload must be exact apart from remapped identity fields");
      if (!candidate.gates.some(gate => gate.decision === "pass" && gate.object_type === "claim" && gate.object_ids.includes(lineage.copied_claim_id))) issue("Every selected claim requires a passing automatic no-edit gate");
    }
    if (lineage && candidate.copy.claim_id_map[original.claim_id] !== lineage.copied_claim_id) issue("Selected claim identity must resolve through the copy map");
  }
  if (candidate.entry_source_inventory.length !== originals.length) issue("Entry inventory cannot contain unselected or missing source items");
  for (const [map, expected] of [[candidate.copy.source_id_map, candidate.original_assembly.source_file_ids],
    [candidate.copy.block_id_map, candidate.setup.parse_blocks.map(row => row.id)]] as const) {
    if (!same(Object.keys(map).sort(), [...expected].sort()) || new Set(Object.values(map)).size !== Object.keys(map).length) issue("Copy identities must be complete and injective");
  }
  if (!same(candidate.setup.source_files.map(row => row.id).sort(), [...candidate.original_assembly.source_file_ids].sort()) ||
    candidate.setup.parse_blocks.some(row => !candidate.original_assembly.source_file_ids.includes(row.source_file_id))) issue("Original source and parse-block setup identity is incomplete or crossed");
  const versions = new Set(originals.map(row => row.id));
  for (const inventory of [candidate.entry_source_inventory, candidate.final_source_inventory]) {
    if (new Set(inventory.map(row => row.claim_id)).size !== inventory.length) issue("Source inventory claim identities must be distinct");
    if (inventory.some(row => row.original_item_version_ids.some(version => !versions.has(version)) || row.original_provenance.some(span =>
      !candidate.original_assembly.source_file_ids.includes(span.source_file_id) || !candidate.setup.parse_blocks.some(block => block.id === span.block_id && block.source_file_id === span.source_file_id)))) issue("Source inventory lineage or provenance crosses the original source scope");
  }
  if (!same(candidate.final_source_inventory, final.inventory)) issue("Final source inventory must match the retained final inventory");
  for (const item of candidate.final_source_inventory) {
    const entry = candidate.entry_source_inventory.find(row => row.claim_id === item.claim_id);
    if (entry && same(item, entry)) continue;
    const transformation = candidate.lineage.find(row =>
      (row.kind === "transformed" || row.kind === "merged") && row.successor_claim_ids.includes(item.claim_id) &&
      same([...row.original_item_version_ids].sort(), [...item.original_item_version_ids].sort()) &&
      row.predecessor_claim_ids.every(claim_id => candidate.entry_source_inventory.some(entry => entry.claim_id === claim_id)) &&
      candidate.stages.some(stage => stage.stage === row.stage && stage.status === "completed" && stage.run_ids.includes(row.run_id)));
    if (!transformation) issue("Changed final source inventory requires explicit lineage backed by a completed stage run");
  }
  const generated = candidate.lineage.filter((row): row is Extract<MixedItemLineage, { kind: "residual" | "ideated" }> => row.kind === "residual" || row.kind === "ideated");
  if (new Set(generated.map(row => row.copied_claim_id)).size !== generated.length || generated.some(row => candidate.entry_source_inventory.some(item => item.claim_id === row.copied_claim_id))) issue("Generated identities must be distinct and separate from source inventory");
  const allGaps = new Set([...final.inventory.filter(row => row.claim_type === "gap").map(row => row.claim_id), ...generated.filter(row => row.kind === "residual").map(row => row.copied_claim_id)]);
  const allTactics = new Set([...final.inventory.filter(row => row.claim_type === "tactic").map(row => row.claim_id), ...generated.filter(row => row.kind === "ideated").map(row => row.copied_claim_id)]);
  const lifecycles = [...final.inventory.filter(row => row.claim_type === "tactic").map(row => ({ id: row.claim_id, payload: row.payload })), ...generated.filter(row => row.kind === "ideated").map(row => ({ id: row.copied_claim_id, payload: row.payload }))].flatMap(row => { const status = asTacticLifecycle(row.payload.status); return status ? [{ id: row.id, status }] : []; });
  for (const row of generated) {
    if (!candidate.stages.some(stage => stage.stage === row.stage && stage.status === "completed" && stage.run_ids.includes(row.run_id)) || !row.parent_claim_ids.every(id => allGaps.has(id))) issue("Generated lineage requires valid parents and a completed generation run");
    const gateType = row.kind === "residual" ? "residual" : "proposal";
    if (!candidate.gates.some(gate => gate.object_type === gateType && gate.decision === "pass" && gate.object_ids.includes(row.copied_claim_id))) issue("Generated claims require a passing no-edit generation gate");
    if (row.kind === "residual") {
      const parsed = splitChildSchema.safeParse(row.payload);
      if (!parsed.success || parsed.data.id !== row.copied_claim_id || row.parent_claim_ids.length !== 1 || parsed.data.parent_gap_id !== row.parent_claim_ids[0] || !row.copied_evidence_ids.length) issue("Split child lineage requires full source-context payload and durable evidence IDs");
      if (parsed.success) {
        const parent = final.inventory.find(item => item.claim_id === parsed.data.parent_gap_id && item.claim_type === "gap");
        const parentSpans = Array.isArray(parent?.payload.provenance) ? parent.payload.provenance : [];
        if (!parent || String(parent.payload.statement).trim().toLowerCase().replace(/\s+/g, " ") === parsed.data.statement.trim().toLowerCase().replace(/\s+/g, " ") || parsed.data.source_context.some(span => !parentSpans.some(parentSpan => same(parentSpan, span)))) issue("Generated child source context must retain exact parent spans");
        const support = final.coverage.filter(coverage => parsed.data.support_coverage_ids.includes(coverage.id));
        if (parsed.data.split_run_id !== row.run_id || support.length !== new Set(parsed.data.support_coverage_ids).size || support.some(coverage => coverage.gap_id !== parsed.data.parent_gap_id || !coverage.validated || !["partial", "limited"].includes(coverage.overall) || !parsed.data.support_tactic_ids.includes(coverage.tactic_id)) || parsed.data.support_tactic_ids.some(id => !support.some(coverage => coverage.tactic_id === id) || !lifecycles.some(tactic => tactic.id === id && ["planned", "ongoing", "completed"].includes(tactic.status)))) issue("Split child support must bind retained validated parent coverage and committed tactics");
      }
    }
  }
  for (const split of final.residuals) {
    const children = [split.addressed_gap_id, split.open_residual_gap_id];
    const lineages = children.map(id => generated.find(row => row.kind === "residual" && row.copied_claim_id === id));
    if (!final.inventory.some(row => row.claim_id === split.parent_gap_id && row.claim_type === "gap") || new Set([split.parent_gap_id, ...children]).size !== 3 || lineages.some(row => !row || row.kind !== "residual" || row.parent_claim_ids.length !== 1 || row.parent_claim_ids[0] !== split.parent_gap_id) || lineages[0]?.run_id !== lineages[1]?.run_id || lineages[0]?.payload.branch !== "addressed" || lineages[1]?.payload.branch !== "open" || lineages[0]?.payload.statement === lineages[1]?.payload.statement) issue("A split requires two distinct child branches and shared parent/run lineage");
    if (final.statuses.find(row => row.gap_id === split.parent_gap_id)?.status !== "partial" || final.statuses.find(row => row.gap_id === split.addressed_gap_id)?.computed !== "addressed" || final.statuses.find(row => row.gap_id === split.open_residual_gap_id)?.computed !== "open") issue("Split must retain historical parent partial and justified addressed/open child statuses");
    if (!final.coverage.some(row => row.gap_id === split.addressed_gap_id && row.overall === "full" && row.validated && lifecycles.some(tactic => tactic.id === row.tactic_id && ["planned", "ongoing", "completed"].includes(tactic.status))) || final.coverage.some(row => row.gap_id === split.open_residual_gap_id && row.overall !== "not_relevant")) issue("Split child coverage must justify addressed slice and uncovered remainder");
  }
  if (final.coverage.some(row => !allGaps.has(row.gap_id) || !allTactics.has(row.tactic_id) || !candidate.gates.some(gate => gate.object_type === "coverage" && gate.decision === "pass" && gate.object_ids.includes(row.id)))) issue("Every coverage reference requires a candidate claim and passing gate");
  if (new Set(final.statuses.map(row => row.gap_id)).size !== allGaps.size || final.statuses.length !== allGaps.size || final.statuses.some(row => !allGaps.has(row.gap_id) || row.computed !== deriveGapStatus({ gap_id: row.gap_id, coverages: final.coverage, tactics: lifecycles }))) issue("Every source/generated gap requires one coverage-derived status");
  const eligible = final.statuses.filter(row => row.status !== "addressed" && !final.residuals.some(split => split.parent_gap_id === row.gap_id)).map(row => row.gap_id).sort();
  if (!same(final.priorities.map(row => row.gap_id).sort(), eligible)) issue("Priorities must cover every exact operational eligible gap once");
  if (final.priorities.some(row => row.scoring_identity !== PRIORITY_SCORING_IDENTITY || !same(Object.keys(row.axis_scores).sort(), DEFAULT_AXES.axes.map(axis => axis.id).sort()) || row.score !== weightedScore(row.axis_scores, DEFAULT_AXES.axes) || row.band !== bandFor(row.score, DEFAULT_AXES.bands) || !candidate.gates.some(gate => gate.object_type === "priority" && gate.decision === "pass" && gate.object_ids.includes(row.gap_id)))) issue("Priority suggestions require exact fixed scoring and passing placement gates");
  if (final.proposals.some(row => !final.priorities.some(priority => priority.gap_id === row.gap_id && priority.band === "high") || !final.statuses.some(status => status.gap_id === row.gap_id && status.status === "open"))) issue("Ideation proposals require high-priority operational open parents");
  if (final.plan.activities.some(row => !allTactics.has(row.tactic_id) || row.gap_ids.some(id => !allGaps.has(id)))) issue("Plan references require complete validated source/generated inventory");
  const stage = (name: typeof MIXED_PIPELINE_STAGES[number]) => candidate.stages.find(row => row.stage === name);
  const projection = stage("gantt_project");
  if (projection?.status === "completed" && projection.stage === "gantt_project" && !same(projection.output, final.plan)) issue("Final plan must be the exact full pipeline projection");
  for (const row of candidate.stages) {
    if (row.status !== "completed") continue;
    const configuration = candidate.setup.configuration.modules.find(module => module.stage === row.stage);
    if (!configuration || configuration.module_id !== row.module_id || configuration.module_version !== row.module_version ||
      configuration.prompt_version !== row.prompt_version || configuration.model !== row.model || row.configuration_fingerprint !== candidate.setup.configuration.fingerprint) issue("Stage module, prompt, model, and configuration identities must match setup");
    if (row.stage === "status_derive" && (!same(row.output.statuses, final.statuses) || row.output.open !== final.statuses.filter(status => status.status === "open").length ||
      row.output.partial !== final.statuses.filter(status => status.status === "partial").length || row.output.addressed !== final.statuses.filter(status => status.status === "addressed").length)) issue("Final statuses must match the derived status output and counts");
    if (row.stage === "prioritize" && !same(row.output.placements, final.priorities)) issue("Final priorities must match retained stage output");
    if (row.stage === "partial_split" && !same(row.output.residuals, final.residuals)) issue("Final residuals must match retained stage output");
    if (row.stage === "ideate" && !same(row.output.proposals, final.proposals)) issue("Final proposals must match retained stage output");
    if (row.stage === "coverage_decide" && !same(row.output.decisions, final.coverage)) issue("Final coverage must match retained stage output");
    if (row.stage === "validation_gate" && !same(row.output.decisions, candidate.gates)) issue("Gate stage must retain exactly the acted-on decisions");
    if (row.stage === "inventory_validate" && (!same([...row.output.claim_ids].sort(), candidate.entry_source_inventory.map(item => item.claim_id).sort()) ||
      row.output.findings.some(finding => finding.severity === "blocking"))) issue("Entry deterministic validation must cover the exact inventory and pass");
  }
  const pairs = stage("pair_generate");
  if (stage("coverage_decide")?.status === "skipped" && ((pairs?.status === "completed" && pairs.stage === "pair_generate" && pairs.output.pairs.length) || final.coverage.length)) issue("Nonempty coverage input cannot be skipped");
  if (stage("coverage_critic")?.status === "skipped" && final.coverage.length && candidate.setup.configuration.modules.find(row => row.stage === "coverage_critic")?.parameters.enabled !== false) issue("Configured coverage critic cannot be skipped for nonempty coverage");
  if (stage("partial_split")?.status === "skipped" && (final.residuals.length || final.statuses.some(row => row.status === "partial"))) issue("Applicable partial splitting cannot be skipped");
  if (stage("prioritize")?.status === "skipped" && (final.priorities.length || eligible.length > 0)) issue("Applicable prioritization cannot be skipped");
  if (stage("ideate")?.status === "skipped" && (final.proposals.length || final.priorities.some(row => row.band === "high" && final.statuses.some(status => status.gap_id === row.gap_id && status.status !== "addressed")))) issue("Applicable ideation cannot be skipped");
  if (candidate.setup.configuration.modules.length !== MIXED_PIPELINE_STAGES.length || new Set(candidate.setup.configuration.modules.map(row => row.stage)).size !== MIXED_PIPELINE_STAGES.length) issue("Completed setup requires unique configuration for every downstream stage");
  if (candidate.gates.some(gate => gate.decision === "block")) ctx.addIssue({ code: "custom", message: "Blocked gate prevents completion" });
  if (candidate.final_outputs.plan.workspace_id !== candidate.copied_workspace_id) ctx.addIssue({ code: "custom", message: "Final projection has crossed workspace identity" });
});
export const mixedCandidateEvidenceSchema = z.discriminatedUnion("status", [
  mixedCompletedCandidateSchema,
  z.object({ ...candidateFields, status: z.literal("pending"), primary_error: z.null() }).strict(),
  z.object({ ...candidateFields, status: z.literal("failed"), primary_error: mixedPrimaryErrorSchema }).strict(),
  z.object({ ...candidateFields, status: z.literal("blocked"), primary_error: mixedPrimaryErrorSchema }).strict(),
]);
export type MixedCandidateEvidence = z.infer<typeof mixedCandidateEvidenceSchema>;

const dimension = z.enum(["source_gaps", "source_tactics", "provenance", "coverage", "status", "residual", "priority", "ideation", "plan"]);
const score = z.object({ found: z.number().int().nonnegative(), partial: z.number().int().nonnegative(), missed: z.number().int().nonnegative(), wrong: z.number().int().nonnegative(),
  precision: z.number().min(0).max(1), recall: z.number().min(0).max(1), f1: z.number().min(0).max(1) }).strict();
export const mixedSourceEvaluationSchema = z.object({ evaluator_version: id, pack_id: id, pack_fingerprint: id, call_kind: z.enum(["need_extract", "inventory_extract"]),
  status: z.enum(["scored", "gold_not_applicable", "invalid_output", "model_error"]),
  output_shape: z.object({ valid: z.boolean(), item_field: z.enum(["gaps", "tactics"]).optional(), item_count: z.number().int().nonnegative().optional() }).strict(),
  outcomes: z.array(z.object({ outcome: z.enum(["found", "partial", "missed", "wrong"]), gold_item_key: id.optional(), model_item_index: z.number().int().nonnegative().optional(), reason: id }).strict()),
  errors: z.array(z.string()), score: score.optional(),
}).strict();
export type MixedSourceEvaluation = z.infer<typeof mixedSourceEvaluationSchema>;
export const mixedComparisonEvaluationSchema = z.object({
  evaluator_version: id,
  source_evaluations: z.array(z.object({ candidate: label, point: z.enum(["entry", "final"]), claim_type: z.enum(["gap", "tactic"]), evaluation: mixedSourceEvaluationSchema }).strict()),
  applicability: z.array(z.discriminatedUnion("status", [
    z.object({ dimension, status: z.literal("scored"), reference_keys: distinctIds.min(1) }).strict(),
    z.object({ dimension, status: z.literal("unscored"), reason: id }).strict(),
  ])),
  changes: z.array(z.object({ kind: z.enum(["reference_recovered", "reference_lost", "correct_retained", "correct_removed", "provenance_lost", "unsupported_evidence", "invalid_reference", "invariant_failure", "source_dropped", "source_merged", "source_changed", "coverage_changed", "status_changed", "output_changed"]),
    dimension, severity: z.enum(["blocking", "advisory", "info"]), proven_error: z.boolean(), item_ids: distinctIds, message: id }).strict()),
}).strict();
export type MixedComparisonEvaluation = z.infer<typeof mixedComparisonEvaluationSchema>;
export const mixedComparisonResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("completed"), candidates: z.object({ mixed: mixedCompletedCandidateSchema, baseline: mixedCompletedCandidateSchema }).strict(),
    evaluation: mixedComparisonEvaluationSchema, primary_error: z.null() }).strict().superRefine((result, ctx) => {
    for (const candidate of ["mixed", "baseline"] as const) for (const point of ["entry", "final"] as const) for (const claim_type of ["gap", "tactic"] as const) {
      const evaluations = result.evaluation.source_evaluations.filter(row => row.candidate === candidate && row.point === point && row.claim_type === claim_type);
      if (evaluations.length !== 1 || !evaluations[0].evaluation.output_shape.valid ||
        !["scored", "gold_not_applicable"].includes(evaluations[0].evaluation.status) ||
        evaluations[0].evaluation.call_kind !== (claim_type === "gap" ? "need_extract" : "inventory_extract") ||
        (evaluations[0].evaluation.status === "scored" && !evaluations[0].evaluation.score)) {
        ctx.addIssue({ code: "custom", message: "Completed comparisons require valid source inventory evaluation at entry and final for both candidates" });
      }
    }
    for (const dimension of ["source_gaps", "source_tactics", "provenance", "coverage", "status", "residual", "priority", "ideation", "plan"]) {
      if (result.evaluation.applicability.filter(row => row.dimension === dimension).length !== 1) ctx.addIssue({ code: "custom", message: "Each reference dimension must be explicitly scored or unscored once" });
    }
  }),
  z.object({ status: z.literal("failed"), candidates: z.object({ mixed: mixedCandidateEvidenceSchema.nullable(), baseline: mixedCandidateEvidenceSchema.nullable() }).strict(),
    evaluation: mixedComparisonEvaluationSchema.nullable(), primary_error: mixedPrimaryErrorSchema }).strict(),
  z.object({ status: z.literal("blocked"), candidates: z.object({ mixed: mixedCandidateEvidenceSchema.nullable(), baseline: mixedCandidateEvidenceSchema.nullable() }).strict(),
    evaluation: mixedComparisonEvaluationSchema.nullable(), primary_error: mixedPrimaryErrorSchema }).strict(),
]);
export type MixedComparisonResult = z.infer<typeof mixedComparisonResultSchema>;
export type MixedComparisonScope = { source_workspace_id: string; comparison_id: string };
export type MixedOriginalAssemblies = { mixed: MixedOriginalAssembly; baseline: MixedOriginalAssembly };
export type MixedComparisonRecord = {
  header: typeof tables.accuracyMixedComparisons.$inferSelect;
  status: "running" | MixedComparisonResult["status"];
  links: typeof tables.accuracyMixedCandidateLinks.$inferSelect | null;
  result: typeof tables.accuracyMixedComparisonResults.$inferSelect | null;
  attempts: { mixed: ExperimentRecord | null; baseline: ExperimentRecord | null };
};
export class MixedComparisonError extends Error {
  constructor(readonly code: "invalid_input" | "not_found" | "conflict" | "invalid_attempt" | "incomplete_evidence" | "identity_mismatch", message: string) {
    super(message); this.name = "MixedComparisonError";
  }
}
