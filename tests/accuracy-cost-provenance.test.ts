/** KAN-190: priced aliases, estimated counts and unknown costs survive the full call/run path. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { mechanicalModule } from "@/accuracy/modules/_factory";
import { estimateCostUsd } from "@/accuracy/kernel/cost";
import { AccuracyRunRecorder, closeAccuracyRun, openAccuracyRun } from "@/accuracy/kernel/observability";
import { accuracyCompletionFor } from "@/accuracy/kernel/routing";
import { runAccuracyModule } from "@/accuracy/kernel/run";
import * as registry from "@/accuracy/kernel/registry";
import * as routing from "@/accuracy/kernel/routing";
import { accuracyDb } from "@/accuracy/store/db";
import { accuracyModuleRuns } from "@/accuracy/store/schema";
import { listLlmCalls } from "@/modules/kernel/llm-calls";
import { xaiGrok, type LlmUsage } from "@/modules/llm/provider";
import { eq } from "drizzle-orm";
import type { CostEstimate, ResolvedAccuracyRoute } from "@/accuracy/kernel/contracts";

const meta = { org_id: "kan190", workspace_id: "default", call_kind: "need_extract" as const, agent_role: "proposer" as const,
  module_id: "kan190.test", module_version: "1", actor: { name: "test", function: "medical_affairs" as const }, input: {} };
const route = (provider_id: string, model: string): ResolvedAccuracyRoute => ({ call_kind: "need_extract", role: "proposer", provider_id,
  provider_label: provider_id, model, auth: "api_key", connected: true, params: { temperature: 0, max_tokens: 100 }, fallbacks: [], degraded: false, reason: null });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("canonical cost estimates", () => {
  it.each([
    ["xai-grok", "grok-4", 18], ["anthropic-claude", "claude-sonnet-4-20250514", 18],
    ["google-gemini", "gemini-2.5-pro", 11.25], ["openrouter", "x-ai/grok-4", 18],
    ["openrouter", "anthropic/claude-sonnet-4.5", 18], ["openrouter", "google/gemini-2.5-pro", 11.25],
    ["openrouter", "openai/gpt-4.1", 10], ["openrouter", "nvidia/example:free", 0],
    ["openrouter", "openrouter/free", 0], ["openrouter", "unknown/unknown", null],
  ])("prices %s %s without confusing unknown and free", (provider_id, model, expected) => {
    expect(estimateCostUsd({ provider_id: String(provider_id), model: String(model), usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 } }).cost_usd).toBe(expected);
  });
});

describe("recorder unknown cost", () => {
  it.each([[null, 1], [1, null]])("preserves unknown in a mixed run: %j", (first, second) => {
    const recorder = new AccuracyRunRecorder(meta);
    for (const cost_usd of [first, second]) recorder.addCost({ provider_id: "unknown", model: "unknown", usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }, cost_usd, price_source: null } as CostEstimate);
    expect(recorder.usageSummary()).toMatchObject({ cost_usd: null, token_usage: { total_tokens: 4 } });
  });
  it("keeps a no-call run at zero", () => { expect(new AccuracyRunRecorder(meta).usageSummary().cost_usd).toBe(0); });
});

describe("persisted Accuracy call and run", () => {
  it.each([
    ["xai-grok", "grok-4", "XAI_API_KEY", null, 0.000066, "estimated"],
    ["anthropic-claude", "claude-sonnet-4-20250514", "ANTHROPIC_API_KEY", null, 0.000066, "estimated"],
    ["google-gemini", "gemini-2.5-pro", "GEMINI_API_KEY", null, 0.000044, "estimated"],
    ["openrouter", "x-ai/grok-4", "OPENROUTER_API_KEY", null, 0.000066, "estimated"],
    ["openrouter", "unknown/model", "OPENROUTER_API_KEY", null, null, "estimated"],
    ["openrouter", "nvidia/example:free", "OPENROUTER_API_KEY", null, 0, "estimated"],
    ["openrouter", "openrouter/free", "OPENROUTER_API_KEY", null, 0, "estimated"],
    ["xai-grok", "grok-4", "XAI_API_KEY", { prompt_tokens: 1000, completion_tokens: 200 }, 0.006, "provider"],
    ["xai-grok", "grok-4", "XAI_API_KEY", { prompt_tokens: 1000 }, 0.00306, "mixed"],
  ])("retains cost/provenance for %s %s (%j)", async (provider_id, model, key, usage, expected, source) => {
    // Arrange: only the external model response is replaced; recording uses Postgres.
    vi.stubEnv(String(key), "kan190-test-key");
    const body = provider_id === "anthropic-claude" ? { content: [{ type: "text", text: "abcdefghijklmnop" }] }
      : provider_id === "google-gemini" ? { candidates: [{ content: { parts: [{ text: "abcdefghijklmnop" }] }, finishReason: "STOP" }] }
      : { choices: [{ message: { content: "abcdefghijklmnop" } }], ...(usage ? { usage } : {}) };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })));
    const recorder = new AccuracyRunRecorder(meta);
    await openAccuracyRun(recorder);
    const observed: unknown[] = [];
    const complete = accuracyCompletionFor({ route: route(String(provider_id), String(model)), run: recorder,
      onUsage: (tokens, cost_usd, provenance) => { observed.push(provenance); recorder.addCost({ provider_id: String(provider_id), model: String(model), usage: tokens, cost_usd, ...provenance }); } });
    // Act: completion is four tokens; Gemini has three prompt tokens to avoid a rounding tie.
    await complete({ system: provider_id === "google-gemini" ? "abcdefgh" : "abcd", user: "efgh", purpose: "kan190" });
    await closeAccuracyRun({ recorder, status: "ok" });
    const [call] = await listLlmCalls(recorder.id);
    const [stored] = await accuracyDb().select().from(accuracyModuleRuns).where(eq(accuracyModuleRuns.id, recorder.id));
    // Assert: persisted call, callback and persisted run use the same price and tokens.
    expect(call.cost_usd).toBe(expected);
    expect(call.usage).toMatchObject({ source });
    expect(observed).toEqual([expect.objectContaining({ price_source: call.price_source })]);
    expect(recorder.usageSummary().cost_usd).toBe(expected);
    expect(stored.cost_usd === null ? null : Number(stored.cost_usd)).toBe(expected);
    expect(stored.token_usage).toMatchObject({ source });
  });

  it("carries a call's source into the run trace without repricing", async () => {
    vi.stubEnv("SYNAPSE_TEST_STUB_LLM", "0");
    vi.stubEnv("XAI_API_KEY", "kan190-test-key");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }))));
    vi.spyOn(routing, "resolveAccuracyRoute").mockResolvedValue(route("xai-grok", "grok-4"));
    vi.spyOn(registry, "activeAccuracyModule").mockResolvedValue(mechanicalModule({
      id: "kan190", call_kind: "need_extract", title: "test", summary: "fixture",
      inputSchema: z.unknown(), outputSchema: z.unknown(),
      run: async (_input, ctx) => {
        await ctx.complete({ system: "abcd", user: "efgh", purpose: "kan190" });
        return { output: {}, summary: "done" };
      },
    }));
    const result = await runAccuracyModule({ ...meta, input: {} });
    const [call] = await listLlmCalls(result.run_id);
    const [stored] = await accuracyDb().select().from(accuracyModuleRuns).where(eq(accuracyModuleRuns.id, result.run_id));
    expect(result.cost_usd).toBe(0.000021);
    expect(result.token_usage).toMatchObject({ source: "estimated" });
    expect(call.price_source).toBe("https://docs.x.ai/docs/models");
    expect(stored.steps).toEqual(expect.arrayContaining([expect.objectContaining({ name: "cost", data: expect.objectContaining({ price_source: call.price_source, cost_usd: call.cost_usd }) })]));
  });
});


describe("failed Accuracy attempts", () => {
  it.each([
    { name: "first attempt without usage", previousSuccess: false, reported: null, expectedCost: null, expectedInput: 0, expectedOutput: 0 },
    { name: "paid success followed by an unknown failure", previousSuccess: true, reported: null, expectedCost: null, expectedInput: 1000, expectedOutput: 200 },
    { name: "failure with billed usage", previousSuccess: false, reported: { input_tokens: 1234, output_tokens: 56, total_tokens: 1290, reasoning_tokens: null }, expectedCost: 0.004542, expectedInput: 1234, expectedOutput: 56 },
    { name: "failure with partial reported usage", previousSuccess: false, reported: { input_tokens: 1234, output_tokens: null, total_tokens: null, reasoning_tokens: null }, expectedCost: 0.003702, expectedInput: 1234, expectedOutput: 0 },
  ])("persists $name without masking the error or double counting", async ({ previousSuccess, reported, expectedCost, expectedInput, expectedOutput }) => {
    // Arrange: the external provider adapter may report usage before rejecting.
    vi.stubEnv("SYNAPSE_TEST_STUB_LLM", "0");
    vi.stubEnv("XAI_API_KEY", "kan190-test-key");
    const failure = new Error("provider rejected the attempt");
    let attempts = 0;
    vi.spyOn(xaiGrok, "complete").mockImplementation(async (_request, _auth, hooks) => {
      attempts += 1;
      if (previousSuccess && attempts === 1) {
        hooks?.onUsage?.({ input_tokens: 1000, output_tokens: 200, total_tokens: 1200, reasoning_tokens: null });
        return "{}";
      }
      if (reported) hooks?.onUsage?.(reported as LlmUsage);
      throw failure;
    });
    vi.spyOn(routing, "resolveAccuracyRoute").mockResolvedValue(route("xai-grok", "grok-4"));
    let runId = "";
    vi.spyOn(registry, "activeAccuracyModule").mockResolvedValue(mechanicalModule({
      id: "kan190.failure", call_kind: "need_extract", title: "test", summary: "fixture",
      inputSchema: z.unknown(), outputSchema: z.unknown(),
      run: async (_input, ctx) => {
        runId = ctx.run.id;
        if (previousSuccess) await ctx.complete({ system: "abcd", user: "efgh", purpose: "paid" });
        await ctx.complete({ system: "abcd", user: "efgh", purpose: "failure" });
        return { output: {}, summary: "unreachable" };
      },
    }));
    // Act: run closure must retain the exact provider exception object.
    await expect(runAccuracyModule({ ...meta, input: {} })).rejects.toBe(failure);
    const calls = await listLlmCalls(runId);
    const failed = calls.find(call => call.status === "error")!;
    const [stored] = await accuracyDb().select().from(accuracyModuleRuns).where(eq(accuracyModuleRuns.id, runId));
    // Assert: no successful-reply estimates are invented for failed attempts.
    expect(calls).toHaveLength(previousSuccess ? 2 : 1);
    expect(failed.reply).toBeNull();
    expect(failed.cost_usd).toBe(expectedCost);
    expect(stored.status).toBe("error");
    expect(stored.cost_usd === null ? null : Number(stored.cost_usd)).toBe(expectedCost);
    expect(failed.usage).toEqual(reported ? expect.objectContaining({ ...reported, source: "provider" }) : null);
    expect(stored.token_usage).toMatchObject({ prompt_tokens: expectedInput, completion_tokens: expectedOutput, total_tokens: expectedInput + expectedOutput });
    const costSteps = (stored.steps as { name: string; data: unknown }[]).filter(step => step.name === "cost");
    expect(costSteps).toHaveLength(calls.length);
    expect(costSteps.at(-1)?.data).toMatchObject({ cost_usd: failed.cost_usd, price_source: failed.price_source });
    expect(failed.price_source).toBe(reported ? "https://docs.x.ai/docs/models" : null);
  });

  it("persists zero when the module attempts no calls", async () => {
    vi.spyOn(registry, "activeAccuracyModule").mockResolvedValue(mechanicalModule({
      id: "kan190.no-calls", call_kind: "need_extract", title: "test", summary: "fixture",
      inputSchema: z.unknown(), outputSchema: z.unknown(),
      run: async () => ({ output: {}, summary: "no calls" }),
    }));
    const result = await runAccuracyModule({ ...meta, input: {} });
    const [stored] = await accuracyDb().select().from(accuracyModuleRuns).where(eq(accuracyModuleRuns.id, result.run_id));
    expect(await listLlmCalls(result.run_id)).toEqual([]);
    expect(result.cost_usd).toBe(0);
    expect(stored.cost_usd).not.toBeNull();
    expect(Number(stored.cost_usd)).toBe(0);
  });
});
