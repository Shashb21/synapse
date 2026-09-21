import { desc, eq } from "drizzle-orm";
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

function trim(data: unknown): unknown {
  if (data === undefined) return null;
  const json = JSON.stringify(data) ?? "null";
  if (json.length <= MAX_STEP_BYTES) return data;
  return { truncated: true, bytes: json.length, preview: json.slice(0, 2_000) };
}

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
        data: { error: error instanceof Error ? error.message : String(error) },
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
      started_at: nowIso(),
      actor_name: recorder.meta.actor.name,
      actor_function: recorder.meta.actor.function,
      input: trim(recorder.meta.input),
      steps: [],
    });
}

export async function closeRun(args: {
  recorder: RunRecorder;
  status: RunStatus;
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
      output: trim(args.output),
      steps: args.recorder.steps(),
      route: args.route ?? null,
      evals: args.evals ?? [],
    })
    .where(eq(t.moduleRuns.id, args.recorder.id));
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
    summary: row.summary,
    error: row.error,
    input: row.input,
    output: row.output,
    steps: (row.steps as RunStep[]) ?? [],
    route: (row.route as ResolvedRoute | null) ?? null,
    evals: (row.evals as EvalScore[]) ?? [],
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
