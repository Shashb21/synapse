/** Run one accuracy module against a copied workspace and retain gold-only evaluation. */
import { evaluateExperimentVersion } from "@/accuracy/eval/experiment-gold";
import { readAgentProgression } from "@/accuracy/kernel/agent-events";
import type { Actor, CallKind } from "@/accuracy/kernel/contracts";
import { activeAccuracyModule } from "@/accuracy/kernel/registry";
import { runAccuracyModule } from "@/accuracy/kernel/run";
import { newId } from "@/modules/kernel/ids";
import { deleteWorkspace } from "@/accuracy/store/tenant";
import { copyExperimentWorkspace } from "./copy-workspace";
import { createExperiment, finishExperiment, getExperiment, recordExperimentCall, recordVersionEvaluation, type ExperimentRecord } from "./records";

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
const singularIdKeys = new Set(["source_file_id", "block_id", "claim_id", "gap_id", "tactic_id"]);
const pluralIdKeys = new Set(["source_file_ids", "block_ids", "claim_ids", "gap_ids", "tactic_ids"]);

/** Remap workspace-owned input IDs, failing closed when a referenced ID has no copied counterpart. */
function remapExperimentInput(input: Record<string, unknown>, workspace_id: string, maps: IdMaps): Record<string, unknown> {
  const mapId = (key: string, value: string): string => {
    if (key === "source_file_id" || key === "source_file_ids") return maps.source[value] ?? unresolved(key, value);
    if (key === "block_id" || key === "block_ids") return maps.block[value] ?? unresolved(key, value);
    return maps.claim[value] ?? unresolved(key, value);
  };
  const visit = (value: unknown, key?: string): unknown => {
    if (key === "workspace_id") return workspace_id;
    if (typeof value === "string" && key && singularIdKeys.has(key)) return mapId(key, value);
    if (Array.isArray(value)) return value.map((item) => key && pluralIdKeys.has(key)
      ? (typeof item === "string" ? mapId(key, item) : unresolved(key, String(item)))
      : visit(item));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [childKey, visit(child, childKey)]));
    return value;
  };
  return visit(input) as Record<string, unknown>;
}

function unresolved(key: string, value: string): never { throw new Error(`Unresolved copied ${key}: ${value}`); }

/** Execute the supported single-call experiment and persist every output version before returning. */
export async function runAccuracyExperiment(request: AccuracyExperimentRequest): Promise<ExperimentRecord> {
  if (request.mode !== "single_call") throw new Error("Pipeline experiments are not implemented yet.");
  if (!request.call) throw new Error("A single_call experiment requires a call.");
  const copy = await copyExperimentWorkspace({ source_workspace_id: request.source_workspace_id, source_file_ids: request.source_file_ids });
  let input: Record<string, unknown>;
  try {
    input = remapExperimentInput(request.call.input, copy.workspace_id, { source: copy.source_id_map, block: copy.block_id_map, claim: copy.claim_id_map });
  } catch (error) {
    await deleteWorkspace(copy.workspace_id);
    throw error;
  }
  const experiment = await createExperiment({ workspace_id: copy.workspace_id, org_id: copy.org_id, source_workspace_id: request.source_workspace_id,
    pack_id: request.pack_id, source_fingerprint: copy.source_fingerprint, baseline_fingerprint: copy.baseline_fingerprint,
    baseline_snapshot: copy.baseline_snapshot, condition: request.condition });
  const call_id = newId("arun");
  const implementation = await activeAccuracyModule(request.call.call_kind);
  let result: Awaited<ReturnType<typeof runAccuracyModule>>;
  try {
    result = await runAccuracyModule({ call_kind: request.call.call_kind, reserved_run_id: call_id, input, actor: request.actor,
      org_id: copy.org_id, workspace_id: copy.workspace_id, evaluation_context: "experiment" });
  } catch (error) {
    const output_error = error instanceof Error ? error.message : String(error);
    await recordExperimentCall({ workspace_id: copy.workspace_id, experiment_id: experiment.id, call_id, call_kind: request.call.call_kind,
      version_index: 0, input, output_error, module_version: implementation.manifest.version,
      route: { status: "unavailable", reason: "Module did not return a resolved route." } });
    await recordVersionEvaluation({ workspace_id: copy.workspace_id, experiment_id: experiment.id, call_id, version_index: 0,
      evaluation: evaluateExperimentVersion({ pack_id: request.pack_id, call_kind: request.call.call_kind, output: null, output_error }) });
    await finishExperiment({ workspace_id: copy.workspace_id, experiment_id: experiment.id, status: "failed" });
    const failed = await getExperiment({ workspace_id: copy.workspace_id, experiment_id: experiment.id });
    if (!failed) throw new Error("Failed experiment record disappeared before it could be returned.");
    return failed;
  }
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
  const record = await getExperiment({ workspace_id: copy.workspace_id, experiment_id: experiment.id });
  if (!record) throw new Error("Experiment record disappeared before it could be returned.");
  return record;
}
