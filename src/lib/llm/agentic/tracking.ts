import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgenticCallRecord } from "./types";

const MEMORY_CAP = 200;
const memory: AgenticCallRecord[] = [];
let persistDb = process.env.VITEST ? process.env.AGENTIC_TRACKING_DB === "1" : true;

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

export function clearAgenticCallLog() {
  memory.length = 0;
}

export function agenticCallSummary() {
  const total = memory.length;
  const ok = memory.filter((r) => r.ok).length;
  const oauth = memory.filter((r) => r.auth_mode === "oauth").length;
  const last = memory[memory.length - 1] ?? null;
  return { total, ok, failed: total - ok, oauth, last };
}

function writeJsonl(record: AgenticCallRecord) {
  if (process.env.AGENTIC_TRACKING === "memory") return;
  try {
    const path = trackingLogPath();
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    // File logging is best-effort.
  }
}

async function writeDb(record: AgenticCallRecord) {
  if (!persistDb) return;
  try {
    const { db, ensureSchema } = await import("@/lib/iegp/db");
    const t = await import("@/lib/iegp/schema");
    await ensureSchema();
    await db().insert(t.llmCalls).values({
      id: record.id,
      at: record.at,
      auth_mode: record.auth_mode,
      model: record.model,
      purpose: record.purpose,
      ok: record.ok,
      http_status: record.http_status ?? null,
      latency_ms: record.latency_ms,
      input_tokens: record.input_tokens ?? null,
      output_tokens: record.output_tokens ?? null,
      error: record.error ?? null,
      reauth: record.reauth ?? null,
      request_id: record.request_id ?? null,
    });
  } catch {
    // DB tracking is best-effort and must not fail the LLM call.
  }
}

export async function recordAgenticCall(record: AgenticCallRecord): Promise<void> {
  memory.push(record);
  if (memory.length > MEMORY_CAP) memory.splice(0, memory.length - MEMORY_CAP);
  writeJsonl(record);
  await writeDb(record);
}
