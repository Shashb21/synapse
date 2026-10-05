import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { accuracyDb, ensureAccuracySchema } from "@/accuracy/store/db";
import * as tables from "@/accuracy/store/schema";
import { createOrganization, createWorkspace, deleteWorkspace } from "@/accuracy/store/tenant";
import { insertSourceFile } from "@/accuracy/store/source-store";
import { publishGeneratedItemHistory } from "@/accuracy/store/item-history-store";
import { insertClaim } from "@/accuracy/store/claim-store";
import { createAssembly } from "@/accuracy/store/assembly-store";
import { newId, nowIso } from "@/modules/kernel/ids";
import { createMixedComparison, finishMixedComparison, readMixedComparison, bindMixedComparisonAttempts, exportMixedComparison } from "@/accuracy/experiments/mixed-records";

const { closePool } = vi.hoisted(() => ({ closePool: vi.fn() }));
vi.mock("@/lib/iegp/db", async () => {
  const { default: postgres } = await import("postgres");
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const client = postgres(process.env.DATABASE_URL!, { max: 4, connection: { application_name: "kan40-mixed-records-test" } });
  closePool.mockImplementation(() => client.end({ timeout: 5 }));
  return { db: () => drizzle(client) };
});

import { mixedComparisonResultSchema, mixedComparisonInputSchema, mixedCandidateEvidenceSchema, mixedOriginalAssemblySchema, MIXED_PIPELINE_STAGES, MIXED_GATE_POLICY, MIXED_GATE_POLICY_FINGERPRINT,
  type MixedCandidateEvidence, type MixedComparisonResult } from "@/accuracy/experiments/mixed-types";
import { createExperiment, finishExperiment, recordExperimentCall, recordVersionEvaluation } from "@/accuracy/experiments/records";
import { evaluateExperimentVersion, EXPERIMENT_EVALUATOR_VERSION, experimentPackFingerprint } from "@/accuracy/eval/experiment-gold";

const workspaces: string[] = [];
const comparisons: string[] = [];
const actor = { name: "Benchmark actor", function: "medical_affairs" as const };
const primary_error = { phase: "setup" as const, code: "source_drift", message: "Sources changed between copies", stage: null, call_id: null };
const setupFailure = { status: "failed" as const, candidates: { mixed: null, baseline: null }, evaluation: null, primary_error };

async function fixture() {
  const org_id = await createOrganization("mixed comparison records");
  const source_workspace_id = await createWorkspace({ org_id, name: "source", slug: newId("slug") });
  workspaces.push(source_workspace_id);
  const source = await insertSourceFile({ workspace_id: source_workspace_id, filename: "input.txt", mime: "text/plain", checksum: "original-checksum" });
  const block_id = newId("block");
  await accuracyDb().insert(tables.accuracyParseBlocks).values({ id: block_id, workspace_id: source_workspace_id, source_file_id: source.id,
    index: 0, kind: "paragraph", heading: null, text: "Source text supports the selected gap.", parser: "fixture", created_at: nowIso() });
  const gap = { id: newId("gap"), statement: "A source-backed evidence need", external_id: "G-1",
    provenance: [{ source_file_id: source.id, block_id, quote: "supports the selected gap" }] };
  const run_id = newId("run");
  const now = nowIso();
  await accuracyDb().insert(tables.accuracyModuleRuns).values({ id: run_id, org_id, workspace_id: source_workspace_id, call_kind: "need_extract", agent_role: "judge",
    module_id: "fixture", module_version: "1", status: "ok", started_at: now, finished_at: now, actor_name: actor.name, actor_function: actor.function,
    input: { workspace_id: source_workspace_id, source_file_id: source.id }, output: { workspace_id: source_workspace_id, source_file_id: source.id, gaps: [gap] }, steps: [] });
  await publishGeneratedItemHistory({ workspace_id: source_workspace_id, source_file_id: source.id, run_id, claim_type: "gap", final_claims: [{
    id: gap.id, workspace_id: source_workspace_id, source_file_id: source.id, claim_type: "gap", statement: gap.statement,
  }] });
  const [version] = await accuracyDb().select().from(tables.accuracyItemVersions).where(eq(tables.accuracyItemVersions.run_id, run_id));
  const mixed = await createAssembly({ workspace_id: source_workspace_id, actor, source_file_ids: [source.id], selections: [{ item_version_id: version.id, reason: "Exact nominated version" }],
    mappings: [], coverage_run_ids: [], linking_complete: true });
  const baseline = await createAssembly({ workspace_id: source_workspace_id, actor, source_file_ids: [source.id], selections: [{ item_version_id: version.id, reason: "Explicit baseline" }],
    mappings: [], coverage_run_ids: [], linking_complete: true });
  const request = { source_workspace_id, source_file_ids: [source.id], pack_id: "beone-bgb-58067-prmt5i", actor,
    mixed: { assembly_id: mixed.id, fingerprint: mixed.fingerprint }, baseline: { assembly_id: baseline.id, fingerprint: baseline.fingerprint } };
  const record = await createMixedComparison(request);
  comparisons.push(record.header.id);
  return { org_id, source_workspace_id, source, block_id, mixed, baseline, request, record,
    scope: { source_workspace_id, comparison_id: record.header.id } };
}

afterEach(async () => {
  for (const id of comparisons.splice(0)) await accuracyDb().delete(tables.accuracyMixedComparisons).where(eq(tables.accuracyMixedComparisons.id, id));
  for (const id of workspaces.splice(0).reverse()) await deleteWorkspace(id);
});
afterAll(async () => { await closePool(); });

describe("mixed comparison records", () => {
  it("cross_workspace_read_returns_null", async () => {
    const owner = await fixture(), other = await fixture();
    const wrong = { ...owner.scope, source_workspace_id: other.source_workspace_id };
    expect(await readMixedComparison(wrong)).toBeNull();
    expect(await exportMixedComparison({ ...wrong, format: "json" })).toBeNull();
    await expect(finishMixedComparison({ ...wrong, result: setupFailure })).rejects.toMatchObject({ code: "not_found" });
  });

  it("concurrent_conflicting_finish_rejects", async () => {
    const owner = await fixture();
    const results = await Promise.allSettled([
      finishMixedComparison({ ...owner.scope, result: setupFailure }),
      finishMixedComparison({ ...owner.scope, result: { ...setupFailure, status: "blocked" } }),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect((results.find(result => result.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ code: "conflict" });
  });

  it("binds fresh disjoint attempts once before calls without changing the header", async () => {
    const owner = await fixture();
    const attempts = await newAttempts(owner);
    const bound = await bindMixedComparisonAttempts({ ...owner.scope, mixed_experiment_id: attempts.mixed.id, baseline_experiment_id: attempts.baseline.id });
    expect(bound.header).toEqual(owner.record.header);
    expect(bound.links).toMatchObject({ mixed_experiment_id: attempts.mixed.id, baseline_experiment_id: attempts.baseline.id });
    expect(await bindMixedComparisonAttempts({ ...owner.scope, mixed_experiment_id: attempts.mixed.id, baseline_experiment_id: attempts.baseline.id })).toEqual(bound);
    const replacement = await newAttempts(owner);
    await expect(bindMixedComparisonAttempts({ ...owner.scope, mixed_experiment_id: replacement.mixed.id, baseline_experiment_id: replacement.baseline.id })).rejects.toMatchObject({ code: "conflict" });
    const rerun = await createMixedComparison(owner.request);
    comparisons.push(rerun.header.id);
    await expect(bindMixedComparisonAttempts({ source_workspace_id: owner.source_workspace_id, comparison_id: rerun.header.id,
      mixed_experiment_id: attempts.baseline.id, baseline_experiment_id: replacement.mixed.id })).rejects.toMatchObject({ code: "conflict" });
    await finishMixedComparison({ ...owner.scope, result: setupFailure });
    await expect(bindMixedComparisonAttempts({ ...owner.scope, mixed_experiment_id: attempts.mixed.id, baseline_experiment_id: attempts.baseline.id })).rejects.toMatchObject({ code: "conflict" });
    await expect(recordExperimentCall({ workspace_id: attempts.mixed.workspace_id, experiment_id: attempts.mixed.id, call_id: "late", call_kind: "need_extract", version_index: 0, input: {}, output: {}, module_version: "1", route: {} })).rejects.toThrow("terminal");
  });

  it("rejects reused, crossed, and already-started attempts", async () => {
    const owner = await fixture(), other = await fixture();
    const own = await newAttempts(owner), crossed = await newAttempts(other);
    await expect(bindMixedComparisonAttempts({ ...owner.scope, mixed_experiment_id: own.mixed.id, baseline_experiment_id: crossed.baseline.id })).rejects.toMatchObject({ code: "invalid_attempt" });
    await expect(bindMixedComparisonAttempts({ ...owner.scope, mixed_experiment_id: own.mixed.id, baseline_experiment_id: own.mixed.id })).rejects.toMatchObject({ code: "invalid_attempt" });
    await recordExperimentCall({ workspace_id: own.mixed.workspace_id, experiment_id: own.mixed.id, call_id: "too-early", call_kind: "coverage_decide", version_index: 0, input: {}, output: {}, module_version: "1", route: {} });
    await expect(bindMixedComparisonAttempts({ ...owner.scope, mixed_experiment_id: own.mixed.id, baseline_experiment_id: own.baseline.id })).rejects.toMatchObject({ code: "invalid_attempt" });
  });

  it("export_retains_linked_calls_and_evaluations", async () => {
    const owner = await fixture();
    const attempts = await newAttempts(owner);
    await bindMixedComparisonAttempts({ ...owner.scope, mixed_experiment_id: attempts.mixed.id, baseline_experiment_id: attempts.baseline.id });
    const mixed = candidate("mixed", owner.mixed, attempts.mixed.id, attempts.mixed.workspace_id, attempts.mixed);
    const baseline = candidate("baseline", owner.baseline, attempts.baseline.id, attempts.baseline.workspace_id, attempts.baseline);
    await retainStages(mixed, attempts.mixed);
    await retainStages(baseline, attempts.baseline);
    const result = completedResult(mixed, baseline);
    const finished = await finishMixedComparison({ ...owner.scope, result });
    expect(finished.status).toBe("completed");
    expect(finished.header).toEqual(owner.record.header);
    const json = JSON.parse((await exportMixedComparison({ ...owner.scope, format: "json" }))!);
    const lines = (await exportMixedComparison({ ...owner.scope, format: "jsonl" }))!.trim().split("\n").map(line => JSON.parse(line));
    expect(json).toEqual(finished);
    expect(lines).toEqual([json]);
    expect(json.attempts.mixed.calls.find((call: { call_kind: string }) => call.call_kind === "gantt_project").output).toEqual({ workspace_id: attempts.mixed.workspace_id, activities: [] });
    expect(json.attempts.mixed.calls[0].route.usage).toEqual({ input_tokens: null, output_tokens: null, estimated_cost: null });
    expect(json.attempts.mixed.evaluations).toHaveLength(mixed.stages.filter(stage => stage.status === "completed").length);
    expect(json.result.evidence.candidates.mixed.original_assembly.items[0].payload).toEqual(owner.mixed.items[0].payload);
    expect(await finishMixedComparison({ ...owner.scope, result })).toEqual(finished);
    await expect(recordExperimentCall({ workspace_id: attempts.mixed.workspace_id, experiment_id: attempts.mixed.id, call_id: "late", call_kind: "ideate", version_index: 0, input: {}, output: {}, module_version: "1", route: {} })).rejects.toThrow("terminal");
    await expect(recordVersionEvaluation({ workspace_id: attempts.mixed.workspace_id, experiment_id: attempts.mixed.id, call_id: mixed.stages.find(stage => stage.status === "completed")!.stage, version_index: 0,
      evaluation: evaluateExperimentVersion({ pack_id: attempts.mixed.pack_id, call_kind: "inventory_validate", output: {} }) })).rejects.toThrow("terminal");
  });

  it("rejects running attempts, mismatched setup, and unattached final calls", async () => {
    const owner = await fixture();
    const attempts = await newAttempts(owner);
    await bindMixedComparisonAttempts({ ...owner.scope, mixed_experiment_id: attempts.mixed.id, baseline_experiment_id: attempts.baseline.id });
    const mixed = candidate("mixed", owner.mixed, attempts.mixed.id, attempts.mixed.workspace_id, attempts.mixed);
    const baseline = candidate("baseline", owner.baseline, attempts.baseline.id, attempts.baseline.workspace_id, attempts.baseline);
    const result = completedResult(mixed, baseline);
    await expect(finishMixedComparison({ ...owner.scope, result })).rejects.toMatchObject({ code: "invalid_attempt" });
    await retainStages(mixed, attempts.mixed);
    await retainStages(baseline, attempts.baseline);
    await expect(finishMixedComparison({ ...owner.scope, result: { ...result, candidates: { mixed, baseline: { ...baseline, setup: { ...baseline.setup!, source_fingerprint: "drift" } } } } as MixedComparisonResult })).rejects.toMatchObject({ code: "identity_mismatch" });
    const unretained = { ...mixed, stages: mixed.stages.map(stage => stage.stage === "gantt_project" && stage.status === "completed" ? { ...stage, calls: [{ call_id: "missing", version_index: 0 }] } : stage) };
    await expect(finishMixedComparison({ ...owner.scope, result: completedResult(unretained, baseline) })).rejects.toMatchObject({ code: "incomplete_evidence" });
    expect((await readMixedComparison(owner.scope))?.status).toBe("running");
  });

  it("retains a successful peer and primary pipeline error on partial failure", async () => {
    const owner = await fixture();
    const attempts = await newAttempts(owner);
    await bindMixedComparisonAttempts({ ...owner.scope, mixed_experiment_id: attempts.mixed.id, baseline_experiment_id: attempts.baseline.id });
    const mixed = candidate("mixed", owner.mixed, attempts.mixed.id, attempts.mixed.workspace_id, attempts.mixed);
    const baseline = candidate("baseline", owner.baseline, attempts.baseline.id, attempts.baseline.workspace_id, attempts.baseline);
    await retainStages(baseline, attempts.baseline);
    const error = { ...primary_error, phase: "pipeline" as const, code: "module_failed", message: "Original pipeline failure", stage: "coverage_decide", call_id: "failing-call" };
    await recordExperimentCall({ workspace_id: attempts.mixed.workspace_id, experiment_id: attempts.mixed.id, call_id: "failing-call", call_kind: "coverage_decide", version_index: 0,
      input: { exact: true }, output_error: error.message, module_version: "1", route: {} });
    const failed: MixedCandidateEvidence = { ...mixed, status: "failed", final_outputs: null, final_source_inventory: null, primary_error: error,
      stages: [{ stage: "coverage_decide", status: "failed", primary_error: error, run_ids: [], calls: [{ call_id: "failing-call", version_index: 0 }] }] };
    const record = await finishMixedComparison({ ...owner.scope, result: { status: "failed", candidates: { mixed: failed, baseline }, evaluation: null, primary_error: error } });
    expect(record.result?.evidence.primary_error).toEqual(error);
    expect(record.attempts.baseline?.status).toBe("completed");
    expect(record.attempts.mixed?.status).toBe("failed");
    expect(record.attempts.mixed?.calls[0].output_error).toBe("Original pipeline failure");
  });

  it("bootstraps comparison schema twice safely", async () => {
    await ensureAccuracySchema();
    for (let pass = 0; pass < 2; pass++) for (const statement of tables.ACCURACY_MIXED_COMPARISON_DDL) await accuracyDb().execute(sql.raw(statement));
    expect((await fixture()).record.status).toBe("running");
  });

  it("terminal_evidence_is_append_only", async () => {
    const scope = await fixture();
    const finished = await finishMixedComparison({ ...scope.scope, result: setupFailure });
    expect(finished.header).toEqual(scope.record.header);
    expect(finished.status).toBe("failed");
    expect(finished.result?.evidence).toEqual(setupFailure);
    expect(finished.attempts).toEqual({ mixed: null, baseline: null });
    expect(await finishMixedComparison({ ...scope.scope, result: setupFailure })).toEqual(finished);
    await expect(finishMixedComparison({ ...scope.scope, result: { ...setupFailure, primary_error: { ...primary_error, message: "Conflicting error" } } }))
      .rejects.toMatchObject({ code: "conflict" });
    expect(await readMixedComparison(scope.scope)).toEqual(finished);
  });
});

// A concrete empty downstream path: the selected source gap stays open with medium
// priority; no pair, partial split, ideation, or scheduled tactic is applicable.
function candidate(label: "mixed" | "baseline", assembly: Awaited<ReturnType<typeof createAssembly>>, attempt_id = `${label}-attempt`, copied_workspace_id = `${label}-copy`, copy_ids?: { source_id: string; block_id: string }): Extract<MixedCandidateEvidence, { status: "completed" }> {
  const original = mixedOriginalAssemblySchema.parse(assembly);
  const selected = original.items[0];
  const source_id = original.source_file_ids[0];
  const provenance = selected.payload.provenance as { source_file_id: string; block_id: string; quote: string }[];
  const copied_source = copy_ids?.source_id ?? `${label}-source`, copied_block = copy_ids?.block_id ?? `${label}-block`, copied_claim = `${copied_workspace_id}-gap`;
  const copied_payload = { ...selected.payload, id: copied_claim, provenance: [{ ...provenance[0], source_file_id: copied_source, block_id: copied_block }] };
  const inventory = [{ claim_id: copied_claim, claim_type: "gap" as const, payload: copied_payload, original_item_version_ids: [selected.id], original_provenance: provenance }];
  const statuses = [{ gap_id: copied_claim, status: "open" as const, computed: "open" as const, override: false }];
  const priorities = [{ gap_id: copied_claim, band: "medium" as const, axis_scores: { decision_impact: 50, time_pressure: 50, external_scrutiny: 50, feasibility: 50 }, score: 50, rationale: "Fixture evidence", mode: "deterministic" as const, scoring_identity: "s8-default-weighted-cues-v1" }];
  const gate = { id: `${label}-gate`, policy: MIXED_GATE_POLICY, policy_fingerprint: MIXED_GATE_POLICY_FINGERPRINT,
    object_type: "claim" as const, object_ids: [copied_claim], content_fingerprint: "checked-content", check_fingerprint: "checked-checks", checker_version: "checks-v1",
    decision: "pass" as const, rationale: "Deterministic checks passed without edits", automatic: true as const, findings: [] };
  const gates = [gate, { ...gate, id: `${gate.id}-priority`, object_type: "priority" as const }];
  const config = { fingerprint: "config-v1", modules: MIXED_PIPELINE_STAGES.map(stage => ({
    stage, module_id: "fixture", module_version: "1", prompt_version: "1", model: null, parameters: {} })) };
  const identity = { source_fingerprint: "original-source", baseline_fingerprint: "original-baseline", original_baseline_snapshot: { claims: [] },
    pack_fingerprint: experimentPackFingerprint("beone-bgb-58067-prmt5i"), evaluator_version: EXPERIMENT_EVALUATOR_VERSION,
    downstream_evaluator_version: "mixed-downstream-v2", gate_policy: MIXED_GATE_POLICY, gate_policy_fingerprint: MIXED_GATE_POLICY_FINGERPRINT,
    configuration: config, code_identity: "fixture-code", source_files: [{ id: source_id, checksum: "original-checksum", content_fingerprint: "source-content" }],
    parse_blocks: [{ id: provenance[0].block_id, source_file_id: source_id, content_fingerprint: "block-content" }] };
  const metadata = { run_ids: [], calls: [], module_id: "fixture", module_version: "1", prompt_version: "1", model: null, configuration_fingerprint: "config-v1",
    usage: { latency_ms: null, input_tokens: null, output_tokens: null, estimated_cost: null } };
  return { label, status: "completed", attempt_id, copied_workspace_id, original_assembly: original,
    copy: { source_id_map: { [source_id]: copied_source }, block_id_map: { [provenance[0].block_id]: copied_block }, claim_id_map: { [selected.claim_id]: copied_claim },
      provenance_id_map: {}, original_content_fingerprint: "source-content", remapped_content_fingerprint: `${label}-content` }, setup: identity,
    lineage: [{ kind: "selected", original_item_version_id: selected.id, original_claim_id: selected.claim_id, original_run_id: selected.run_id!, original_snapshot_id: selected.snapshot_id,
      original_iteration: selected.iteration, original_item_index: selected.item_index, selection_reason: selected.reason,
      copied_claim_id: copied_claim, copied_evidence_ids: [`${copied_workspace_id}-prov`], original_payload: selected.payload, copied_payload }],
    gates, entry_source_inventory: inventory, final_source_inventory: inventory, primary_error: null,
    stages: [
      { stage: "inventory_validate", status: "completed", ...metadata, output: { claim_ids: [copied_claim], findings: [] } },
      { stage: "pair_generate", status: "completed", ...metadata, output: { pairs: [] } },
      { stage: "coverage_decide", status: "skipped", reason: "No candidate pairs", applicable: false, input_count: 0 },
      { stage: "coverage_critic", status: "skipped", reason: "No coverage decisions", applicable: false, input_count: 0 },
      { stage: "validation_gate", status: "completed", ...metadata, output: { decisions: gates } },
      { stage: "partial_split", status: "skipped", reason: "No partial gaps", applicable: false, input_count: 0 },
      { stage: "status_derive", status: "completed", ...metadata, output: { statuses, open: 1, partial: 0, addressed: 0 } },
      { stage: "prioritize", status: "completed", ...metadata, output: { placements: priorities } },
      { stage: "ideate", status: "skipped", reason: "No high-priority open gaps", applicable: false, input_count: 0 },
      { stage: "gantt_project", status: "completed", ...metadata, output: { workspace_id: copied_workspace_id, activities: [] } },
    ], final_outputs: { inventory, coverage: [], statuses, priorities, residuals: [], proposals: [], plan: { workspace_id: copied_workspace_id, activities: [] } },
  };
}

function literalAssembly() {
  return { id: "assembly-mixed", workspace_id: "original-workspace", actor, created_at: "2026-10-05T00:00:00Z", fingerprint: "original-assembly", source_file_ids: ["original-source"],
    items: [{ id: "version-1", claim_id: "gap-1", claim_type: "gap" as const, canonical_claim_id: "gap-1", run_id: "extract-run", snapshot_id: null, iteration: null, item_index: 0,
      source_file_id: "original-source", created_at: "2026-10-05T00:00:00Z", reason: "Exact nominated version", payload: { id: "gap-1", statement: "A source-backed evidence need",
        provenance: [{ source_file_id: "original-source", block_id: "original-block", quote: "Source-backed" }], retained_extra_field: { nullable: null } } }],
    mappings: [], coverage: [], extraction_runs: null, linking_complete: true, generation_key: null,
    output: { gaps: [{ id: "gap-1", statement: "A source-backed evidence need" }], tactics: [] }, checks: { checker_version: "assembly-domain-v1", status: "passed" as const, findings: [] } };
}

function completedResult(mixed: MixedCandidateEvidence, baseline: MixedCandidateEvidence): MixedComparisonResult {
  return { status: "completed", candidates: { mixed: mixed as Extract<MixedCandidateEvidence, { status: "completed" }>, baseline: baseline as Extract<MixedCandidateEvidence, { status: "completed" }> }, primary_error: null,
    evaluation: { evaluator_version: "mixed-downstream-v2", source_evaluations: ([mixed, baseline] as const).flatMap(candidate => (["entry", "final"] as const).flatMap(point => (["gap", "tactic"] as const).map(claim_type => ({
      candidate: candidate.label, point, claim_type, evaluation: { ...evaluateExperimentVersion({ pack_id: "beone-bgb-58067-prmt5i", call_kind: claim_type === "gap" ? "need_extract" : "inventory_extract",
        output: { [claim_type === "gap" ? "gaps" : "tactics"]: (point === "entry" ? candidate.entry_source_inventory : candidate.final_source_inventory ?? []).filter(row => row.claim_type === claim_type).map(row => row.payload) } }), call_kind: claim_type === "gap" ? "need_extract" as const : "inventory_extract" as const },
    })))), changes: [], applicability: [
      { dimension: "source_gaps", status: "scored", reference_keys: ["G-1"] },
      { dimension: "source_tactics", status: "scored", reference_keys: ["T-1"] },
      ...(["provenance", "coverage", "status", "residual", "priority", "ideation", "plan"] as const).map(dimension => ({ dimension, status: "unscored" as const, reason: "Curated pack has no downstream labels" })),
    ] } };
}

describe("mixed comparison evidence contract", () => {
  it("requires both full projections and concrete terminal stage outputs", () => {
    const mixed = candidate("mixed", literalAssembly());
    const baseline = candidate("baseline", literalAssembly());
    const full = completedResult(mixed, baseline);
    expect(mixedComparisonResultSchema.safeParse(full).success).toBe(true);
    expect(mixedComparisonResultSchema.safeParse({ ...full, candidates: { mixed, baseline: null } }).success).toBe(false);
    expect(mixedComparisonResultSchema.safeParse({ ...full, candidates: { mixed: { ...mixed, stages: mixed.stages.filter(stage => stage.stage !== "gantt_project") }, baseline } }).success).toBe(false);
    expect(mixedComparisonResultSchema.safeParse({ ...full, candidates: { mixed: { ...mixed, final_outputs: null }, baseline } }).success).toBe(false);
    expect(mixedCandidateEvidenceSchema.safeParse({ ...mixed, stages: [{ stage: "gantt_project", status: "completed", output: {} }] }).success).toBe(false);
  });

  it("rejects fabricated completion, stale final snapshots, and unjustified empty branches", () => {
    const full = candidate("mixed", literalAssembly());
    expect(mixedCandidateEvidenceSchema.safeParse({ ...full, final_source_inventory: [] }).success).toBe(false);
    expect(mixedCandidateEvidenceSchema.safeParse({ ...full, stages: full.stages.map(stage => stage.stage === "prioritize" ? { stage: "prioritize", status: "skipped", applicable: false, input_count: 0, reason: "Claimed empty" } : stage) }).success).toBe(false);
    expect(mixedCandidateEvidenceSchema.safeParse({ ...full, final_outputs: { ...full.final_outputs, statuses: [] } }).success).toBe(false);
    expect(mixedCandidateEvidenceSchema.safeParse({ ...full, entry_source_inventory: [] }).success).toBe(false);
    expect(mixedCandidateEvidenceSchema.safeParse({ ...full, lineage: [] }).success).toBe(false);
    expect(mixedCandidateEvidenceSchema.safeParse({ ...full, setup: { ...full.setup, source_files: [] } }).success).toBe(false);
    expect(mixedCandidateEvidenceSchema.safeParse({ ...full, stages: full.stages.map(stage => stage.stage === "gantt_project" && stage.status === "completed" ? { ...stage, output: { workspace_id: "wrong-workspace", activities: [] } } : stage) }).success).toBe(false);
  });

  it("requires exact remapped payloads and automatic gates for selected claims", () => {
    const full = candidate("mixed", literalAssembly());
    const changed = { ...full.entry_source_inventory[0].payload, statement: "A manual replacement" };
    const edited = { ...full, entry_source_inventory: [{ ...full.entry_source_inventory[0], payload: changed }],
      lineage: full.lineage.map(row => row.kind === "selected" ? { ...row, copied_payload: changed } : row) };
    expect(mixedCandidateEvidenceSchema.safeParse(edited).success).toBe(false);
    const changedFinal = [{ ...full.final_source_inventory[0], payload: changed }];
    expect(mixedCandidateEvidenceSchema.safeParse({ ...full, final_source_inventory: changedFinal, final_outputs: { ...full.final_outputs, inventory: changedFinal } }).success).toBe(false);
    expect(mixedCandidateEvidenceSchema.safeParse({ ...full, gates: [], stages: full.stages.map(stage => stage.stage === "validation_gate" && stage.status === "completed" ? { ...stage, output: { decisions: [] } } : stage) }).success).toBe(false);
  });

  it("requires final source evaluations and labels every unsupported dimension", () => {
    const result = completedResult(candidate("mixed", literalAssembly()), candidate("baseline", literalAssembly()));
    expect(mixedComparisonResultSchema.safeParse({ ...result, evaluation: { ...result.evaluation, source_evaluations: [] } }).success).toBe(false);
    expect(mixedComparisonResultSchema.safeParse({ ...result, evaluation: { ...result.evaluation, applicability: [] } }).success).toBe(false);
    expect(mixedComparisonResultSchema.safeParse({ ...result, evaluation: { ...result.evaluation, overall_accuracy: 1 } }).success).toBe(false);
  });

  it("rejects client-owned actor, policy, gold, and duplicate source IDs", () => {
    const input = { source_workspace_id: "source", source_file_ids: ["doc"], pack_id: "pack", mixed: { assembly_id: "m", fingerprint: "mf" }, baseline: { assembly_id: "b", fingerprint: "bf" } };
    expect(mixedComparisonInputSchema.safeParse(input).success).toBe(true);
    for (const extra of [{ actor }, { gate_policy: "override" }, { gold: {} }, { comparison_id: "mine" }, { trusted_scope: true }]) {
      expect(mixedComparisonInputSchema.safeParse({ ...input, ...extra }).success).toBe(false);
    }
    expect(mixedComparisonInputSchema.safeParse({ ...input, source_file_ids: ["doc", "doc"] }).success).toBe(false);
  });
});

async function newAttempts(owner: Awaited<ReturnType<typeof fixture>>) {
  const records = [];
  for (const label of ["mixed", "baseline"] as const) {
    const org_id = await createOrganization(`${label} isolated copy`);
    const workspace_id = await createWorkspace({ org_id, name: label, slug: newId("slug") });
    workspaces.push(workspace_id);
    const source = await insertSourceFile({ workspace_id, filename: "input.txt", mime: "text/plain", checksum: "original-checksum" });
    const block = { id: `${label}-block`, workspace_id, source_file_id: source.id, index: 0, kind: "paragraph", heading: null, text: "Source text supports the selected gap.", parser: "fixture", created_at: nowIso() };
    block.id = newId("block");
    await accuracyDb().insert(tables.accuracyParseBlocks).values(block);
    const copied_claim = `${workspace_id}-gap`;
    await insertClaim({ id: copied_claim, workspace_id, source_file_id: source.id, claim_type: "gap", statement: "A source-backed evidence need", validated: true });
    await accuracyDb().insert(tables.accuracyProvenance).values({ id: `${workspace_id}-prov`, workspace_id, claim_id: copied_claim, source_file_id: source.id, block_id: block.id, quote: "supports the selected gap" });
    records.push({ ...await createExperiment({ org_id, workspace_id, source_workspace_id: owner.source_workspace_id, pack_id: owner.request.pack_id,
      source_fingerprint: "original-source", baseline_fingerprint: "original-baseline", baseline_snapshot: {}, condition: {} }), source_id: source.id, block_id: block.id });
  }
  return { mixed: records[0], baseline: records[1] };
}

async function retainStages(evidence: MixedCandidateEvidence, attempt: Awaited<ReturnType<typeof createExperiment>>) {
  for (const stage of evidence.stages) {
    if (stage.status !== "completed") continue;
    stage.calls = [{ call_id: stage.stage, version_index: 0 }];
    stage.run_ids = [stage.stage];
    await recordExperimentCall({ workspace_id: attempt.workspace_id, experiment_id: attempt.id, call_id: stage.stage, call_kind: stage.stage, version_index: 0,
      input: { workspace_id: attempt.workspace_id }, output: stage.output, module_version: stage.module_version,
      route: { usage: { input_tokens: null, output_tokens: null, estimated_cost: null } } });
    await recordVersionEvaluation({ workspace_id: attempt.workspace_id, experiment_id: attempt.id, call_id: stage.stage, version_index: 0,
      evaluation: evaluateExperimentVersion({ pack_id: attempt.pack_id, call_kind: stage.stage, output: stage.output }) });
  }
  await finishExperiment({ workspace_id: attempt.workspace_id, experiment_id: attempt.id, status: "completed" });
}
