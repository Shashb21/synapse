/** Coordinate a fresh matched pair while retaining independent candidate histories. */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { evaluateMixedComparison, MIXED_DOWNSTREAM_EVALUATOR_VERSION } from "@/accuracy/eval/mixed-comparison";
import { deleteWorkspace } from "@/accuracy/store/tenant";
import { copyExperimentWorkspace, type CopyExperimentWorkspaceResult } from "./copy-workspace";
import { materializeMixedCandidate } from "./mixed-materialize";
import { captureMixedPipelineConfiguration, runMixedCandidatePipeline } from "./mixed-pipeline";
import { createMixedComparison, bindMixedComparisonAttempts, finishMixedComparison } from "./mixed-records";
import { createExperiment, finishExperiment } from "./records";
import { MIXED_PIPELINE_STAGES, mixedSetupIdentitySchema, type MixedCandidateEvidence, type MixedComparisonRecord, type MixedComparisonRequest,
  type MixedComparisonResult, type MixedPrimaryError, type MixedSetupIdentity } from "./mixed-types";

type Label = "mixed" | "baseline";
const labels = ["mixed", "baseline"] as const;
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]));
  return value;
}
function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex"); }
function failure(error: unknown, phase: MixedPrimaryError["phase"]): MixedPrimaryError {
  return { phase, code: error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : `${phase}_failed`,
    message: error instanceof Error ? error.message : String(error), stage: null, call_id: null };
}
/** Restore original identities so private copy IDs never affect matched setup. */
function originalSnapshot(copy: CopyExperimentWorkspaceResult, record: MixedComparisonRecord): MixedSetupIdentity["original_baseline_snapshot"] {
  const snapshot = copy.baseline_snapshot as Record<string, Array<Record<string, unknown>>>;
  const ids: Record<string, string> = { [copy.workspace_id]: record.header.source_workspace_id, [copy.org_id]: record.header.source_org_id };
  for (const [original, copied] of Object.entries(copy.history_id_map ?? {})) ids[copied] = original;
  for (const rows of Object.values(snapshot)) if (Array.isArray(rows)) for (const row of rows) if (typeof row.id === "string" && typeof row.original_id === "string") ids[row.id] = row.original_id;
  const visit = (value: unknown): unknown => {
    if (typeof value === "string") return ids[value] ?? value;
    if (Array.isArray(value)) return value.map(visit);
    if (value !== null && typeof value === "object") {
      const row = value as Record<string, unknown>;
      return Object.fromEntries(Object.entries(row).filter(([key]) => !["copied_id", "original_id", "baseline_origin", "original_operation_key", "original_request_fingerprint"].includes(key))
        .map(([key, child]) => [key, visit(key === "operation_key" ? row.original_operation_key ?? child : key === "request_fingerprint" ? row.original_request_fingerprint ?? child : child)]));
    }
    return value;
  };
  return visit(snapshot) as MixedSetupIdentity["original_baseline_snapshot"];
}
/**
 * Replay two exact nominations only after both copies pass matched setup.
 *
 * Every invocation creates fresh attempts. Candidate execution and evaluation run
 * outside persistence transactions; an unavailable terminal store rejects rather
 * than reporting success without durable evidence.
 *
 * @param request Exact source, assembly, pack nominations and server-owned actor.
 * @returns The durable, source-scoped comparison with both retained histories.
 * @throws If initial validation or durable failure retention cannot succeed.
 */
export async function runMixedComparison(request: MixedComparisonRequest): Promise<MixedComparisonRecord> {
  const record = await createMixedComparison(request);
  const scope = { source_workspace_id: record.header.source_workspace_id, comparison_id: record.header.id };
  const copies: Partial<Record<Label, CopyExperimentWorkspaceResult>> = {};
  const attempts: Partial<Record<Label, Awaited<ReturnType<typeof createExperiment>>>> = {};
  const candidates: { mixed: MixedCandidateEvidence | null; baseline: MixedCandidateEvidence | null } = { mixed: null, baseline: null };
  let setup: MixedSetupIdentity;
  try {
    const configuration = await captureMixedPipelineConfiguration();
    for (const label of labels) copies[label] = await copyExperimentWorkspace({ source_workspace_id: request.source_workspace_id, source_file_ids: request.source_file_ids });
    const mixed = copies.mixed!, baseline = copies.baseline!;
    const original_baseline_snapshot = originalSnapshot(mixed, record);
    if (mixed.workspace_id === baseline.workspace_id || mixed.org_id === baseline.org_id ||
      mixed.source_fingerprint !== baseline.source_fingerprint || mixed.baseline_fingerprint !== baseline.baseline_fingerprint ||
      !isDeepStrictEqual(original_baseline_snapshot, originalSnapshot(baseline, record))) {
      throw Object.assign(new Error("Original source and baseline identities drifted between candidate copies."), { code: "identity_mismatch" });
    }
    const sources = original_baseline_snapshot.source_files as Array<Record<string, string>>;
    const blocks = original_baseline_snapshot.parse_blocks as Array<Record<string, string>>;
    setup = mixedSetupIdentitySchema.parse({ source_fingerprint: mixed.source_fingerprint, baseline_fingerprint: mixed.baseline_fingerprint, original_baseline_snapshot,
      pack_fingerprint: record.header.pack_fingerprint, evaluator_version: record.header.evaluator_version,
      downstream_evaluator_version: MIXED_DOWNSTREAM_EVALUATOR_VERSION, gate_policy: record.header.gate_policy,
      gate_policy_fingerprint: record.header.gate_policy_fingerprint, configuration,
      code_identity: hash([runMixedComparison, copyExperimentWorkspace, materializeMixedCandidate, runMixedCandidatePipeline, evaluateMixedComparison].map(fn => fn.toString())),
      source_files: sources.map(row => ({ id: row.id, checksum: row.checksum, content_fingerprint: hash(row) })),
      parse_blocks: blocks.map(row => ({ id: row.id, source_file_id: row.source_file_id, content_fingerprint: hash(row) })) });
    for (const label of labels) {
      const copy = copies[label]!;
      attempts[label] = await createExperiment({ workspace_id: copy.workspace_id, org_id: copy.org_id, source_workspace_id: request.source_workspace_id,
        pack_id: request.pack_id, pack_fingerprint: record.header.pack_fingerprint, source_fingerprint: copy.source_fingerprint,
        baseline_fingerprint: copy.baseline_fingerprint, baseline_snapshot: copy.baseline_snapshot,
        condition: { comparison_id: record.header.id, candidate: label, setup } });
    }
    await bindMixedComparisonAttempts({ ...scope, mixed_experiment_id: attempts.mixed!.id, baseline_experiment_id: attempts.baseline!.id });
  } catch (error) {
    // Copies with retained attempts remain inspectable, even if linkage failed.
    for (const label of labels) {
      const copy = copies[label], attempt = attempts[label];
      if (attempt) await finishExperiment({ workspace_id: attempt.workspace_id, experiment_id: attempt.id, status: "failed" }).catch(() => undefined);
      else if (copy) await deleteWorkspace(copy.workspace_id).catch(() => undefined);
    }
    const primary_error = failure(error, "setup");
    try {
      return await finishMixedComparison({ ...scope, result: { status: primary_error.code === "identity_mismatch" ? "blocked" : "failed", candidates, evaluation: null, primary_error } });
    } catch (persistenceError) {
      // Match the downstream terminal-error shape: keep the primary diagnosis
      // and expose the failed retention write only as secondary context.
      throw Object.assign(new Error(primary_error.message), { cause: persistenceError, code: primary_error.code });
    }
  }

  let primary_error: MixedPrimaryError | null = null;
  // Each candidate has its own failure boundary. A failed peer cannot cancel the
  // other replay; materialization failure still retains its attempt and nomination.
  for (const label of labels) {
    const copy = copies[label]!, attempt = attempts[label]!;
    let evidence: MixedCandidateEvidence = { label, status: "pending", primary_error: null, attempt_id: attempt.id,
      copied_workspace_id: copy.workspace_id, original_assembly: record.header.original_assemblies[label], setup, copy: null,
      lineage: [], gates: [], stages: MIXED_PIPELINE_STAGES.map(stage => ({ stage, status: "pending" })),
      entry_source_inventory: [], final_source_inventory: null, final_outputs: null };
    try {
      evidence = { ...await materializeMixedCandidate({ label, assembly: record.header.original_assemblies[label], copy }), attempt_id: attempt.id, setup };
      evidence = await runMixedCandidatePipeline({ evidence, actor: record.header.request.actor, pack_id: request.pack_id });
    } catch (error) {
      evidence = { ...evidence, status: "failed", primary_error: failure(error, "pipeline") };
    }
    if (evidence.status !== "completed") primary_error ??= evidence.primary_error;
    candidates[label] = evidence;
    try {
      await finishExperiment({ workspace_id: copy.workspace_id, experiment_id: attempt.id, status: evidence.status === "completed" ? "completed" : "failed" });
    } catch (error) {
      primary_error ??= failure(error, "persistence");
      // A candidate cannot be claimed completed until its attempt is durable.
      if (evidence.status === "completed") candidates[label] = { ...evidence, status: "failed", primary_error: failure(error, "persistence") };
    }
  }
  let evaluation: MixedComparisonResult["evaluation"] = null;
  try { evaluation = await evaluateMixedComparison({ mixed: candidates.mixed!, baseline: candidates.baseline!, pack_id: request.pack_id }); }
  catch (error) { primary_error ??= failure(error, "evaluation"); }
  let result: MixedComparisonResult;
  if (!primary_error && evaluation && candidates.mixed?.status === "completed" && candidates.baseline?.status === "completed") {
    result = { status: "completed", candidates: { mixed: candidates.mixed, baseline: candidates.baseline }, evaluation, primary_error: null };
  } else {
    primary_error ??= failure(new Error("Both full candidate endpoints are required."), "pipeline");
    const status = candidates.mixed?.status === "blocked" || candidates.baseline?.status === "blocked" ? "blocked" : "failed";
    result = { status, candidates, evaluation, primary_error };
  }
  try { return await finishMixedComparison({ ...scope, result }); }
  catch (error) {
    // Retain the successful outputs and original error when terminal persistence
    // fails. If this fallback also fails, propagate the primary cause honestly.
    const retained_error = primary_error ?? failure(error, "persistence");
    try { return await finishMixedComparison({ ...scope, result: { status: "failed", candidates, evaluation, primary_error: retained_error } }); }
    catch { throw Object.assign(new Error(retained_error.message), { cause: error, code: retained_error.code }); }
  }
}
