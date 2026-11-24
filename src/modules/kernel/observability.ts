/** Persist module runs and project their traces for workspace readers. */
import { HISTORICAL_FAILURE_MESSAGE, projectFailureDiagnostics, projectRunSteps } from "./failure-presentation";
import { and, asc, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { currentSchemaName, withIndependentAdvisoryLock, withWorkspaceTransaction } from "@/lib/iegp/db";
import { DEFAULT_WORKSPACE_ID, scopedWorkspaceId } from "@/modules/workspaces/context";
import { db, ensurePlatformSchema } from "./db";
import * as t from "./schema";
import { newId, nowIso } from "./ids";
import type {
  Actor,
  EvalScore,
  ResolvedRoute,
  RunHandle,
  RunStatus,
  RunStep,
  StageId,
} from "./contracts";

export type RunRecord = {
  id: string;
  workspace_id: string;
  stage: StageId;
  module_id: string;
  module_version: string;
  status: RunStatus;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  actor: Actor;
  summary: string | null;
  error: string | null;
  input: unknown;
  output: unknown;
  steps: RunStep[];
  route: ResolvedRoute | null;
  evals: EvalScore[];
};

/** Bounded so a run row never grows without limit. */
const MAX_STEP_BYTES = 40_000;
/**
 * A run's input and output are read back by the app (the mapping table reads the
 * latest S4 output), so they get a far larger bound than trace steps: a real plan's
 * S4 output is tens of kilobytes and must never be cut to a preview (KAN-68).
 */
const MAX_IO_BYTES = 2_000_000;

function trim(data: unknown, max = MAX_STEP_BYTES): unknown {
  if (data === undefined) return null;
  const json = JSON.stringify(data) ?? "null";
  if (json.length <= max) return data;
  return { truncated: true, bytes: json.length, preview: json.slice(0, 2_000) };
}

/** Collect the steps and timing for one module run. */
export class RunRecorder implements RunHandle {
  readonly id: string;
  private readonly collected: RunStep[] = [];
  private readonly startedAtMs = Date.now();

  constructor(
    readonly meta: {
      workspace_id: string;
      stage: StageId;
      module_id: string;
      module_version: string;
      actor: Actor;
      input: unknown;
    },
    id?: string,
  ) {
    this.id = id ?? newId("run");
  }

  get workspace_id(): string {
    return this.meta.workspace_id;
  }

  /** The original start time, also used when recording a rolled-back run. */
  get started_at(): string {
    return new Date(this.startedAtMs).toISOString();
  }

  async step<T>(name: string, fn: () => Promise<T> | T, detail?: string): Promise<T> {
    const began = Date.now();
    try {
      const value = await fn();
      this.collected.push({
        name,
        at: nowIso(),
        duration_ms: Date.now() - began,
        detail: detail ?? null,
        data: trim(value),
      });
      return value;
    } catch (error) {
      this.collected.push({
        name,
        at: nowIso(),
        duration_ms: Date.now() - began,
        detail: detail ?? null,
        data: {
          error: error instanceof Error ? error.message : String(error),
          // A failed model call is still kept whole; the step names it (KAN-91).
          ...(error && typeof error === "object" && "llm_call_id" in error ? { llm_call_id: (error as { llm_call_id: unknown }).llm_call_id } : {}),
        },
      });
      throw error;
    }
  }

  note(name: string, data?: unknown, detail?: string) {
    this.collected.push({
      name,
      at: nowIso(),
      duration_ms: null,
      detail: detail ?? null,
      data: trim(data),
    });
  }

  steps(): RunStep[] {
    return [...this.collected];
  }

  elapsedMs(): number {
    return Date.now() - this.startedAtMs;
  }
}

/** Create the run before starting setup so failures have a trace. */
export async function openRun(recorder: RunRecorder) {
  await ensurePlatformSchema();
  await db()
    .insert(t.moduleRuns)
    .values({
      id: recorder.id,
      workspace_id: recorder.meta.workspace_id,
      stage: recorder.meta.stage,
      module_id: recorder.meta.module_id,
      module_version: recorder.meta.module_version,
      status: "running",
      started_at: recorder.started_at,
      actor_name: recorder.meta.actor.name,
      actor_function: recorder.meta.actor.function,
      input: trim(recorder.meta.input, MAX_IO_BYTES),
      steps: [],
    });
}

/**
 * Keep ownership of this running row through execution and its workspace
 * commit. The operator skips the locked row even on self-hosted Next.js.
 */
export async function withRunningRun<T>(recorder: RunRecorder, execute: () => Promise<T>): Promise<T> {
  return withWorkspaceTransaction(async () => {
    const [row] = await db().select({ id: t.moduleRuns.id }).from(t.moduleRuns)
      .where(runningRun(recorder)).for("update");
    if (!row) throw new Error("The module run is already finalized.");
    return execute();
  });
}

export const SOURCE_COMPARISON_MODULE = "incoming-source-comparison";

function comparisonRunLock(schema: string, id: string): string {
  return `source-comparison-run:${schema}:${id}`;
}

/** Keep a source comparison recoverable while it awaits a model outside workspace transactions. */
export async function withRunningSourceComparison<T>(recorder: RunRecorder, execute: () => Promise<T>): Promise<T> {
  const schema = await currentSchemaName();
  return withIndependentAdvisoryLock(comparisonRunLock(schema, recorder.id), async () => {
    const [row] = await db().select({ id: t.moduleRuns.id }).from(t.moduleRuns).where(runningRun(recorder));
    if (!row) throw new Error("The module run is already finalized.");
    return execute();
  });
}

function runningRun(recorder: RunRecorder) {
  return and(
    eq(t.moduleRuns.id, recorder.id),
    eq(t.moduleRuns.workspace_id, recorder.workspace_id),
    eq(t.moduleRuns.status, "running"),
  );
}

/** Preserve the first terminal result, including across concurrent recovery. */
export async function closeRun(args: {
  recorder: RunRecorder;
  status: Exclude<RunStatus, "running">;
  summary?: string;
  output?: unknown;
  error?: string;
  route?: ResolvedRoute | null;
  evals?: EvalScore[];
}) {
  await db()
    .update(t.moduleRuns)
    .set({
      status: args.status,
      finished_at: nowIso(),
      duration_ms: args.recorder.elapsedMs(),
      summary: args.summary ?? null,
      error: args.error ?? null,
      output: trim(args.output, MAX_IO_BYTES),
      steps: args.recorder.steps(),
      route: args.route ?? null,
      evals: args.evals ?? [],
    })
    .where(runningRun(args.recorder));
}

/** Longer than the 300-second host limit, including deployment drain slack. */
const RUN_RECOVERY_AGE_MS = 10 * 60_000;
const MAX_RECOVERY_ROWS = 100;
const INGESTION_STAGES = ["S0", "S1", "S2", "S3", "S4"];

/**
 * Recover overdue, unlocked traces from the operator's current schema.
 * Return after one bounded batch and leave successful and active rows alone.
 */
export async function recoverInterruptedRuns(id?: string): Promise<void> {
  await ensurePlatformSchema();
  const schema = await currentSchemaName();
  // Named schemas predate reliable workspace ID stamping. Their old rows can
  // say "default", but their schema still identifies their actual workspace.
  const workspaceId = await scopedWorkspaceId() ?? DEFAULT_WORKSPACE_ID;
  const workspaceIds = schema === "public" ? [workspaceId] : [workspaceId, DEFAULT_WORKSPACE_ID];
  const now = new Date();
  const expired = and(
    inArray(t.moduleRuns.workspace_id, workspaceIds),
    eq(t.moduleRuns.status, "running"),
    lt(t.moduleRuns.started_at, new Date(now.getTime() - RUN_RECOVERY_AGE_MS).toISOString()),
    id === undefined ? undefined : eq(t.moduleRuns.id, id),
  );
  await withWorkspaceTransaction(async () => {
    const rows = await db().select({ id: t.moduleRuns.id, stage: t.moduleRuns.stage, module: t.moduleRuns.module_id }).from(t.moduleRuns)
      .where(expired).orderBy(asc(t.moduleRuns.started_at), asc(t.moduleRuns.id))
      .limit(id === undefined ? MAX_RECOVERY_ROWS : 1).for("update", { skipLocked: true });
    let recoverable = rows;
    if (rows.some((row) => INGESTION_STAGES.includes(row.stage))) {
      // Respect the pre-existing lock for ingestion rows opened before
      // module runs held their own row lock. A try-lock never waits for work.
      const [ingest] = await db().execute(sql`
        select pg_try_advisory_xact_lock(hashtextextended(${`ingest:${schema}`}, 0)) as locked
      `);
      if (!ingest?.locked) recoverable = rows.filter((row) => !INGESTION_STAGES.includes(row.stage));
    }
    const unlockedIds: string[] = [];
    for (const row of recoverable) {
      if (row.module === SOURCE_COMPARISON_MODULE) {
        const [lock] = await db().execute(sql`
          select pg_try_advisory_xact_lock(hashtextextended(${comparisonRunLock(schema, row.id)}, 0)) as locked
        `);
        if (!lock?.locked) continue;
      }
      unlockedIds.push(row.id);
    }
    if (unlockedIds.length === 0) return;
    await db().update(t.moduleRuns).set({
      status: "error",
      error: "Module run ended without a terminal record.",
      finished_at: now.toISOString(),
      // Elapsed time at interruption is unknown.
    }).where(and(expired, inArray(t.moduleRuns.id, unlockedIds)));
  });
}

function toRecord(row: typeof t.moduleRuns.$inferSelect): RunRecord {
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    stage: row.stage as StageId,
    module_id: row.module_id,
    module_version: row.module_version,
    status: row.status as RunStatus,
    started_at: row.started_at,
    finished_at: row.finished_at,
    duration_ms: row.duration_ms,
    actor: { name: row.actor_name, function: row.actor_function as Actor["function"] },
    summary: row.status === "error" ? HISTORICAL_FAILURE_MESSAGE : row.summary,
    error: row.error === null ? null : HISTORICAL_FAILURE_MESSAGE,
    input: projectFailureDiagnostics(row.input),
    output: projectFailureDiagnostics(row.output),
    steps: projectRunSteps((row.steps as RunStep[]) ?? [], row.status === "error"),
    route: projectFailureDiagnostics(row.route) as ResolvedRoute | null,
    evals: projectFailureDiagnostics(row.evals ?? []) as EvalScore[],
  };
}

export async function listRuns(args?: { stage?: StageId; limit?: number }): Promise<RunRecord[]> {
  await ensurePlatformSchema();
  const base = db().select().from(t.moduleRuns);
  const rows = args?.stage
    ? await base.where(eq(t.moduleRuns.stage, args.stage)).orderBy(desc(t.moduleRuns.started_at)).limit(args?.limit ?? 50)
    : await base.orderBy(desc(t.moduleRuns.started_at)).limit(args?.limit ?? 50);
  return rows.map(toRecord);
}

export async function getRun(id: string): Promise<RunRecord | null> {
  await ensurePlatformSchema();
  const rows = await db().select().from(t.moduleRuns).where(eq(t.moduleRuns.id, id)).limit(1);
  return rows[0] ? toRecord(rows[0]) : null;
}

export type StageHealth = {
  stage: StageId;
  runs: number;
  last_status: RunStatus | null;
  last_at: string | null;
  errors: number;
  p50_ms: number | null;
};

export async function stageHealth(): Promise<StageHealth[]> {
  const runs = await listRuns({ limit: 500 });
  const byStage = new Map<StageId, RunRecord[]>();
  for (const run of runs) {
    const list = byStage.get(run.stage) ?? [];
    list.push(run);
    byStage.set(run.stage, list);
  }
  return [...byStage.entries()].map(([stage, list]) => {
    const durations = list
      .map((r) => r.duration_ms)
      .filter((v): v is number => typeof v === "number")
      .sort((a, b) => a - b);
    return {
      stage,
      runs: list.length,
      last_status: list[0]?.status ?? null,
      last_at: list[0]?.started_at ?? null,
      errors: list.filter((r) => r.status === "error").length,
      p50_ms: durations.length ? durations[Math.floor(durations.length / 2)] : null,
    };
  });
}
