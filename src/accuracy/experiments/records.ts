/** Append-only, workspace-scoped persistence for isolated gold experiments. */
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { EXPERIMENT_EVALUATOR_VERSION, experimentPackFingerprint, type ExperimentVersionEvaluation } from "@/accuracy/eval/experiment-gold";
import { newId, nowIso } from "@/modules/kernel/ids";
import { accuracyDb, ensureAccuracySchema, withAccuracyTransaction } from "../store/db";
import * as t from "../store/schema";
import { getWorkspace } from "../store/tenant";
import { executionEvidenceFromSteps, type ExecutionEvidence } from "../kernel/execution-identity";
import { readAgentProgression, type AgentEvent } from "../kernel/agent-events";

type ExperimentRow = typeof t.accuracyExperiments.$inferSelect;
type CallRow = typeof t.accuracyExperimentCalls.$inferSelect;
type EvaluationRow = typeof t.accuracyExperimentEvaluations.$inferSelect;
export type ExperimentRecord = ExperimentRow & { calls: CallRow[]; evaluations: EvaluationRow[];
  run_evidence?: { call_id: string; execution_identity: ExecutionEvidence; events: AgentEvent[] }[] };

/** Create a distinct immutable experiment attempt for an isolated workspace. */
export async function createExperiment(args: { workspace_id: string; org_id: string; source_workspace_id: string; pack_id: string; source_fingerprint: string; baseline_fingerprint: string; baseline_snapshot: unknown; condition: Record<string, unknown>; pack_fingerprint?: string }): Promise<ExperimentRow> {
  await ensureAccuracySchema();
  const [workspace, source] = await Promise.all([getWorkspace(args.workspace_id), getWorkspace(args.source_workspace_id)]);
  if (!workspace || workspace.org_id !== args.org_id) throw new Error("Unknown experiment workspace or organization.");
  if (!source) throw new Error("Unknown source workspace for experiment lineage.");
  const row = { id: newId("experiment"), workspace_id: args.workspace_id, org_id: args.org_id, source_workspace_id: args.source_workspace_id, source_org_id: source.org_id,
    pack_id: args.pack_id, pack_fingerprint: experimentPackFingerprint(args.pack_id), evaluator_version: EXPERIMENT_EVALUATOR_VERSION,
    source_fingerprint: args.source_fingerprint, baseline_fingerprint: args.baseline_fingerprint, baseline_snapshot: args.baseline_snapshot,
    condition: args.condition, status: "running", created_at: nowIso(), finished_at: null };
  await accuracyDb().insert(t.accuracyExperiments).values(row); return row;
}

/** Re-copy only the immutable baseline retained by this workspace's experiment owner. */
export async function readWorkspaceBaselineSnapshot(workspace_id: string): Promise<unknown | null> {
  const rows = await accuracyDb().select({ baseline_snapshot: t.accuracyExperiments.baseline_snapshot })
    .from(t.accuracyExperiments).where(eq(t.accuracyExperiments.workspace_id, workspace_id));
  const snapshots = rows.filter(row => row.baseline_snapshot && typeof row.baseline_snapshot === "object" && "managed_history" in row.baseline_snapshot);
  const first = snapshots[0]?.baseline_snapshot ?? null;
  if (snapshots.some(row => JSON.stringify(row.baseline_snapshot) !== JSON.stringify(first))) throw new Error("Ambiguous retained experiment baseline history.");
  return first;
}

/** Lock a running experiment row so append and terminal transitions serialize. */
async function lockRunningExperiment(workspace_id: string, experiment_id: string): Promise<ExperimentRow> {
  const rows = await accuracyDb().select().from(t.accuracyExperiments)
    .where(and(eq(t.accuracyExperiments.workspace_id, workspace_id), eq(t.accuracyExperiments.id, experiment_id)))
    .for("update");
  if (!rows[0]) throw new Error("Unknown experiment for workspace.");
  if (rows[0].status !== "running") throw new Error("Experiment has a terminal status.");
  return rows[0];
}

/** Append one retained model snapshot, including its exact input and route. */
export async function recordExperimentCall(args: { workspace_id: string; experiment_id: string; call_id: string; call_kind: string; version_index: number; input: unknown; output?: unknown; output_error?: string; module_version: string; route: unknown }): Promise<CallRow> {
  await ensureAccuracySchema();
  return withAccuracyTransaction(async () => {
    await lockRunningExperiment(args.workspace_id, args.experiment_id);
    const row = { id: newId("experiment_call"), ...args, recorded_at: nowIso(), output: args.output ?? null, output_error: args.output_error ?? null };
    await accuracyDb().insert(t.accuracyExperimentCalls).values(row); return row;
  });
}

/** Append the gold evaluator result for a previously stored call version. */
export async function recordVersionEvaluation(args: { workspace_id: string; experiment_id: string; call_id: string; version_index: number; evaluation: ExperimentVersionEvaluation }): Promise<EvaluationRow> {
  await ensureAccuracySchema();
  return withAccuracyTransaction(async () => {
    const experiment = await lockRunningExperiment(args.workspace_id, args.experiment_id);
    const call = await accuracyDb().select({ id: t.accuracyExperimentCalls.id, call_kind: t.accuracyExperimentCalls.call_kind }).from(t.accuracyExperimentCalls).where(and(eq(t.accuracyExperimentCalls.workspace_id, args.workspace_id), eq(t.accuracyExperimentCalls.experiment_id, args.experiment_id), eq(t.accuracyExperimentCalls.call_id, args.call_id), eq(t.accuracyExperimentCalls.version_index, args.version_index))).limit(1);
    if (!call[0]) throw new Error("Unknown experiment call version for workspace.");
    if (args.evaluation.evaluator_version !== experiment.evaluator_version) throw new Error("Evaluation evaluator version does not match experiment.");
    if (args.evaluation.pack_id !== experiment.pack_id) throw new Error("Evaluation pack does not match experiment.");
    if (args.evaluation.pack_fingerprint !== experiment.pack_fingerprint) throw new Error("Evaluation pack fingerprint does not match experiment.");
    if (args.evaluation.call_kind !== call[0].call_kind) throw new Error("Evaluation call kind does not match experiment call.");
    const row = { id: newId("experiment_evaluation"), ...args, evaluator_version: args.evaluation.evaluator_version, recorded_at: nowIso() };
    await accuracyDb().insert(t.accuracyExperimentEvaluations).values(row); return row;
  });
}

/** Set the one permitted mutable experiment field: its terminal status. */
export async function finishExperiment(args: { workspace_id: string; experiment_id: string; status: "completed" | "failed" }): Promise<ExperimentRow> {
  await ensureAccuracySchema();
  const [row] = await accuracyDb().update(t.accuracyExperiments).set({ status: args.status, finished_at: nowIso() }).where(and(eq(t.accuracyExperiments.workspace_id, args.workspace_id), eq(t.accuracyExperiments.id, args.experiment_id), eq(t.accuracyExperiments.status, "running"))).returning();
  if (!row) throw new Error("Experiment already has a terminal status or is unknown for workspace.");
  return row;
}

/** Read one experiment and its children, always within the supplied workspace. */
export async function getExperiment(args: { workspace_id: string; experiment_id: string }): Promise<ExperimentRecord | null> {
  await ensureAccuracySchema(); const rows = await accuracyDb().select().from(t.accuracyExperiments).where(and(eq(t.accuracyExperiments.workspace_id, args.workspace_id), eq(t.accuracyExperiments.id, args.experiment_id))).limit(1); const row = rows[0];
  if (!row) return null;
  const [calls, evaluations] = await Promise.all([
    accuracyDb().select().from(t.accuracyExperimentCalls).where(and(eq(t.accuracyExperimentCalls.workspace_id, args.workspace_id), eq(t.accuracyExperimentCalls.experiment_id, row.id))).orderBy(asc(t.accuracyExperimentCalls.recorded_at), asc(t.accuracyExperimentCalls.call_id), asc(t.accuracyExperimentCalls.version_index), asc(t.accuracyExperimentCalls.id)),
    accuracyDb().select().from(t.accuracyExperimentEvaluations).where(and(eq(t.accuracyExperimentEvaluations.workspace_id, args.workspace_id), eq(t.accuracyExperimentEvaluations.experiment_id, row.id))).orderBy(asc(t.accuracyExperimentEvaluations.recorded_at), asc(t.accuracyExperimentEvaluations.call_id), asc(t.accuracyExperimentEvaluations.version_index), asc(t.accuracyExperimentEvaluations.id)),
  ]);
  const callIds = [...new Set(calls.map(call => call.call_id))];
  const runs = callIds.length ? await accuracyDb().select({ id: t.accuracyModuleRuns.id, steps: t.accuracyModuleRuns.steps })
    .from(t.accuracyModuleRuns).where(and(eq(t.accuracyModuleRuns.workspace_id, args.workspace_id), inArray(t.accuracyModuleRuns.id, callIds))) : [];
  const preparations = callIds.length ? await accuracyDb().select({ run_id: t.accuracyResumeJournals.merge_operation_id, evidence: t.accuracyResumeJournals.prepared_merge })
    .from(t.accuracyResumeJournals).where(and(eq(t.accuracyResumeJournals.workspace_id, args.workspace_id), inArray(t.accuracyResumeJournals.merge_operation_id, callIds))) : [];
  const run_evidence = await Promise.all(callIds.map(async call_id => {
    const runtime = runs.find(run => run.id === call_id);
    const progression = runtime ? await readAgentProgression({ workspace_id: args.workspace_id, run_id: call_id }) : null;
    const preparation = preparations.find(row => row.run_id === call_id)?.evidence as { steps?: unknown } | null | undefined;
    return { call_id, execution_identity: executionEvidenceFromSteps(runtime?.steps ?? preparation?.steps), events: progression?.events.map(row => row.event) ?? [] };
  }));
  return { ...row, calls, evaluations, run_evidence };
}

/** Read an experiment from the original workspace boundary, never from its private copy ID. */
export async function getExperimentForSourceWorkspace(args: { source_workspace_id: string; experiment_id: string }): Promise<ExperimentRecord | null> {
  await ensureAccuracySchema();
  const rows = await accuracyDb().select({ workspace_id: t.accuracyExperiments.workspace_id })
    .from(t.accuracyExperiments)
    .where(and(
      eq(t.accuracyExperiments.source_workspace_id, args.source_workspace_id),
      eq(t.accuracyExperiments.id, args.experiment_id),
    ))
    .limit(1);
  const row = rows[0];
  return row ? getExperiment({ workspace_id: row.workspace_id, experiment_id: args.experiment_id }) : null;
}

/** Export complete workspace-scoped records in deterministic JSON or JSONL order. */
export async function exportExperiments(args: { workspace_id: string; format: "json" | "jsonl" }): Promise<string> {
  await ensureAccuracySchema(); const rows = await accuracyDb().select({ id: t.accuracyExperiments.id }).from(t.accuracyExperiments).where(eq(t.accuracyExperiments.workspace_id, args.workspace_id)).orderBy(desc(t.accuracyExperiments.created_at), asc(t.accuracyExperiments.id));
  const records = (await Promise.all(rows.map((row) => getExperiment({ workspace_id: args.workspace_id, experiment_id: row.id })))).filter((row): row is ExperimentRecord => row !== null);
  return args.format === "json" ? JSON.stringify(records) : records.map((row) => JSON.stringify(row)).join("\n") + (records.length ? "\n" : "");
}

/** Export all complete records tied to one original workspace in stable order. */
export async function exportExperimentsForSourceWorkspace(args: { source_workspace_id: string; format: "json" | "jsonl" }): Promise<string> {
  const records = await listExperimentsForSourceWorkspace({ source_workspace_id: args.source_workspace_id });
  return args.format === "json" ? JSON.stringify(records) : records.map((row) => JSON.stringify(row)).join("\n") + (records.length ? "\n" : "");
}

/** List retained attempts and children by original source, in stable newest-first order. */
export async function listExperimentsForSourceWorkspace(args: { source_workspace_id: string }): Promise<ExperimentRecord[]> {
  await ensureAccuracySchema();
  const rows = await accuracyDb().select({ id: t.accuracyExperiments.id, workspace_id: t.accuracyExperiments.workspace_id })
    .from(t.accuracyExperiments)
    .where(eq(t.accuracyExperiments.source_workspace_id, args.source_workspace_id))
    .orderBy(desc(t.accuracyExperiments.created_at), asc(t.accuracyExperiments.id));
  const records = (await Promise.all(rows.map((row) => getExperiment({ workspace_id: row.workspace_id, experiment_id: row.id }))))
    .filter((row): row is ExperimentRecord => row !== null);
  return records;
}
