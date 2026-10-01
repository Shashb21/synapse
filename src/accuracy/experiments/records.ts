/** Append-only, workspace-scoped persistence for isolated gold experiments. */
import { and, asc, desc, eq } from "drizzle-orm";
import { EXPERIMENT_EVALUATOR_VERSION, experimentPackFingerprint, type ExperimentVersionEvaluation } from "@/accuracy/eval/experiment-gold";
import { newId, nowIso } from "@/modules/kernel/ids";
import { accuracyDb, ensureAccuracySchema } from "../store/db";
import * as t from "../store/schema";
import { getWorkspace } from "../store/tenant";

type ExperimentRow = typeof t.accuracyExperiments.$inferSelect;
type CallRow = typeof t.accuracyExperimentCalls.$inferSelect;
type EvaluationRow = typeof t.accuracyExperimentEvaluations.$inferSelect;
export type ExperimentRecord = ExperimentRow & { calls: CallRow[]; evaluations: EvaluationRow[] };

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

async function requireExperiment(workspace_id: string, experiment_id: string): Promise<ExperimentRow> {
  const rows = await accuracyDb().select().from(t.accuracyExperiments).where(and(eq(t.accuracyExperiments.workspace_id, workspace_id), eq(t.accuracyExperiments.id, experiment_id))).limit(1);
  if (!rows[0]) throw new Error("Unknown experiment for workspace."); return rows[0];
}

/** Append one retained model snapshot, including its exact input and route. */
export async function recordExperimentCall(args: { workspace_id: string; experiment_id: string; call_id: string; call_kind: string; version_index: number; input: unknown; output?: unknown; output_error?: string; module_version: string; route: unknown }): Promise<CallRow> {
  await ensureAccuracySchema(); const experiment = await requireExperiment(args.workspace_id, args.experiment_id);
  if (experiment.status !== "running") throw new Error("Experiment has a terminal status.");
  const row = { id: newId("experiment_call"), ...args, recorded_at: nowIso(), output: args.output ?? null, output_error: args.output_error ?? null };
  await accuracyDb().insert(t.accuracyExperimentCalls).values(row); return row;
}

/** Append the gold evaluator result for a previously stored call version. */
export async function recordVersionEvaluation(args: { workspace_id: string; experiment_id: string; call_id: string; version_index: number; evaluation: ExperimentVersionEvaluation }): Promise<EvaluationRow> {
  await ensureAccuracySchema(); const experiment = await requireExperiment(args.workspace_id, args.experiment_id);
  if (experiment.status !== "running") throw new Error("Experiment has a terminal status.");
  const call = await accuracyDb().select({ id: t.accuracyExperimentCalls.id, call_kind: t.accuracyExperimentCalls.call_kind }).from(t.accuracyExperimentCalls).where(and(eq(t.accuracyExperimentCalls.workspace_id, args.workspace_id), eq(t.accuracyExperimentCalls.experiment_id, args.experiment_id), eq(t.accuracyExperimentCalls.call_id, args.call_id), eq(t.accuracyExperimentCalls.version_index, args.version_index))).limit(1);
  if (!call[0]) throw new Error("Unknown experiment call version for workspace.");
  if (args.evaluation.evaluator_version !== experiment.evaluator_version) throw new Error("Evaluation evaluator version does not match experiment.");
  if (args.evaluation.pack_id !== experiment.pack_id) throw new Error("Evaluation pack does not match experiment.");
  if (args.evaluation.pack_fingerprint !== experiment.pack_fingerprint) throw new Error("Evaluation pack fingerprint does not match experiment.");
  if (args.evaluation.call_kind !== call[0].call_kind) throw new Error("Evaluation call kind does not match experiment call.");
  const row = { id: newId("experiment_evaluation"), ...args, evaluator_version: args.evaluation.evaluator_version, recorded_at: nowIso() };
  await accuracyDb().insert(t.accuracyExperimentEvaluations).values(row); return row;
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
    accuracyDb().select().from(t.accuracyExperimentCalls).where(and(eq(t.accuracyExperimentCalls.workspace_id, args.workspace_id), eq(t.accuracyExperimentCalls.experiment_id, row.id))).orderBy(asc(t.accuracyExperimentCalls.recorded_at), asc(t.accuracyExperimentCalls.version_index)),
    accuracyDb().select().from(t.accuracyExperimentEvaluations).where(and(eq(t.accuracyExperimentEvaluations.workspace_id, args.workspace_id), eq(t.accuracyExperimentEvaluations.experiment_id, row.id))).orderBy(asc(t.accuracyExperimentEvaluations.recorded_at), asc(t.accuracyExperimentEvaluations.version_index)),
  ]);
  return { ...row, calls, evaluations };
}

/** Export complete workspace-scoped records in deterministic JSON or JSONL order. */
export async function exportExperiments(args: { workspace_id: string; format: "json" | "jsonl" }): Promise<string> {
  await ensureAccuracySchema(); const rows = await accuracyDb().select({ id: t.accuracyExperiments.id }).from(t.accuracyExperiments).where(eq(t.accuracyExperiments.workspace_id, args.workspace_id)).orderBy(desc(t.accuracyExperiments.created_at), asc(t.accuracyExperiments.id));
  const records = (await Promise.all(rows.map((row) => getExperiment({ workspace_id: args.workspace_id, experiment_id: row.id })))).filter((row): row is ExperimentRecord => row !== null);
  return args.format === "json" ? JSON.stringify(records) : records.map((row) => JSON.stringify(row)).join("\n") + (records.length ? "\n" : "");
}
