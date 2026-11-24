/** Fictional provider traffic exercises physical dispatch, nested retries and accounting. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { completionFor } from "@/modules/kernel/routing";
import type { ResolvedRoute, RunHandle } from "@/modules/kernel/contracts";
import { withModelRun } from "@/modules/kernel/model-run";
import { anthropicText, geminiText, RETRY } from "@/modules/llm/provider";

const { execute } = vi.hoisted(() => ({ execute: vi.fn<(statement: SQL) => Promise<void>>() }));
vi.mock("@/modules/kernel/db", () => ({ sharedDb: () => ({ execute }) }));
const route: ResolvedRoute = { stage: "S9", provider_id: "openai", model: "gpt-4.1", provider_label: "Fictional route",
  auth: "api_key", connected: true, params: { temperature: 0, max_tokens: 50 }, fallbacks: ["anthropic-claude"], degraded: false, reason: null };
const run: RunHandle = { id: "fixture", step: async (_name, fn) => fn(), note: () => {}, steps: () => [] };
const ask = () => completionFor(route, run)({ purpose: "fiction", system: "Test only.", user: "Fictional question." });
const reply = (content = "{}", counts = { prompt_tokens: 10, completion_tokens: 5 }) =>
  Response.json({ choices: [{ message: { content } }], usage: counts });
function recordedCosts() {
  const dialect = new PgDialect();
  return execute.mock.calls.map(([s]) => dialect.sqlToQuery(s)).filter(q => q.sql.includes("insert into llm_calls")).map(q => q.params[16]);
}

beforeEach(() => { execute.mockClear(); vi.stubEnv("OPENAI_API_KEY", "fictional"); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it("shares attempts across nested HTTP retries, JSON repairs and parallel completions", async () => {
  vi.stubEnv("SYNAPSE_RUN_MAX_ATTEMPTS", "4");
  vi.stubEnv("SYNAPSE_RUN_CONCURRENCY", "2");
  vi.spyOn(RETRY, "sleep").mockResolvedValue();
  let active = 0, peak = 0, sent = 0;
  vi.stubGlobal("fetch", vi.fn(async () => {
    const n = ++sent;
    peak = Math.max(peak, ++active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
    return n % 2 ? new Response("busy", { status: 503 }) : reply("invalid");
  }));
  const outcomes = await withModelRun(undefined, () => Promise.allSettled(Array.from({ length: 6 }, ask)));
  expect(outcomes.every(r => r.status === "rejected")).toBe(true);
  expect(sent).toBe(4);
  expect(peak).toBe(2);
});

it.each(["cancel", "deadline"])("interrupts active transport and queued work on %s", async mode => {
  vi.stubEnv("SYNAPSE_RUN_CONCURRENCY", "1");
  vi.stubEnv("SYNAPSE_RUN_TIMEOUT_MS", mode === "deadline" ? "40" : "5000");
  const controller = new AbortController();
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    if (mode === "cancel") queueMicrotask(() => controller.abort());
    return new Promise<Response>((_ok, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true }));
  });
  vi.stubGlobal("fetch", fetch);
  const results = await withModelRun(controller.signal, () => Promise.allSettled([ask(), ask()]));
  expect(results.every(r => r.status === "rejected")).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(recordedCosts()).toEqual([null]);
});

it("honours an HTTP-date delay, and never retries early when Retry-After exceeds the remaining deadline", async () => {
  const date = new Date(Date.now() + 5_000).toUTCString();
  const sleep = vi.spyOn(RETRY, "sleep").mockResolvedValue();
  const fetch = vi.fn().mockResolvedValueOnce(new Response("", { status: 429, headers: { "retry-after": date } }))
    .mockResolvedValueOnce(reply()).mockResolvedValueOnce(new Response("", { status: 429, headers: { "retry-after": "900" } }));
  vi.stubGlobal("fetch", fetch);
  await withModelRun(undefined, ask);
  expect(sleep.mock.calls[0][0]).toBeGreaterThan(3000);
  vi.stubEnv("SYNAPSE_RUN_TIMEOUT_MS", "1000");
  await expect(withModelRun(undefined, ask)).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(sleep).toHaveBeenCalledTimes(1);
});

it("keeps a retried logical call's charge unknown even when its last attempt reports counts", async () => {
  vi.spyOn(RETRY, "sleep").mockResolvedValue();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("busy", { status: 503 })).mockResolvedValueOnce(reply()));
  await withModelRun(undefined, ask);
  expect(recordedCosts()).toEqual([null]);
});

it("cannot send a redirected request or switch runtime fallback to another configured provider", async () => {
  vi.stubEnv("ANTHROPIC_API_KEY", "fictional-alternate");
  const fetch = vi.fn(async () => Response.redirect("https://fiction.invalid/other", 307));
  vi.stubGlobal("fetch", fetch);
  await expect(withModelRun(undefined, ask)).rejects.toMatchObject({ status: 307 });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledWith(expect.stringContaining("api.openai.com"), expect.objectContaining({ redirect: "manual" }));
});

it.each([
  ["refusal", () => anthropicText({ stop_reason: "refusal" })],
  ["truncation", () => geminiText({ candidates: [{ finishReason: "MAX_TOKENS" }] })],
])("classifies terminal %s without JSON repair", (kind, parse) => {
  expect(parse).toThrowError(expect.objectContaining({ kind }));
});

it("keeps local document refusals out of the shared physical send count and meter", async () => {
  vi.stubEnv("SYNAPSE_RUN_MAX_ATTEMPTS", "2");
  vi.stubEnv("SYNAPSE_RUN_CONCURRENCY", "1");
  const { createParseRequestBudget } = await import("@/lib/ingest/llm-structure");
  vi.stubEnv("SYNAPSE_MAX_PARSE_CALLS", "1");
  const budget = createParseRequestBudget();
  const fetch = vi.fn(async () => reply());
  vi.stubGlobal("fetch", fetch);
  const parse = () => completionFor(route, run)({ purpose: "fixture", system: "Test", user: "Fixture", requestBudget: budget });
  await withModelRun(undefined, async () => {
    const outcomes = await Promise.allSettled([parse(), parse()]);
    expect(outcomes.filter(r => r.status === "fulfilled")).toHaveLength(1);
    await ask();
  });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(recordedCosts()).toHaveLength(2);
});

it("classifies refused and incomplete answers at the API without exposing private provider metadata", async () => {
  const { apiErrorResponse } = await import("@/modules/auth/api-guard");
  for (const [detail, code] of [["content_filter", "refusal"], ["length", "truncation"]]) {
    const fetch = vi.fn(async () => Response.json({ choices: [{ message: { content: "private fixture" }, finish_reason: detail }] }));
    vi.stubGlobal("fetch", fetch);
    const error = await withModelRun(undefined, ask).catch(error => error);
    const response = await apiErrorResponse(error);
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ code, error: expect.not.stringContaining("private fixture") });
    expect(fetch).toHaveBeenCalledTimes(1);
  }
});

it("cancels a pending Retry-After wait before a second send", async () => {
  const controller = new AbortController();
  const sleep = RETRY.sleep;
  vi.spyOn(RETRY, "sleep").mockImplementation((ms, signal) => {
    queueMicrotask(() => controller.abort());
    return sleep(ms, signal);
  });
  const fetch = vi.fn(async () => new Response("", { status: 429, headers: { "Retry-After": "30" } }));
  vi.stubGlobal("fetch", fetch);
  await expect(withModelRun(controller.signal, ask)).rejects.toMatchObject({ code: "cancelled" });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("disables upstream fallback on the configured OpenRouter route", async () => {
  vi.stubEnv("OPENROUTER_API_KEY", "fictional-router");
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => reply());
  vi.stubGlobal("fetch", fetch);
  await withModelRun(undefined, () => completionFor({ ...route, provider_id: "openrouter", model: "openai/gpt-5.1" }, run)({
    purpose: "fixture", system: "Test", user: "Fictional question",
  }));
  expect(JSON.parse(fetch.mock.calls[0][1].body as string).provider).toEqual({ allow_fallbacks: false });
});

it.each([
  { provider: "google-gemini", model: "gemini-2.5-pro", key: "GEMINI_API_KEY", response: { candidates: [{ content: { parts: [{ text: "{}" }] } }], usageMetadata: { promptTokenCount: 10, thoughtsTokenCount: 3 } }, cost: null },
  { provider: "anthropic-claude", model: "claude-sonnet-4-20250514", key: "ANTHROPIC_API_KEY", response: { content: [{ type: "text", text: "{}" }], usage: { output_tokens: 2, cache_read_input_tokens: 5 } }, cost: null },
  { provider: "google-gemini", model: "gemini-2.5-pro", key: "GEMINI_API_KEY", response: { candidates: [{ content: { parts: [{ text: "{}" }] } }], usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, thoughtsTokenCount: 0 } }, cost: 0 },
  { provider: "anthropic-claude", model: "claude-sonnet-4-20250514", key: "ANTHROPIC_API_KEY", response: { content: [{ type: "text", text: "{}" }], usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 } }, cost: 0 },
])("meters $provider raw usage at $cost when base counts are partial or explicitly zero", async fixture => {
  vi.stubEnv(fixture.key, "fictional");
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(fixture.response)));
  await withModelRun(undefined, () => completionFor({ ...route, provider_id: fixture.provider, model: fixture.model }, run)({
    purpose: "usage-fixture", system: "test", user: "fixture",
  }));
  expect(recordedCosts()).toEqual([fixture.cost]);
});
