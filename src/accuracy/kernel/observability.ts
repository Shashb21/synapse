/** Record byte-free run diagnostics and safely read historical module runs. */
import { and, desc, eq, getTableColumns, inArray, lt, sql } from "drizzle-orm";
import { accuracyDb, ensureAccuracySchema } from "../store/db";
import * as t from "../store/schema";
import { newId, nowIso } from "@/modules/kernel/ids";
import { rollupAccuracyRunCost, type AccuracyCostRollup } from "./cost-rollup";
import { historicParseMetadata, parseRunMetadata, sanitizeRunTelemetry } from "./run-telemetry";
import type {
  Actor,
  AgentRole,
  CallKind,
  CostEstimate,
  EvalScore,
  ResolvedAccuracyRoute,
  RunHandle,
  RunStatus,
  RunStep,
  TokenUsage,
} from "./contracts";

/** Runs still `running` after this age are marked abandoned (process crash / hung LLM). */
export const DEFAULT_STALE_RUN_MAX_AGE_MS = 30 * 60 * 1000;
export const STALE_RUN_ERROR = "abandoned: still running past max age";

const MAX_STEP_BYTES = 40_000;

function trim(data: unknown): unknown {
  if (data === undefined) return null;
  data = sanitizeRunTelemetry(data);
  const json = JSON.stringify(data) ?? "null";
  if (json.length <= MAX_STEP_BYTES) return data;
  return { truncated: true, bytes: json.length, preview: json.slice(0, 2_000) };
}

/** Own the telemetry trust boundary while leaving module processing input intact. */
export class AccuracyRunRecorder implements RunHandle {
  readonly id: string;
  private readonly collected: RunStep[] = [];
  private readonly startedAtMs = Date.now();
  private totalUsage: TokenUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  private totalCostUsd = 0;

  constructor(
    readonly meta: {
      org_id: string;
      workspace_id: string;
      call_kind: CallKind;
      agent_role: AgentRole | "none";
      module_id: string;
      module_version: string;
      actor: Actor;
      input: unknown;
    },
    id?: string,
  ) {
    this.id = id ?? newId("arun");
    this.meta = {
      ...meta,
      input: meta.call_kind === "parse" ? parseRunMetadata(meta.input) : sanitizeRunTelemetry(meta.input),
    };
  }

  get workspace_id(): string {
    return this.meta.workspace_id;
  }

  addCost(cost: CostEstimate) {
    this.totalUsage = {
      prompt_tokens: this.totalUsage.prompt_tokens + cost.usage.prompt_tokens,
      completion_tokens: this.totalUsage.completion_tokens + cost.usage.completion_tokens,
      total_tokens: this.totalUsage.total_tokens + cost.usage.total_tokens,
    };
    this.totalCostUsd += cost.cost_usd;
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
        detail: error instanceof Error ? error.message : String(error),
        // A failed model call is still kept whole; the step names it (KAN-91).
        data: error && typeof error === "object" && "llm_call_id" in error ? trim({ llm_call_id: (error as { llm_call_id: unknown }).llm_call_id }) : null,
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
      data: trim(this.meta.call_kind === "parse" && name === "input:accepted" ? parseRunMetadata(data) : data),
    });
  }

  steps(): RunStep[] {
    return [...this.collected];
  }

  usageSummary() {
    return { token_usage: this.totalUsage, cost_usd: this.totalCostUsd };
  }

  durationMs() {
    return Date.now() - this.startedAtMs;
  }
}

/** Persist only the recorder-owned input projection before processing starts. */
export async function openAccuracyRun(recorder: AccuracyRunRecorder) {
  await ensureAccuracySchema();
  await accuracyDb()
    .insert(t.accuracyModuleRuns)
    .values({
      id: recorder.id,
      org_id: recorder.meta.org_id,
      workspace_id: recorder.meta.workspace_id,
      call_kind: recorder.meta.call_kind,
      agent_role: recorder.meta.agent_role,
      module_id: recorder.meta.module_id,
      module_version: recorder.meta.module_version,
      status: "running",
      started_at: nowIso(),
      finished_at: null,
      duration_ms: null,
      actor_name: recorder.meta.actor.name,
      actor_function: recorder.meta.actor.function,
      summary: null,
      error: null,
      input: recorder.meta.input as Record<string, unknown>,
      output: null,
      steps: [],
      route: null,
      token_usage: null,
      cost_usd: null,
      evals: null,
    });
}

/** Persist final diagnostics with document payload keys removed from structured fields. */
export async function closeAccuracyRun(args: {
  recorder: AccuracyRunRecorder;
  status: RunStatus;
  summary?: string;
  error?: string;
  output?: unknown;
  route?: ResolvedAccuracyRoute | null;
  evals?: EvalScore[];
}) {
  const { token_usage, cost_usd } = args.recorder.usageSummary();
  await accuracyDb()
    .update(t.accuracyModuleRuns)
    .set({
      status: args.status,
      finished_at: nowIso(),
      duration_ms: args.recorder.durationMs(),
      summary: args.summary ?? null,
      error: args.error ?? null,
      output: sanitizeRunTelemetry(args.output ?? null),
      steps: args.recorder.steps(),
      route: sanitizeRunTelemetry(args.route ?? null),
      token_usage,
      cost_usd: String(cost_usd),
      evals: sanitizeRunTelemetry(args.evals ?? null),
    })
    .where(eq(t.accuracyModuleRuns.id, args.recorder.id));
}

export async function sweepStaleAccuracyRuns(args?: {
  workspace_id?: string;
  maxAgeMs?: number;
  now?: Date;
}): Promise<{ abandoned_ids: string[]; cutoff: string }> {
  await ensureAccuracySchema();
  const now = args?.now ?? new Date();
  const maxAgeMs = args?.maxAgeMs ?? DEFAULT_STALE_RUN_MAX_AGE_MS;
  const cutoff = new Date(now.getTime() - maxAgeMs).toISOString();
  const finishedAt = now.toISOString();

  const filters = [
    eq(t.accuracyModuleRuns.status, "running"),
    lt(t.accuracyModuleRuns.started_at, cutoff),
  ];
  if (args?.workspace_id) {
    filters.push(eq(t.accuracyModuleRuns.workspace_id, args.workspace_id));
  }

  const stale = await accuracyDb()
    .select({
      id: t.accuracyModuleRuns.id,
      started_at: t.accuracyModuleRuns.started_at,
    })
    .from(t.accuracyModuleRuns)
    .where(and(...filters));

  if (stale.length === 0) return { abandoned_ids: [], cutoff };

  for (const row of stale) {
    const started = Date.parse(row.started_at);
    const duration_ms = Number.isFinite(started) ? Math.max(0, now.getTime() - started) : null;
    await accuracyDb()
      .update(t.accuracyModuleRuns)
      .set({
        status: "abandoned",
        finished_at: finishedAt,
        duration_ms,
        error: STALE_RUN_ERROR,
        summary: "Marked abandoned by workspace hygiene (stale running run)",
      })
      .where(inArray(t.accuracyModuleRuns.id, [row.id]));
  }

  return { abandoned_ids: stale.map((row) => row.id), cutoff };
}

/** Read runs with historic parse payloads projected in SQL before transfer. */
export async function listAccuracyRuns(workspace_id: string, limit = 40) {
  await ensureAccuracySchema();
  await sweepStaleAccuracyRuns({ workspace_id });
  const columns = getTableColumns(t.accuracyModuleRuns);
  const metadata = historicParseMetadata(sql`${columns.input}`);
  const runs = await accuracyDb()
    .select({
      ...columns,
      input: sql<unknown>`case when ${columns.call_kind} = 'parse' then ${metadata} else ${columns.input} end`,
      // Older accepted-input steps can contain raw JSON or an unsafe truncated preview.
      // Reuse the input metadata without materializing either form in the application.
      steps: sql<unknown>`case when ${columns.call_kind} = 'parse' and jsonb_typeof(${columns.steps}) = 'array' then
        coalesce((select jsonb_agg(case when step->>'name' = 'input:accepted'
          then (step - 'data') || jsonb_build_object('data', ${metadata}) else step end order by ordinal)
          from jsonb_array_elements(${columns.steps}) with ordinality as entries(step, ordinal)), '[]'::jsonb)
        else ${columns.steps} end`,
    })
    .from(t.accuracyModuleRuns)
    .where(eq(t.accuracyModuleRuns.workspace_id, workspace_id))
    .orderBy(desc(t.accuracyModuleRuns.started_at))
    .limit(limit);
  return runs.map((run) => ({
    ...run,
    input: sanitizeRunTelemetry(run.input),
    output: sanitizeRunTelemetry(run.output),
    steps: sanitizeRunTelemetry(run.steps),
    route: sanitizeRunTelemetry(run.route),
    token_usage: sanitizeRunTelemetry(run.token_usage),
    evals: sanitizeRunTelemetry(run.evals),
  }));
}

export async function summarizeAccuracyRunCost(
  workspace_id: string,
  limit = 2000,
): Promise<AccuracyCostRollup> {
  await ensureAccuracySchema();
  await sweepStaleAccuracyRuns({ workspace_id });
  const runs = await accuracyDb()
    .select({
      call_kind: t.accuracyModuleRuns.call_kind,
      status: t.accuracyModuleRuns.status,
      cost_usd: t.accuracyModuleRuns.cost_usd,
      token_usage: t.accuracyModuleRuns.token_usage,
    })
    .from(t.accuracyModuleRuns)
    .where(eq(t.accuracyModuleRuns.workspace_id, workspace_id))
    .orderBy(desc(t.accuracyModuleRuns.started_at))
    .limit(limit);
  return rollupAccuracyRunCost(runs);
}
