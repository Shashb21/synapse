import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { desc } from "drizzle-orm";
import type { AgenticCallRecord, ReauthEvent } from "./types";

const MEMORY_CAP = 500;
const memory: AgenticCallRecord[] = [];
const reauthMemory: ReauthEvent[] = [];
let persistDb = process.env.VITEST ? process.env.AGENTIC_TRACKING_DB === "1" : true;

const SECRET = /sk-ant-[a-z0-9-]+|sk-or-[a-z0-9-]+|Bearer\s+\S+/gi;

export function previewText(value: string, max = 480): string {
  const redacted = value.replace(SECRET, "[redacted]");
  if (redacted.length <= max) return redacted;
  return `${redacted.slice(0, max)}…`;
}

export function setAgenticTrackingPersistDb(enabled: boolean) {
  persistDb = enabled;
}

export function trackingLogPath(): string {
  return (
    process.env.AGENTIC_CALL_LOG?.trim() ||
    join(process.cwd(), "data/runtime/llm-calls.jsonl")
  );
}

export function agenticCallLog(): AgenticCallRecord[] {
  return [...memory];
}

export function storedReauthEvents(): ReauthEvent[] {
  return [...reauthMemory];
}

export function clearAgenticCallLog() {
  memory.length = 0;
  reauthMemory.length = 0;
}

export function agenticCallSummary(calls: AgenticCallRecord[] = memory) {
  const total = calls.length;
  const ok = calls.filter((r) => r.ok).length;
  const failed = total - ok;
  const input_tokens = calls.reduce((sum, r) => sum + (r.input_tokens ?? 0), 0);
  const output_tokens = calls.reduce((sum, r) => sum + (r.output_tokens ?? 0), 0);
  const cost_usd = calls.reduce((sum, r) => sum + (r.cost_usd ?? 0), 0);
  const latencies = calls.map((r) => r.latency_ms).sort((a, b) => a - b);
  const percentile = (p: number) => {
    if (latencies.length === 0) return 0;
    const idx = Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length));
    return latencies[idx] ?? 0;
  };
  const by_purpose: Record<string, number> = {};
  for (const row of calls) {
    by_purpose[row.purpose] = (by_purpose[row.purpose] ?? 0) + 1;
  }
  return {
    total,
    ok,
    failed,
    oauth: calls.filter((r) => r.auth_mode === "oauth").length,
    input_tokens,
    output_tokens,
    cost_usd: Math.round(cost_usd * 1_000_000) / 1_000_000,
    latency_ms_p50: percentile(50),
    latency_ms_p95: percentile(95),
    by_purpose,
    last: calls[calls.length - 1] ?? null,
  };
}

function writeJsonl(kind: "call" | "reauth", record: unknown) {
  if (process.env.AGENTIC_TRACKING === "memory") return;
  try {
    const path = trackingLogPath();
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify({ kind, record })}\n`, "utf8");
  } catch {
    // File logging is best-effort.
  }
}

async function writeCallDb(record: AgenticCallRecord) {
  if (!persistDb) return;
  try {
    const { db, ensureSchema } = await import("@/lib/iegp/db");
    const t = await import("@/lib/iegp/schema");
    await ensureSchema();
    await db().insert(t.llmCalls).values({
      id: record.id,
      at: record.at,
      auth_mode: record.auth_mode,
      provider: record.provider ?? null,
      module: record.module ?? null,
      model: record.model,
      purpose: record.purpose,
      ok: record.ok,
      http_status: record.http_status ?? null,
      latency_ms: record.latency_ms,
      input_tokens: record.input_tokens ?? null,
      output_tokens: record.output_tokens ?? null,
      cost_usd: record.cost_usd ?? null,
      error: record.error ?? null,
      reauth: record.reauth ?? null,
      request_id: record.request_id ?? null,
      session_id: record.session_id ?? null,
      oauth_source: record.oauth_source ?? null,
      system_chars: record.system_chars ?? null,
      user_chars: record.user_chars ?? null,
      system_preview: record.system_preview ?? null,
      user_preview: record.user_preview ?? null,
    });
  } catch {
    // DB tracking is best-effort and must not fail the LLM call.
  }
}

async function writeReauthDb(event: ReauthEvent) {
  if (!persistDb) return;
  try {
    const { db, ensureSchema } = await import("@/lib/iegp/db");
    const t = await import("@/lib/iegp/schema");
    await ensureSchema();
    await db().insert(t.llmReauthEvents).values({
      id: event.id ?? `RAUTH-${Date.now()}`,
      at: event.at ?? new Date().toISOString(),
      type: event.type,
      error: event.error ?? null,
      expires_at: event.expiresAt != null ? String(event.expiresAt) : null,
      request_id: event.request_id ?? null,
    });
  } catch {
    // best-effort
  }
}

export async function recordAgenticCall(record: AgenticCallRecord): Promise<void> {
  memory.push(record);
  if (memory.length > MEMORY_CAP) memory.splice(0, memory.length - MEMORY_CAP);
  writeJsonl("call", record);
  await writeCallDb(record);
}

export async function recordReauthEvent(event: ReauthEvent): Promise<void> {
  reauthMemory.push(event);
  if (reauthMemory.length > MEMORY_CAP) reauthMemory.splice(0, reauthMemory.length - MEMORY_CAP);
  writeJsonl("reauth", event);
  await writeReauthDb(event);
}

export async function loadStoredCalls(limit = 400): Promise<AgenticCallRecord[]> {
  if (!persistDb) return agenticCallLog();
  try {
    const { db, ensureSchema } = await import("@/lib/iegp/db");
    const t = await import("@/lib/iegp/schema");
    await ensureSchema();
    const rows = await db().select().from(t.llmCalls).orderBy(desc(t.llmCalls.at)).limit(limit);
    const fromDb: AgenticCallRecord[] = rows.map((row) => ({
      id: row.id,
      at: row.at,
      auth_mode: "oauth",
      provider: row.provider ?? undefined,
      module: row.module ?? undefined,
      model: row.model,
      purpose: row.purpose as AgenticCallRecord["purpose"],
      ok: row.ok,
      http_status: row.http_status ?? undefined,
      latency_ms: row.latency_ms,
      input_tokens: row.input_tokens ?? undefined,
      output_tokens: row.output_tokens ?? undefined,
      cost_usd: row.cost_usd ?? undefined,
      error: row.error ?? undefined,
      reauth: (row.reauth as AgenticCallRecord["reauth"]) ?? undefined,
      request_id: row.request_id ?? undefined,
      session_id: row.session_id ?? undefined,
      oauth_source: (row.oauth_source as AgenticCallRecord["oauth_source"]) ?? undefined,
      system_chars: row.system_chars ?? undefined,
      user_chars: row.user_chars ?? undefined,
      system_preview: row.system_preview ?? undefined,
      user_preview: row.user_preview ?? undefined,
    }));
    const byId = new Map(fromDb.map((row) => [row.id, row]));
    for (const row of memory) byId.set(row.id, row);
    return [...byId.values()].sort((a, b) => a.at.localeCompare(b.at));
  } catch {
    return agenticCallLog();
  }
}

export async function loadStoredReauth(limit = 200): Promise<ReauthEvent[]> {
  const local = storedReauthEvents();
  if (!persistDb) return local;
  try {
    const { db, ensureSchema } = await import("@/lib/iegp/db");
    const t = await import("@/lib/iegp/schema");
    await ensureSchema();
    const rows = await db()
      .select()
      .from(t.llmReauthEvents)
      .orderBy(desc(t.llmReauthEvents.at))
      .limit(limit);
    const fromDb: ReauthEvent[] = rows.map((row) => ({
      id: row.id,
      at: row.at,
      type: row.type as ReauthEvent["type"],
      error: row.error ?? undefined,
      expiresAt: row.expires_at ? Number(row.expires_at) : undefined,
      request_id: row.request_id ?? undefined,
    }));
    const byId = new Map(fromDb.filter((e) => e.id).map((e) => [e.id!, e]));
    for (const event of local) {
      if (event.id) byId.set(event.id, event);
    }
    return [...byId.values()].sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""));
  } catch {
    return local;
  }
}
