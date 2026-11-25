import { HISTORICAL_FAILURE_MESSAGE } from "./failure-presentation";
import { sql } from "drizzle-orm";
import { sharedDb } from "./db";
import { newId } from "./ids";
import { estimateCallCost, usageFromMessages } from "@/modules/llm/cost";
import { redactSecrets } from "@/modules/llm/provider-error";
import { PROVIDERS, type LlmProvider, type LlmRequest, type ProviderRequestBudget, type LlmUsage } from "@/modules/llm/provider";
import type { RunHandle, StageId } from "./contracts";
import { providerApiKey } from "@/modules/llm/api-keys";
import { isDemoReplayProvider, VELMARA_DEMO_FIXTURE } from "@/lib/demo/replay-provider";
import { DemoReplayMissError, replayDelayMs, replayReply } from "@/lib/demo/replay";
import { allowsDemoExecution, type DemoExecution } from "@/lib/demo/mode";
import { DemoRecordingWriteError } from "./stage-errors";

/**
 * Every model call, kept whole (KAN-91): the prompts (secrets redacted), the
 * reply, provider/model parameters, and token counts with their origin: reported
 * counts are retained and missing successful-call counts are estimated. Also keeps an
 * estimated cost and the latency. One platform table for all workspaces; a run's
 * trace step names its call by id, and the run page shows them.
 */

/** What was sent: `temperature` is null when the model is called without it (KAN-71). */
export type LlmCallParams = { temperature: number | null; max_tokens: number };

export type LlmCallRecord = {
  id: string;
  created_at: string;
  workspace_id: string | null;
  run_id: string | null;
  stage: string | null;
  /** The trace step the call belongs to, e.g. `llm:gap-extract`. */
  step: string;
  purpose: string;
  /** 1 for the first ask; a reply that was not valid JSON is asked for again. */
  attempt: number;
  provider_id: string;
  model: string;
  params: LlmCallParams;
  system_prompt: string;
  user_prompt: string;
  reply: string | null;
  status: "ok" | "error";
  error: string | null;
  usage: LlmUsage | null;
  /** Estimated from the price table; null when the model's price is unknown. */
  cost_usd: number | null;
  price_source: string | null;
  latency_ms: number;
  demo_fixture?: string | null;
  demo_recording_id?: string | null;
};

export const LLM_CALLS_DDL = [
  `CREATE TABLE IF NOT EXISTS llm_calls (
    id text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now(),
    workspace_id text, run_id text, stage text, step text NOT NULL, purpose text NOT NULL,
    attempt integer NOT NULL DEFAULT 1, provider_id text NOT NULL, model text NOT NULL,
    params jsonb NOT NULL, system_prompt text NOT NULL, user_prompt text NOT NULL, reply text,
    status text NOT NULL, error text, usage jsonb, cost_usd numeric, price_source text,
    latency_ms integer NOT NULL
  )`,
  `ALTER TABLE llm_calls ADD COLUMN IF NOT EXISTS demo_fixture text`,
  `ALTER TABLE llm_calls ADD COLUMN IF NOT EXISTS demo_recording_id text`,
  `CREATE INDEX IF NOT EXISTS llm_calls_run ON llm_calls(run_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS llm_calls_workspace_stage ON llm_calls(workspace_id, stage)`,
];

const ready = globalThis as unknown as { synapseLlmCalls?: Promise<void> };

async function ensureLlmCallsTable(): Promise<void> {
  if (!ready.synapseLlmCalls) {
    const attempt = (async () => {
      for (const statement of LLM_CALLS_DDL) await sharedDb().execute(sql.raw(statement));
    })();
    ready.synapseLlmCalls = attempt;
    attempt.catch(() => {
      if (ready.synapseLlmCalls === attempt) ready.synapseLlmCalls = undefined;
    });
  }
  await ready.synapseLlmCalls;
}

const SECRET_PATTERNS: [RegExp, string][] = [
  [/\b(sk-ant-[A-Za-z0-9_-]{8,}|sk-or-[A-Za-z0-9_-]{8,})/g, "[redacted]"],
  [/\b(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, "[redacted]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, "Bearer [redacted]"],
  [/("?(?:password|passphrase|api[_-]?key|secret|token)"?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}]+)/gi, "$1[redacted]"],
];

/** A prompt or reply with every configured provider key and anything key-shaped removed. */
export function redactPromptSecrets(text: string): string {
  const keys = PROVIDERS.map((provider) => providerApiKey(provider.id)).filter((key): key is string => Boolean(key));
  let out = redactSecrets(text, keys);
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/** Fill missing successful-call counts once, retaining reported counts and their origin. */
function callUsage(input: Pick<LlmCallRecord, "usage" | "status" | "reply" | "system_prompt" | "user_prompt">): LlmUsage | null {
  if (input.status !== "ok" || input.reply === null) {
    return input.usage ? { ...input.usage, source: input.usage.source ?? "provider" } : null;
  }
  const reported = input.usage;
  const estimate = usageFromMessages(input.system_prompt, input.user_prompt, input.reply);
  const input_source = reported?.input_tokens_source ?? (reported?.input_tokens == null ? "estimated" : "provider");
  const output_source = reported?.output_tokens_source ?? (reported?.output_tokens == null ? "estimated" : "provider");
  const input_tokens = reported?.input_tokens ?? estimate.prompt_tokens;
  const output_tokens = reported?.output_tokens ?? estimate.completion_tokens;
  return {
    ...reported,
    input_tokens, output_tokens,
    total_tokens: input_source === "provider" && output_source === "provider" ? reported?.total_tokens ?? input_tokens + output_tokens : input_tokens + output_tokens,
    reasoning_tokens: reported?.reasoning_tokens ?? null,
    source: input_source === output_source ? input_source : "mixed",
    input_tokens_source: input_source,
    output_tokens_source: output_source,
  };
}

/** Stores one call and returns its id. Throws when it cannot be written. */
export async function recordLlmCall(input: Omit<LlmCallRecord, "id" | "created_at" | "cost_usd" | "price_source">): Promise<string> {
  await ensureLlmCallsTable();
  const id = newId("llm");
  const usage = callUsage(input);
  const { cost_usd, price_source } = callPricing(input.provider_id, input.model, usage);
  const json = (value: unknown) => (value === null || value === undefined ? sql`null` : sql`${JSON.stringify(value)}::jsonb`);
  await sharedDb().execute(sql`insert into llm_calls
    (id, workspace_id, run_id, stage, step, purpose, attempt, provider_id, model, params, system_prompt,
     user_prompt, reply, status, error, usage, cost_usd, price_source, latency_ms, demo_fixture, demo_recording_id)
    values (${id}, ${input.workspace_id}, ${input.run_id}, ${input.stage}, ${input.step}, ${input.purpose},
     ${input.attempt}, ${input.provider_id}, ${input.model}, ${json(input.params)},
     ${redactPromptSecrets(input.system_prompt)}, ${redactPromptSecrets(input.user_prompt)},
     ${input.reply === null ? null : redactPromptSecrets(input.reply)}, ${input.status},
     ${input.error === null ? null : redactPromptSecrets(input.error)}, ${json(usage)}, ${cost_usd},
     ${price_source}, ${Math.max(0, Math.round(input.latency_ms))}, ${input.demo_fixture ?? null}, ${input.demo_recording_id ?? null})`);
  return id;
}

type Row = Omit<LlmCallRecord, "created_at" | "cost_usd" | "params" | "usage"> & {
  created_at: Date | string;
  cost_usd: string | number | null;
  params: unknown;
  usage: unknown;
};

function toRecord(row: Row): LlmCallRecord {
  return {
    ...row,
    error: row.error === null ? null : HISTORICAL_FAILURE_MESSAGE,
    reply: row.status === "error" ? null : row.reply === null ? null : redactPromptSecrets(row.reply),
    system_prompt: redactPromptSecrets(row.system_prompt),
    user_prompt: redactPromptSecrets(row.user_prompt),
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    cost_usd: row.cost_usd === null ? null : Number(row.cost_usd),
    params: row.params as LlmCallParams,
    usage: (row.usage as LlmUsage | null) ?? null,
  };
}

/** A run's calls in the order they were made. */
export async function listLlmCalls(run_id: string): Promise<LlmCallRecord[]> {
  await ensureLlmCallsTable();
  const rows = (await sharedDb().execute(
    sql`select * from llm_calls where run_id = ${run_id} order by created_at, id`,
  )) as unknown as Row[];
  return rows.map(toRecord);
}

export type LlmTotals = {
  calls: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  /** Null when no call had a known price. */
  cost_usd: number | null;
  /** Calls whose cost could not be estimated (unknown price or no usage). */
  unpriced: number;
};

export function totalsOf(calls: Pick<LlmCallRecord, "usage" | "cost_usd">[]): LlmTotals {
  const totals: LlmTotals = { calls: calls.length, input_tokens: 0, output_tokens: 0, total_tokens: 0, cost_usd: null, unpriced: 0 };
  for (const call of calls) {
    totals.input_tokens += call.usage?.input_tokens ?? 0;
    totals.output_tokens += call.usage?.output_tokens ?? 0;
    totals.total_tokens += call.usage?.total_tokens ?? (call.usage?.input_tokens ?? 0) + (call.usage?.output_tokens ?? 0);
    if (call.cost_usd === null) totals.unpriced += 1;
    else totals.cost_usd = Math.round(((totals.cost_usd ?? 0) + call.cost_usd) * 1_000_000) / 1_000_000;
  }
  return totals;
}

/** Tokens and estimated cost per stage across a workspace's recorded calls. */
export async function llmTotalsByStage(workspace_id: string): Promise<Record<string, LlmTotals>> {
  await ensureLlmCallsTable();
  const rows = (await sharedDb().execute(
    sql`select stage, usage, cost_usd from llm_calls where workspace_id = ${workspace_id}`,
  )) as unknown as { stage: string | null; usage: unknown; cost_usd: string | number | null }[];
  const byStage = new Map<string, Pick<LlmCallRecord, "usage" | "cost_usd">[]>();
  for (const row of rows) {
    const stage = row.stage ?? "—";
    const list = byStage.get(stage) ?? [];
    list.push({ usage: (row.usage as LlmUsage | null) ?? null, cost_usd: row.cost_usd === null ? null : Number(row.cost_usd) });
    byStage.set(stage, list);
  }
  return Object.fromEntries([...byStage.entries()].map(([stage, list]) => [stage, totalsOf(list)]));
}

/**
 * One traced model call (KAN-91): asks the provider inside the run's trace step,
 * stores the whole call in llm_calls (also when the provider fails), and gives
 * the step the call's id, usage, cost and latency. Returns the reply text, as
 * the provider contract always has. A failed insert is noted on the run.
 * A demo recording requires a saved call before its reply can be used.
 */
export async function tracedCompletion(args: {
  provider: LlmProvider;
  request: LlmRequest;
  api_key: string;
  /** The stage or accuracy run's trace (anything that records steps and notes). */
  run: Pick<RunHandle, "id" | "step" | "note">;
  step: string;
  detail: string;
  purpose: string;
  attempt: number;
  stage: string | null;
  workspace_id: string | null;
  demo?: DemoExecution;
  /** Optional single-send execution policy; ordinary callers retain provider defaults. */
  maxAttempts?: number;
  requestBudget?: ProviderRequestBudget;
  beforeSend?: () => Promise<void>;
  /** Failed attempts still contribute reported usage or an explicitly unknown cost. */
  onFailure?: (attempt: Pick<LlmCallRecord, "usage" | "cost_usd" | "price_source">) => void;
}): Promise<{ text: string; usage: LlmUsage | null; llm_call_id: string | null; cost_usd: number | null; price_source: string | null }> {
  const traced = await args.run.step(
    args.step,
    async () => {
      let usage: LlmUsage | null = null;
      const began = Date.now();
      const replay = isDemoReplayProvider(args.provider.id);
      let approvedDemo = false;
      const record = async (reply: string | null, error: string | null) => {
        try {
          const recordingId = approvedDemo && args.demo?.mode === "record" && reply !== null &&
            [args.request.system, args.request.user, reply].every(value => redactPromptSecrets(value) === value) ? args.demo.recording_id : null;
          return await recordLlmCall({
            workspace_id: args.workspace_id,
            run_id: args.run.id,
            stage: args.stage,
            step: args.step,
            purpose: args.purpose,
            attempt: args.attempt,
            provider_id: args.provider.id,
            model: args.request.model,
            params: {
              temperature: args.provider.sendsTemperature?.(args.request.model) === false ? null : args.request.temperature,
              max_tokens: args.request.max_tokens,
            },
            system_prompt: args.request.system,
            user_prompt: args.request.user,
            reply,
            status: error === null ? "ok" : "error",
            error,
            usage,
            latency_ms: Date.now() - began,
            demo_fixture: (approvedDemo && replay) || recordingId ? VELMARA_DEMO_FIXTURE : null,
            demo_recording_id: recordingId,
          });
        } catch (failure) {
          console.error("[llm_calls] could not record a call", args.step, failure);
          args.run.note("llm_call:unrecorded", { step: args.step, error: failure instanceof Error ? failure.message : String(failure) });
          return null;
        }
      };
      // A local refusal before the first send belongs in the run trace only.
      if (!replay) args.requestBudget?.check();
      let text: string;
      try {
        approvedDemo = args.demo ? await allowsDemoExecution(args.demo, args.workspace_id) : false;
        if (replay) {
          if (!approvedDemo || args.demo?.mode !== "replay") throw new DemoReplayMissError();
          text = replayReply({ stage: args.stage as StageId | null, purpose: args.purpose, system: args.request.system, user: args.request.user });
          await new Promise((resolve) => setTimeout(resolve, replayDelayMs()));
        } else {
          if (args.demo && (!approvedDemo || args.demo.mode !== "record")) throw new DemoReplayMissError();
          await args.beforeSend?.();
          text = await args.provider.complete(args.request, { api_key: args.api_key }, { requestBudget: args.requestBudget, maxAttempts: args.maxAttempts, onUsage: (reported) => (usage = reported) });
        }
      } catch (error) {
        usage = callUsage({ usage, status: "error", reply: null, system_prompt: args.request.system, user_prompt: args.request.user });
        const id = await record(null, error instanceof Error ? error.message : String(error));
        // The trace step names the failed call too (observability.ts reads this).
        if (id && error && typeof error === "object") Object.assign(error, { llm_call_id: id });
        const pricing = callPricing(args.provider.id, args.request.model, usage);
        try {
          args.onFailure?.({ usage, ...pricing });
        } finally {
          // Accounting must never replace the original provider exception.
          throw error;
        }
      }
      usage = callUsage({ usage, status: "ok", reply: text, system_prompt: args.request.system, user_prompt: args.request.user });
      const latency_ms = Date.now() - began;
      const llm_call_id = await record(text, null);
      if (llm_call_id === null && approvedDemo && args.demo?.mode === "record") throw new DemoRecordingWriteError();
      const known = usage as LlmUsage | null;
      const { cost_usd, price_source } = callPricing(args.provider.id, args.request.model, known);
      return { llm_call_id, usage: known, cost_usd, price_source, latency_ms, reply: text };
    },
    args.detail,
  );
  return { text: traced.reply, usage: traced.usage, llm_call_id: traced.llm_call_id, cost_usd: traced.cost_usd, price_source: traced.price_source };
}

function callPricing(providerId: string, model: string, usage: LlmUsage | null) {
  if (isDemoReplayProvider(providerId)) return { cost_usd: 0, price_source: "recorded demo" };
  return usage ? estimateCallCost({ provider_id: providerId, model, usage }) : { cost_usd: null, price_source: null };
}
