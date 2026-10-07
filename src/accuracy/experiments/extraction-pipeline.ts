/** Execute the existing extraction batch workflow inside an isolated experiment copy. */
import { evaluateExperimentVersion } from "@/accuracy/eval/experiment-gold";
import { readAgentProgression } from "@/accuracy/kernel/agent-events";
import type { Actor, CallKind, ExperimentCycleControl } from "@/accuracy/kernel/contracts";
import { activeAccuracyModule } from "@/accuracy/kernel/registry";
import { runAccuracyModule, type AccuracyRunResult, type PreparedAccuracyMerge } from "@/accuracy/kernel/run";
import { reservedAccuracyRun } from "@/accuracy/kernel/observability";
import type { MergeDedupeOutput } from "@/accuracy/modules/merge-dedupe/module";
import type { StatusDeriveOutput } from "@/accuracy/modules/status-derive/module";
import { resumeExtractionBatch, ExtractionBatchError } from "@/accuracy/store/extraction-batch-store";
import { AccuracyPausedError } from "@/accuracy/kernel/omission-pause";
import { assertAccuracyCanProgress } from "@/accuracy/kernel/omission-pause";
import { getExperiment, recordExperimentCall, recordVersionEvaluation } from "./records";
import { newId } from "@/modules/kernel/ids";

import { extractSourcePages, type SourceExtractOutput } from "@/accuracy/store/source-extraction";

export type PipelineExperimentContext = {
  workspace_id: string;
  org_id: string;
  experiment_id: string;
  pack_id: string;
  actor: Actor;
  experiment_cycle_control?: ExperimentCycleControl;
};

/** Shared merge/status tail used after an applied extraction batch has reserved its journal IDs. */
export async function runExtractionDownstream(args: { workspace_id: string; org_id: string; actor: Actor; merge_id: string; status_id: string; prepared_merge?: PreparedAccuracyMerge }) {
  const merge = await runAccuracyModule<MergeDedupeOutput>({ call_kind: "merge_dedupe", agent_role: "judge", input: { workspace_id: args.workspace_id },
    actor: args.actor, org_id: args.org_id, workspace_id: args.workspace_id, reserved_run_id: args.merge_id, prepared_merge: args.prepared_merge });
  const status = await runAccuracyModule<StatusDeriveOutput>({ call_kind: "status_derive", agent_role: "none", input: { workspace_id: args.workspace_id },
    actor: args.actor, org_id: args.org_id, workspace_id: args.workspace_id, reserved_run_id: args.status_id });
  return { merge, status, runs: [{ call_kind: "merge_dedupe", run_id: merge.run_id, summary: merge.summary, count: merge.output.merged },
    { call_kind: "status_derive", run_id: status.run_id, summary: status.summary, count: status.output.statuses.length }] };
}

/** Complete a retained version without duplicating rows after a partial write. */
async function retainVersion(args: PipelineExperimentContext & {
  call_kind: CallKind; input: Record<string, unknown>; call_id: string; version_index: number;
  output?: unknown; output_error?: string; module_version: string; route: unknown;
}) {
  const existing = await getExperiment(args);
  const call = existing?.calls.find(row => row.call_id === args.call_id && row.version_index === args.version_index)
    ?? await recordExperimentCall({ workspace_id: args.workspace_id, experiment_id: args.experiment_id,
      call_id: args.call_id, call_kind: args.call_kind, version_index: args.version_index, input: args.input,
      output: args.output, output_error: args.output_error, module_version: args.module_version, route: args.route });
  if (!existing?.evaluations.some(row => row.call_id === args.call_id && row.version_index === args.version_index)) {
    await recordVersionEvaluation({ workspace_id: args.workspace_id, experiment_id: args.experiment_id, call_id: args.call_id,
      version_index: args.version_index, evaluation: evaluateExperimentVersion({ pack_id: args.pack_id, call_kind: args.call_kind,
        output: call.output, ...(call.output_error ? { output_error: call.output_error } : {}) }) });
  }
}

/** Retain every available module snapshot before allowing the workflow to advance. */
async function retainResult(args: PipelineExperimentContext & { call_kind: CallKind; input: Record<string, unknown>; result: AccuracyRunResult<unknown> }) {
  const progression = await readAgentProgression({ workspace_id: args.workspace_id, run_id: args.result.run_id });
  const snapshots = progression?.events.flatMap(event => event.event.event_type === "snapshot" ? [event.event.output] : []) ?? [];
  const outputs = snapshots.length ? snapshots : [args.result.output];
  for (const [version_index, output] of outputs.entries()) {
    await retainVersion({ ...args, call_id: args.result.run_id, version_index, output,
      module_version: args.result.module_version, route: args.result.route });
  }
}

/** Retain an error under the reserved stage identity, even if preparation has not opened a run. */
async function retainFailure(args: PipelineExperimentContext & { call_kind: CallKind; input: Record<string, unknown>; call_id: string; error: unknown }) {
  const implementation = await activeAccuracyModule(args.call_kind);
  const output_error = args.error instanceof Error ? args.error.message : String(args.error);
  const failedRun = await reservedAccuracyRun(args.workspace_id, args.call_id);
  const progression = await readAgentProgression({ workspace_id: args.workspace_id, run_id: args.call_id });
  const snapshots = progression?.events.flatMap(event => event.event.event_type === "snapshot" ? [event.event.output] : []) ?? [];
  const retained = await getExperiment(args);
  const calls = retained?.calls.filter(call => call.call_id === args.call_id) ?? [];
  const module_version = failedRun?.module_version ?? calls[0]?.module_version ?? implementation.manifest.version;
  const route = failedRun?.route ?? calls[0]?.route ?? { status: "unavailable" };
  for (const [version_index, output] of snapshots.entries()) {
    await retainVersion({ ...args, version_index, output, module_version, route });
  }
  // A non-agentic final output may already exist when its evaluation write fails.
  for (const call of calls) {
    await retainVersion({ ...args, version_index: call.version_index, output: call.output, module_version, route });
  }
  const errorVersion = Math.max(snapshots.length, ...calls.map(call => call.version_index + 1));
  await retainVersion({ ...args, version_index: errorVersion, output_error, module_version, route });
}

async function runAndRetain<O>(context: PipelineExperimentContext, call_kind: CallKind, input: Record<string, unknown>, reserved_run_id?: string, retain = true, prepared_merge?: PreparedAccuracyMerge): Promise<AccuracyRunResult<O>> {
  const call_id = reserved_run_id ?? newId("arun");
  try {
    const result = await runAccuracyModule<O>({ call_kind, input, actor: context.actor, org_id: context.org_id, workspace_id: context.workspace_id,
      reserved_run_id: call_id, prepared_merge, agent_role: call_kind === "merge_dedupe" ? "judge" : call_kind === "status_derive" ? "none" : "proposer", evaluation_context: "experiment",
      ...((call_kind === "inventory_extract" || call_kind === "need_extract") ? { experiment_cycle_control: context.experiment_cycle_control } : {}) });
    if (retain) await retainResult({ ...context, call_kind, input, result });
    return result;
  } catch (error) {
    if (retain) await retainFailure({ ...context, call_kind, input, call_id, error });
    throw error;
  }
}

/** Run inventory, needs, merge, and status for one copied source using the production batch journal. */
export async function runExtractionPipelineForSource(context: PipelineExperimentContext, source_file_id: string): Promise<void> {
  const extracted = await extractSourcePages({ workspace_id: context.workspace_id, source_file_id, kinds: ["inventory_extract", "need_extract"],
    run: (kind, input, run_id) => runAndRetain<SourceExtractOutput>(context, kind, input, run_id) });
  const batch = extracted.batch;
  if (extracted.failure) throw extracted.failure;
  if (!batch.source_progress?.complete) throw new ExtractionBatchError("source_incomplete", "Declared source pages or upstream parse units are incomplete.");
  const downstream: { current: { call_kind: "merge_dedupe" | "status_derive"; input: Record<string, unknown>; call_id: string } | null; merge: AccuracyRunResult<MergeDedupeOutput> | null; status: AccuracyRunResult<StatusDeriveOutput> | null } = { current: null, merge: null, status: null };
  try {
    await resumeExtractionBatch({ workspace_id: context.workspace_id, source_file_id, batch_id: batch.id, merge_context: { org_id: context.org_id, actor: context.actor, evaluation_context: "experiment" },
      onMergePreparation: journal => {
        downstream.current = { call_kind: "merge_dedupe", input: { workspace_id: context.workspace_id }, call_id: journal.merge_operation_id };
      }, execute: async (_batch, journal, prepared) => {
      await assertAccuracyCanProgress(context.workspace_id, "merge_dedupe");
      downstream.current = { call_kind: "merge_dedupe", input: { workspace_id: context.workspace_id }, call_id: journal.merge_operation_id };
      downstream.merge = await runAndRetain<MergeDedupeOutput>(context, downstream.current.call_kind, downstream.current.input, downstream.current.call_id, false, prepared);
      downstream.current = { call_kind: "status_derive", input: { workspace_id: context.workspace_id }, call_id: journal.status_operation_id };
      downstream.status = await runAndRetain<StatusDeriveOutput>(context, downstream.current.call_kind, downstream.current.input, downstream.current.call_id, false);
      return { source_file_id, batch_id: batch.id };
    } });
    if (downstream.merge) await retainResult({ ...context, call_kind: "merge_dedupe", input: { workspace_id: context.workspace_id }, result: downstream.merge });
    if (downstream.status) await retainResult({ ...context, call_kind: "status_derive", input: { workspace_id: context.workspace_id }, result: downstream.status });
  } catch (error) {
    // resumeExtractionBatch rolls back its callback as one downstream unit. Keep
    // successfully computed stage evidence after that rollback, before returning
    // a pause or failure to the experiment runner.
    if (downstream.merge) await retainResult({ ...context, call_kind: "merge_dedupe", input: { workspace_id: context.workspace_id }, result: downstream.merge });
    if (error instanceof AccuracyPausedError) throw error;
    const failedStage = downstream.current;
    if (failedStage) await retainFailure({ ...context, call_kind: failedStage.call_kind, input: failedStage.input, call_id: failedStage.call_id, error });
    throw error;
  }
}

/** Run the selected copied sources in deterministic caller order. */
export async function runExtractionPipeline(context: PipelineExperimentContext, source_file_ids: string[]): Promise<void> {
  for (const source_file_id of source_file_ids) await runExtractionPipelineForSource(context, source_file_id);
}
