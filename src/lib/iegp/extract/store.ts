import { desc, eq, sql } from "drizzle-orm";
import { db, ensureSchema } from "@/lib/iegp/db";
import * as t from "@/lib/iegp/schema";
import { hashId } from "@/lib/text";
import { GAP_EXTRACT_CHAMPION_ID } from "./contracts";
import { SEED_GOLD_GAPS } from "./gold";
import { GAP_PROMPT_REGISTRY } from "./prompts";
import type { GapExtractResult } from "./contracts";
import type { HumanFewShot } from "./loop";

function now() {
  return new Date().toISOString();
}

export type ExtractRunRow = typeof t.extractRuns.$inferSelect;
export type ExtractStepRow = typeof t.extractRunSteps.$inferSelect;
export type GoldGapRow = typeof t.goldGaps.$inferSelect;
export type GapFeedbackRow = typeof t.gapFeedback.$inferSelect;

export async function ensureExtractLearning() {
  const d = db();
  const prompts = await d.select().from(t.extractPromptVersions);
  if (prompts.length === 0) {
    const at = "2026-09-20T00:00:00.000Z";
    await d.insert(t.extractPromptVersions).values(
      GAP_PROMPT_REGISTRY.map((p) => ({
        version: p.version,
        title: p.title,
        summary: p.summary,
        system_prompt: p.system_prompt,
        parent_version: null,
        prompt_patch: null,
        origin: "seed",
        created_at: at,
      })),
    );
  }
  const settings = await d.select().from(t.extractSettings);
  if (settings.length === 0) {
    await d.insert(t.extractSettings).values({
      id: GAP_EXTRACT_CHAMPION_ID,
      champion_version: "v1.3-cross-source",
      updated_at: now(),
      last_hillclimb_at: null,
      last_metrics: null,
      last_error: null,
    });
  }
  const gold = await d.select().from(t.goldGaps);
  if (gold.length === 0) {
    const at = "2026-09-20T00:00:00.000Z";
    await d.insert(t.goldGaps).values(
      SEED_GOLD_GAPS.map((g) => ({
        id: g.id,
        name: g.name,
        statement: g.statement,
        domain: g.domain,
        source_key: g.source_key,
        source_quote: g.source_quote,
        must_find: g.must_find,
        is_gap: g.is_gap,
        origin: "seed",
        from_gap_id: null,
        metadata: {},
        created_at: at,
        actor_name: null,
        actor_function: null,
      })),
    );
  }
}

export async function wipeExtractTables() {
  const d = db();
  for (const table of [
    "extract_run_steps",
    "extract_runs",
    "gap_feedback",
    "gold_gaps",
    "extract_prompt_versions",
    "extract_settings",
  ]) {
    await d.execute(sql.raw(`DELETE FROM ${table}`));
  }
  await ensureExtractLearning();
}

export async function championPromptVersion(): Promise<string> {
  await ensureSchema();
  const rows = await db().select().from(t.extractSettings);
  return rows[0]?.champion_version ?? "v1.3-cross-source";
}

export async function loadPromptVersion(version: string) {
  await ensureSchema();
  const rows = await db()
    .select()
    .from(t.extractPromptVersions)
    .where(eq(t.extractPromptVersions.version, version));
  const row = rows[0];
  if (row) {
    return {
      version: row.version,
      title: row.title,
      summary: row.summary,
      system_prompt: row.system_prompt,
    };
  }
  return GAP_PROMPT_REGISTRY.find((p) => p.version === version) ?? GAP_PROMPT_REGISTRY[3]!;
}

export async function listPromptVersions() {
  await ensureSchema();
  return db().select().from(t.extractPromptVersions);
}

export async function upsertPromptVersion(args: {
  version: string;
  title: string;
  summary: string;
  system_prompt: string;
  parent_version?: string;
  prompt_patch?: string;
  origin: string;
}) {
  await ensureSchema();
  await db()
    .insert(t.extractPromptVersions)
    .values({
      version: args.version,
      title: args.title,
      summary: args.summary,
      system_prompt: args.system_prompt,
      parent_version: args.parent_version ?? null,
      prompt_patch: args.prompt_patch ?? null,
      origin: args.origin,
      created_at: now(),
    })
    .onConflictDoUpdate({
      target: t.extractPromptVersions.version,
      set: {
        title: args.title,
        summary: args.summary,
        system_prompt: args.system_prompt,
        parent_version: args.parent_version ?? null,
        prompt_patch: args.prompt_patch ?? null,
      },
    });
}

export async function setChampionVersion(version: string, metrics?: unknown) {
  await ensureSchema();
  await db()
    .insert(t.extractSettings)
    .values({
      id: GAP_EXTRACT_CHAMPION_ID,
      champion_version: version,
      updated_at: now(),
      last_hillclimb_at: now(),
      last_metrics: metrics ?? null,
      last_error: null,
    })
    .onConflictDoUpdate({
      target: t.extractSettings.id,
      set: {
        champion_version: version,
        updated_at: now(),
        last_hillclimb_at: now(),
        last_metrics: metrics ?? null,
        last_error: null,
      },
    });
}

export async function recordHillclimbError(message: string) {
  await ensureSchema();
  const current = await championPromptVersion();
  await db()
    .insert(t.extractSettings)
    .values({
      id: GAP_EXTRACT_CHAMPION_ID,
      champion_version: current,
      updated_at: now(),
      last_error: message,
    })
    .onConflictDoUpdate({
      target: t.extractSettings.id,
      set: { last_error: message, updated_at: now() },
    });
}

export async function listGoldGaps(): Promise<GoldGapRow[]> {
  await ensureSchema();
  return db().select().from(t.goldGaps);
}

export async function recentFewShots(limit = 12): Promise<HumanFewShot[]> {
  await ensureSchema();
  const rows = await db()
    .select()
    .from(t.gapFeedback)
    .orderBy(desc(t.gapFeedback.at))
    .limit(limit);
  return rows.map((row) => {
    const before = row.before as { name?: string; statement?: string };
    const after = row.after as { name?: string; statement?: string };
    const kind = row.kind as HumanFewShot["kind"];
    return {
      kind,
      before: before.statement || before.name,
      after: after.statement || after.name,
    };
  });
}

export async function insertGoldGap(args: {
  id?: string;
  name: string;
  statement: string;
  domain: string;
  source_key: string;
  source_quote: string;
  must_find: boolean;
  is_gap: boolean;
  origin: string;
  from_gap_id?: string | null;
  metadata?: Record<string, unknown>;
  actor_name?: string | null;
  actor_function?: string | null;
}): Promise<string> {
  await ensureSchema();
  const id =
    args.id ??
    hashId("GOLD-H", `${args.origin}:${args.from_gap_id ?? ""}:${args.statement}:${now()}`);
  await db()
    .insert(t.goldGaps)
    .values({
      id,
      name: args.name,
      statement: args.statement,
      domain: args.domain,
      source_key: args.source_key,
      source_quote: args.source_quote,
      must_find: args.must_find,
      is_gap: args.is_gap,
      origin: args.origin,
      from_gap_id: args.from_gap_id ?? null,
      metadata: args.metadata ?? {},
      created_at: now(),
      actor_name: args.actor_name ?? null,
      actor_function: args.actor_function ?? null,
    })
    .onConflictDoUpdate({
      target: t.goldGaps.id,
      set: {
        name: args.name,
        statement: args.statement,
        domain: args.domain,
        source_quote: args.source_quote,
        must_find: args.must_find,
        is_gap: args.is_gap,
        metadata: args.metadata ?? {},
      },
    });
  return id;
}

export async function insertFeedback(args: {
  gap_id: string;
  kind: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  actor_name: string;
  actor_function: string;
  gold_id?: string | null;
}): Promise<string> {
  await ensureSchema();
  const id = hashId("FB", `${args.gap_id}:${args.kind}:${now()}:${args.actor_name}`);
  await db().insert(t.gapFeedback).values({
    id,
    at: now(),
    gap_id: args.gap_id,
    kind: args.kind,
    before: args.before,
    after: args.after,
    actor_name: args.actor_name,
    actor_function: args.actor_function,
    gold_id: args.gold_id ?? null,
    hillclimb_run_id: null,
    error: null,
  });
  return id;
}

export async function patchFeedback(id: string, patch: { hillclimb_run_id?: string; error?: string }) {
  await db().update(t.gapFeedback).set(patch).where(eq(t.gapFeedback.id, id));
}

export async function createExtractRun(args: {
  kind: "extract" | "hillclimb";
  persist: boolean;
  format: string;
  prompt_version: string;
  champion_version: string;
  actor_name: string;
  actor_function: string;
  title: string;
  input: unknown;
}): Promise<ExtractRunRow> {
  await ensureSchema();
  const id = hashId("XRUN", `${args.kind}:${args.title}:${now()}:${Math.random()}`);
  const row = {
    id,
    kind: args.kind,
    status: "queued",
    created_at: now(),
    started_at: null,
    completed_at: null,
    persist: args.persist,
    format: args.format,
    prompt_version: args.prompt_version,
    champion_version: args.champion_version,
    actor_name: args.actor_name,
    actor_function: args.actor_function,
    title: args.title,
    error: null,
    input: args.input,
    result: null,
    metrics: null,
    source_id: null,
  };
  await db().insert(t.extractRuns).values(row);
  return row;
}

export async function markRunRunning(id: string) {
  await db()
    .update(t.extractRuns)
    .set({ status: "running", started_at: now() })
    .where(eq(t.extractRuns.id, id));
}

export async function completeRun(args: {
  id: string;
  result: unknown;
  metrics?: unknown;
  source_id?: string | null;
  prompt_version?: string;
}) {
  await db()
    .update(t.extractRuns)
    .set({
      status: "completed",
      completed_at: now(),
      result: args.result,
      metrics: args.metrics ?? null,
      source_id: args.source_id ?? null,
      ...(args.prompt_version ? { prompt_version: args.prompt_version } : {}),
    })
    .where(eq(t.extractRuns.id, args.id));
}

export async function failRun(id: string, error: string) {
  await db()
    .update(t.extractRuns)
    .set({ status: "failed", completed_at: now(), error })
    .where(eq(t.extractRuns.id, id));
}

export async function addRunStep(args: {
  run_id: string;
  round: number;
  role: string;
  request: unknown;
  response?: unknown;
  latency_ms?: number;
  error?: string;
}) {
  const started = now();
  await db().insert(t.extractRunSteps).values({
    id: hashId("XSTEP", `${args.run_id}:${args.role}:${args.round}:${started}`),
    run_id: args.run_id,
    round: args.round,
    role: args.role,
    started_at: started,
    ended_at: now(),
    latency_ms: args.latency_ms ?? null,
    request: args.request,
    response: args.response ?? null,
    error: args.error ?? null,
  });
}

export async function persistLoopTrace(runId: string, result: GapExtractResult) {
  for (const round of result.rounds) {
    await addRunStep({
      run_id: runId,
      round: round.round,
      role: "proposer",
      request: { round: round.round },
      response: round.proposer,
      latency_ms: round.proposer_ms,
    });
    await addRunStep({
      run_id: runId,
      round: round.round,
      role: "critic",
      request: { round: round.round },
      response: round.critic,
      latency_ms: round.critic_ms,
    });
  }
  await addRunStep({
    run_id: runId,
    round: result.rounds.length,
    role: "judge",
    request: { rounds: result.rounds.length },
    response: result.judge,
    latency_ms: result.judge_ms,
  });
}

export async function getExtractRun(id: string) {
  await ensureSchema();
  const rows = await db().select().from(t.extractRuns).where(eq(t.extractRuns.id, id));
  const run = rows[0];
  if (!run) return null;
  const steps = await db()
    .select()
    .from(t.extractRunSteps)
    .where(eq(t.extractRunSteps.run_id, id));
  return { run, steps };
}

export async function listExtractRuns(limit = 50) {
  await ensureSchema();
  return db().select().from(t.extractRuns).orderBy(desc(t.extractRuns.created_at)).limit(limit);
}

export async function extractSettings() {
  await ensureSchema();
  const rows = await db().select().from(t.extractSettings);
  return rows[0] ?? null;
}
