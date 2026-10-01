/** Run one accuracy module against a copied workspace and retain gold-only evaluation. */
import { evaluateExperimentVersion } from "@/accuracy/eval/experiment-gold";
import { readAgentProgression } from "@/accuracy/kernel/agent-events";
import type { Actor, CallKind } from "@/accuracy/kernel/contracts";
import { activeAccuracyModule } from "@/accuracy/kernel/registry";
import { runAccuracyModule } from "@/accuracy/kernel/run";
import { reservedAccuracyRun } from "@/accuracy/kernel/observability";
import { newId } from "@/modules/kernel/ids";
import { deleteWorkspace } from "@/accuracy/store/tenant";
import { copyExperimentWorkspace } from "./copy-workspace";
import { createExperiment, finishExperiment, getExperiment, recordExperimentCall, recordVersionEvaluation, type ExperimentRecord } from "./records";
import { runExtractionPipeline } from "./extraction-pipeline";

export type AccuracyExperimentRequest = {
  mode: "single_call" | "pipeline";
  source_workspace_id: string;
  source_file_ids: string[];
  pack_id: string;
  condition: Record<string, unknown>;
  call?: { call_kind: CallKind; input: Record<string, unknown> };
  actor: Actor;
};

type IdMaps = { source: Record<string, string>; block: Record<string, string>; claim: Record<string, string> };
type IdField = "source" | "block" | "claim";
type RemapContract = { source: readonly string[]; block: readonly string[]; claim: readonly string[]; nested_claim_collections?: readonly string[] };

/** Each supported module declares every workspace-owned identifier it accepts. */
const REMAP_CONTRACTS: Record<CallKind, RemapContract> = {
  upload: { source: [], block: [], claim: [] },
  parse: { source: ["source_file_id"], block: [], claim: [] },
  inventory_extract: { source: ["source_file_id"], block: ["block_ids"], claim: [] },
  need_extract: { source: ["source_file_id"], block: ["block_ids"], claim: [] },
  merge_dedupe: { source: [], block: [], claim: [] },
  completeness_audit: { source: [], block: [], claim: [] },
  pair_generate: { source: [], block: [], claim: [] },
  coverage_decide: { source: [], block: ["block_bundle_ids"], claim: ["gap_id", "tactic_id"] },
  coverage_critic: { source: [], block: ["quote_block_ids"], claim: ["gap_id", "tactic_id"] },
  status_derive: { source: [], block: [], claim: ["gap_ids", "gap_id", "tactic_id"], nested_claim_collections: ["tactics"] },
  partial_split: { source: [], block: [], claim: ["gap_id"] },
  prioritize: { source: [], block: [], claim: ["gap_ids"] },
  validation_gate: { source: [], block: [], claim: ["claim_ids"] },
  ideate: { source: [], block: [], claim: [], nested_claim_collections: ["gaps"] },
  gantt_project: { source: [], block: [], claim: ["tactic_id", "gap_id", "parent_gap_id", "depends_on", "gap_ids"], nested_claim_collections: ["tactics", "gaps"] },
};

/** Remap workspace-owned input IDs, failing closed when a referenced ID has no copied counterpart. */
function remapExperimentInput(call_kind: CallKind, input: Record<string, unknown>, workspace_id: string, org_id: string, maps: IdMaps): Record<string, unknown> {
  const contract = REMAP_CONTRACTS[call_kind];
  const field = new Map<string, IdField>([
    ...contract.source.map((key) => [key, "source"] as const),
    ...contract.block.map((key) => [key, "block"] as const),
    ...contract.claim.map((key) => [key, "claim"] as const),
  ]);
  const mapId = (key: string, value: string, kind: IdField): string => maps[kind][value] ?? unresolved(key, value);
  const visit = (value: unknown, key?: string, parentKey?: string): unknown => {
    if (key === "workspace_id") return workspace_id;
    if (key === "org_id") return org_id;
    const kind = key ? field.get(key) : undefined;
    if (typeof value === "string" && kind) return mapId(key!, value, kind);
    if (typeof value === "string" && key === "id" && parentKey && contract.nested_claim_collections?.includes(parentKey)) return mapId(key, value, "claim");
    if (Array.isArray(value)) return value.map((item) => kind
      ? (typeof item === "string" ? mapId(key!, item, kind) : unresolved(key!, String(item)))
      : visit(item, undefined, key));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [childKey, visit(child, childKey, parentKey)]));
    return value;
  };
  return visit(input) as Record<string, unknown>;
}

function unresolved(key: string, value: string): never { throw new Error(`Unresolved copied ${key}: ${value}`); }

/** Keep an already-created experiment inspectable while preserving its primary failure. */
async function terminateAfterPersistenceFailure(args: { workspace_id: string; experiment_id: string; error: unknown }): Promise<never> {
  await finishExperiment({ workspace_id: args.workspace_id, experiment_id: args.experiment_id, status: "failed" }).catch(() => undefined);
  throw args.error;
}

/** Execute the supported single-call experiment and persist every output version before returning. */
export async function runAccuracyExperiment(request: AccuracyExperimentRequest): Promise<ExperimentRecord> {
  if (request.mode === "pipeline") {
    const copy = await copyExperimentWorkspace({ source_workspace_id: request.source_workspace_id, source_file_ids: request.source_file_ids });
    let experiment: Awaited<ReturnType<typeof createExperiment>>;
    try {
      experiment = await createExperiment({ workspace_id: copy.workspace_id, org_id: copy.org_id, source_workspace_id: request.source_workspace_id,
        pack_id: request.pack_id, source_fingerprint: copy.source_fingerprint, baseline_fingerprint: copy.baseline_fingerprint,
        baseline_snapshot: copy.baseline_snapshot, condition: request.condition });
      const copiedSourceIds = request.source_file_ids.map(source_file_id => copy.source_id_map[source_file_id] ?? unresolved("source_file_id", source_file_id));
      await runExtractionPipeline({ workspace_id: copy.workspace_id, org_id: copy.org_id, experiment_id: experiment.id, pack_id: request.pack_id, actor: request.actor }, copiedSourceIds);
      await finishExperiment({ workspace_id: copy.workspace_id, experiment_id: experiment.id, status: "completed" });
    } catch (error) {
      if (!experiment!) {
        await deleteWorkspace(copy.workspace_id);
        throw error;
      }
      await finishExperiment({ workspace_id: copy.workspace_id, experiment_id: experiment.id, status: "failed" }).catch(() => undefined);
    }
    const record = await getExperiment({ workspace_id: copy.workspace_id, experiment_id: experiment!.id });
    if (!record) throw new Error("Pipeline experiment record disappeared before it could be returned.");
    return record;
  }
  if (!request.call) throw new Error("A single_call experiment requires a call.");
  const copy = await copyExperimentWorkspace({ source_workspace_id: request.source_workspace_id, source_file_ids: request.source_file_ids });
  let input: Record<string, unknown>;
  try {
    input = remapExperimentInput(request.call.call_kind, request.call.input, copy.workspace_id, copy.org_id, { source: copy.source_id_map, block: copy.block_id_map, claim: copy.claim_id_map });
  } catch (error) {
    await deleteWorkspace(copy.workspace_id);
    throw error;
  }
  let experiment;
  let implementation;
  try {
    experiment = await createExperiment({ workspace_id: copy.workspace_id, org_id: copy.org_id, source_workspace_id: request.source_workspace_id,
      pack_id: request.pack_id, source_fingerprint: copy.source_fingerprint, baseline_fingerprint: copy.baseline_fingerprint,
      baseline_snapshot: copy.baseline_snapshot, condition: request.condition });
    implementation = await activeAccuracyModule(request.call.call_kind);
  } catch (error) {
    await deleteWorkspace(copy.workspace_id);
    throw error;
  }
  const call_id = newId("arun");
  let result: Awaited<ReturnType<typeof runAccuracyModule>>;
  try {
    result = await runAccuracyModule({ call_kind: request.call.call_kind, reserved_run_id: call_id, input, actor: request.actor,
      org_id: copy.org_id, workspace_id: copy.workspace_id, evaluation_context: "experiment" });
  } catch (error) {
    const moduleError = error;
    try {
      const output_error = error instanceof Error ? error.message : String(error);
      const failedRun = await reservedAccuracyRun(copy.workspace_id, call_id);
      const progression = failedRun ? await readAgentProgression({ workspace_id: copy.workspace_id, run_id: call_id }) : null;
      const snapshots = progression?.events.flatMap((event) => event.event.event_type === "snapshot" ? [event.event.output] : []) ?? [];
      for (const [version_index, output] of snapshots.entries()) {
        await recordExperimentCall({ workspace_id: copy.workspace_id, experiment_id: experiment.id, call_id, call_kind: request.call.call_kind,
          version_index, input, output, module_version: failedRun?.module_version ?? implementation.manifest.version, route: failedRun?.route ?? { status: "unavailable" } });
        await recordVersionEvaluation({ workspace_id: copy.workspace_id, experiment_id: experiment.id, call_id, version_index,
          evaluation: evaluateExperimentVersion({ pack_id: request.pack_id, call_kind: request.call.call_kind, output }) });
      }
      const errorVersion = snapshots.length;
      await recordExperimentCall({ workspace_id: copy.workspace_id, experiment_id: experiment.id, call_id, call_kind: request.call.call_kind,
        version_index: errorVersion, input, output_error, module_version: failedRun?.module_version ?? implementation.manifest.version,
        route: failedRun?.route ?? { status: "unavailable", reason: "Module did not open a run." } });
      await recordVersionEvaluation({ workspace_id: copy.workspace_id, experiment_id: experiment.id, call_id, version_index: errorVersion,
        evaluation: evaluateExperimentVersion({ pack_id: request.pack_id, call_kind: request.call.call_kind, output: null, output_error }) });
      await finishExperiment({ workspace_id: copy.workspace_id, experiment_id: experiment.id, status: "failed" });
      const failed = await getExperiment({ workspace_id: copy.workspace_id, experiment_id: experiment.id });
      if (!failed) throw new Error("Failed experiment record disappeared before it could be returned.");
      return failed;
    } catch {
      return terminateAfterPersistenceFailure({ workspace_id: copy.workspace_id, experiment_id: experiment.id, error: moduleError });
    }
  }
  try {
    const progression = await readAgentProgression({ workspace_id: copy.workspace_id, run_id: result.run_id });
    const snapshots = progression?.events.flatMap((event) => event.event.event_type === "snapshot" ? [event.event.output] : []) ?? [];
    const outputs = snapshots.length ? snapshots : [result.output];
    for (const [version_index, output] of outputs.entries()) {
      await recordExperimentCall({ workspace_id: copy.workspace_id, experiment_id: experiment.id, call_id: result.run_id, call_kind: request.call.call_kind,
        version_index, input, output, module_version: result.module_version, route: result.route });
      await recordVersionEvaluation({ workspace_id: copy.workspace_id, experiment_id: experiment.id, call_id: result.run_id, version_index,
        evaluation: evaluateExperimentVersion({ pack_id: request.pack_id, call_kind: request.call.call_kind, output }) });
    }
    await finishExperiment({ workspace_id: copy.workspace_id, experiment_id: experiment.id, status: "completed" });
  } catch (error) {
    // The original persistence/evaluator error is the actionable cause. Best-effort
    // terminalization keeps the retained workspace inspectable without replacing it.
    return terminateAfterPersistenceFailure({ workspace_id: copy.workspace_id, experiment_id: experiment.id, error });
  }
  const record = await getExperiment({ workspace_id: copy.workspace_id, experiment_id: experiment.id });
  if (!record) throw new Error("Experiment record disappeared before it could be returned.");
  return record;
}
