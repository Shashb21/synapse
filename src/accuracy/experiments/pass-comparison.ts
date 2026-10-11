/** Run independent controlled-pass attempts and read comparisons through source scope. */
import { comparisonRequestFingerprint, evaluatePassComparison, PASS_COMPARISON_EVALUATOR_VERSION, type ComparisonEvidence, type PassComparison } from "@/accuracy/eval/pass-comparison";
import { readAgentProgression } from "@/accuracy/kernel/agent-events";
import { validateExperimentCycleControl, type RunStatus } from "@/accuracy/kernel/contracts";
import { reservedAccuracyRun } from "@/accuracy/kernel/observability";
import { executionEvidenceFromSteps } from "@/accuracy/kernel/execution-identity";
import { newId } from "@/modules/kernel/ids";
import { exportExperimentsForSourceWorkspace, getExperimentForSourceWorkspace, type ExperimentRecord } from "./records";
import { runAccuracyExperiment, type AccuracyExperimentRequest } from "./run";

export const PASS_COMPARISON_RESERVED_CONDITION_FIELDS = ["comparison_id", "comparison_evaluator_version", "original_request_identity", "original_request_fingerprint", "critic_revision_passes", "experiment_cycle_control"] as const;

/** Invalid client-owned cohort controls, rejected before any workspace copy. */
export class PassComparisonValidationError extends Error {
  constructor(message: string) { super(message); this.name = "PassComparisonValidationError"; }
}

/** Uniform missing/scoped-out response that does not reveal another workspace. */
export class PassComparisonNotFoundError extends Error {
  constructor() { super("Pass comparison experiments were not found in this source workspace."); this.name = "PassComparisonNotFoundError"; }
}

/** Load stored runtime and progression evidence for already source-scoped attempts. */
export async function loadPassComparisonEvidence(experiments: ExperimentRecord[]): Promise<ComparisonEvidence[]> {
  return Promise.all(experiments.map(async experiment => {
    const runs = await Promise.all([...new Set(experiment.calls.map(call => call.call_id))].map(async call_id => {
      const runtime = await reservedAccuracyRun(experiment.workspace_id, call_id);
      if (!runtime) return null;
      const progression = await readAgentProgression({ workspace_id: experiment.workspace_id, run_id: call_id });
      return { call_id, module_id: runtime.module_id, module_version: runtime.module_version, route: runtime.route, status: runtime.status as RunStatus,
        duration_ms: runtime.duration_ms, cost_usd: runtime.cost_usd === null ? null : Number(runtime.cost_usd),
        token_usage: runtime.token_usage as ComparisonEvidence["runs"][number]["token_usage"], events: progression?.events.map(row => row.event) ?? [],
        execution_identity: executionEvidenceFromSteps(runtime.steps) };
    }));
    return { experiment, runs: runs.filter((run): run is NonNullable<typeof run> => run !== null) };
  }));
}

/** Execute one-, two-, then three-pass experiments, retaining every available attempt. */
export async function runPassComparison(request: AccuracyExperimentRequest): Promise<{ comparison_id: string; experiments: ExperimentRecord[]; comparison: PassComparison }> {
  const reserved = PASS_COMPARISON_RESERVED_CONDITION_FIELDS.find(key => Object.hasOwn(request.condition, key));
  if (reserved) throw new PassComparisonValidationError(`Client condition must not supply reserved control: ${reserved}.`);
  try {
    validateExperimentCycleControl({ critic_revision_passes: 1 }, "experiment", request.mode === "single_call" ? request.call?.call_kind : undefined);
    if (request.mode === "single_call" && !request.call) throw new Error("A single_call comparison requires an extraction call.");
  } catch (error) {
    throw new PassComparisonValidationError(error instanceof Error ? error.message : "Invalid controlled comparison request.");
  }
  const comparison_id = newId("comparison");
  const original_request_identity = { ...request };
  const original_request_fingerprint = comparisonRequestFingerprint(original_request_identity);
  let experiments: ExperimentRecord[] = [];
  for (const critic_revision_passes of [1, 2, 3] as const) {
    try {
      experiments.push(await runAccuracyExperiment({ ...request, condition: { ...request.condition, comparison_id, comparison_evaluator_version: PASS_COMPARISON_EVALUATOR_VERSION,
        original_request_identity, original_request_fingerprint, critic_revision_passes } }));
    } catch (error) {
      // Persistence failures can throw after creating an attempt. Recover only the
      // existing append-only records; never delete them or create a second journal.
      const retained = JSON.parse(await exportExperimentsForSourceWorkspace({ source_workspace_id: request.source_workspace_id, format: "json" })) as ExperimentRecord[];
      experiments = retained.filter(row => (row.condition as Record<string, unknown>).comparison_id === comparison_id)
        .sort((a, b) => Number((a.condition as Record<string, unknown>).critic_revision_passes) - Number((b.condition as Record<string, unknown>).critic_revision_passes));
      if (!experiments.length) throw error;
      break;
    }
  }
  return { comparison_id, experiments, comparison: evaluatePassComparison(await loadPassComparisonEvidence(experiments)) };
}

/** Recompute a versioned comparison after validating every ID against source scope. */
export async function readPassComparison(args: { source_workspace_id: string; experiment_ids: string[] }): Promise<PassComparison> {
  if (!args.experiment_ids.length || args.experiment_ids.length > 3) throw new PassComparisonValidationError("Supply between one and three experiment IDs.");
  const experiments = await Promise.all(args.experiment_ids.map(experiment_id => getExperimentForSourceWorkspace({ source_workspace_id: args.source_workspace_id, experiment_id })));
  if (experiments.some(row => row === null)) throw new PassComparisonNotFoundError();
  return evaluatePassComparison(await loadPassComparisonEvidence(experiments as ExperimentRecord[]));
}
