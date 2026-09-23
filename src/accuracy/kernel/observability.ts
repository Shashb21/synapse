import { and, desc, eq, inArray, lt } from "drizzle-orm";
import { accuracyDb, ensureAccuracySchema } from "../store/db";
import * as t from "../store/schema";
import { newId, nowIso } from "@/modules/kernel/ids";
import { rollupAccuracyRunCost, type AccuracyCostRollup } from "./cost-rollup";
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
  const json = JSON.stringify(data) ?? "null";
  if (json.length <= MAX_STEP_BYTES) return data;
  return { truncated: true, bytes: json.length, preview: json.slice(0, 2_000) };
}

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
        data: null,
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

  usageSummary() {
    return { token_usage: this.totalUsage, cost_usd: this.totalCostUsd };
  }

  durationMs() {
    return Date.now() - this.startedAtMs;
  }
}

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
      output: args.output ?? null,
      steps: args.recorder.steps(),
      route: args.route ?? null,
      token_usage,
      cost_usd: String(cost_usd),
      evals: args.evals ?? null,
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

export async function listAccuracyRuns(workspace_id: string, limit = 40) {
  await ensureAccuracySchema();
  await sweepStaleAccuracyRuns({ workspace_id });
  return accuracyDb()
    .select()
    .from(t.accuracyModuleRuns)
    .where(eq(t.accuracyModuleRuns.workspace_id, workspace_id))
    .orderBy(desc(t.accuracyModuleRuns.started_at))
    .limit(limit);
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
