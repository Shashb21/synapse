import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import "@/modules";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GET as runGet } from "@/app/api/runs/[id]/route";
import { LlmCallList, LlmTotalsLine } from "@/components/admin/llm-calls";
import { estimateCallCost, priceKeyFor } from "@/accuracy/kernel/cost";
import type { ResolvedRoute } from "@/modules/kernel/contracts";
import { closeRun, getRun, openRun, RunRecorder } from "@/modules/kernel/observability";
import { llmTotalsByStage, listLlmCalls, redactPromptSecrets, totalsOf } from "@/modules/kernel/llm-calls";
import { completionFor } from "@/modules/kernel/routing";
import { runStage } from "@/modules/kernel/run";
import { anthropicClaude, googleGemini, openAi, usageFromPayload } from "@/modules/llm/provider";
import { listSourceFiles } from "@/modules/stages/s0-upload/module";

/**
 * KAN-91: every model call is stored whole — prompts (secrets redacted), reply,
 * provider/model/params, the provider's token usage, an estimated cost and the
 * latency — and the run's trace step names it. The run page shows the calls and
 * totals. An S0 run keeps an upload's hash, size, name and stored-file id, never
 * its bytes. No live model is called: fetch is stubbed.
 */

const FAKE_KEY = "sk-ant-kan91-fake-key-0000000000";
const ACTOR = { name: "KAN-91 Test", function: "medical_affairs" as const };
const run = Math.random().toString(36).slice(2, 8);

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const anthropicReply = (text: string) => ({
  content: [{ type: "text", text }],
  usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 100 },
});

function route(): ResolvedRoute {
  return {
    stage: "S2",
    provider_id: "anthropic-claude",
    provider_label: "Anthropic · Claude",
    model: "claude-sonnet-5-5",
    auth: "api_key",
    connected: true,
    params: { temperature: 0, max_tokens: 4000 },
    fallbacks: [],
    degraded: false,
    reason: null,
  };
}

async function openRecorder(): Promise<RunRecorder> {
  const recorder = new RunRecorder({
    workspace_id: "default",
    stage: "S2",
    module_id: `kan91-${run}`,
    module_version: "1.0.0",
    actor: ACTOR,
    input: {},
  });
  await openRun(recorder);
  return recorder;
}

beforeAll(() => {
  vi.stubEnv("ANTHROPIC_API_KEY", FAKE_KEY);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("KAN-91 provider usage", () => {
  it("reads Anthropic, OpenAI/OpenRouter and Gemini token counts", () => {
    expect(usageFromPayload(anthropicReply("{}"))).toEqual({ input_tokens: 1300, output_tokens: 300, total_tokens: 1600, reasoning_tokens: null });
    expect(
      usageFromPayload({
        choices: [],
        usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70, completion_tokens_details: { reasoning_tokens: 8 } },
      }),
    ).toEqual({ input_tokens: 50, output_tokens: 20, total_tokens: 70, reasoning_tokens: 8 });
    expect(
      usageFromPayload({ candidates: [], usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 10, thoughtsTokenCount: 5, totalTokenCount: 55 } }),
    ).toEqual({ input_tokens: 40, output_tokens: 15, total_tokens: 55, reasoning_tokens: 5 });
    expect(usageFromPayload({ content: [] })).toBeNull();
  });

  it("hands usage to the hook and still returns plain text", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply(anthropicReply('{"ok":true}'))));
    const onUsage = vi.fn();
    const text = await anthropicClaude.complete(
      { system: "s", user: "u", model: "claude-sonnet-5-5", temperature: 0, max_tokens: 100 },
      { api_key: FAKE_KEY },
      { onUsage },
    );
    expect(text).toBe('{"ok":true}');
    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({ input_tokens: 1300, output_tokens: 300 }));

    vi.stubGlobal("fetch", vi.fn(async () => reply({ choices: [{ message: { content: "{}" } }], usage: { prompt_tokens: 3, completion_tokens: 2 } })));
    const openAiUsage = vi.fn();
    await openAi.complete({ system: "s", user: "u", model: "gpt-5.1", temperature: 0, max_tokens: 10 }, { api_key: "k" }, { onUsage: openAiUsage });
    expect(openAiUsage).toHaveBeenCalledWith(expect.objectContaining({ input_tokens: 3, output_tokens: 2, total_tokens: 5 }));

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reply({ candidates: [{ content: { parts: [{ text: "{}" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 1 } })),
    );
    const geminiUsage = vi.fn();
    await googleGemini.complete({ system: "s", user: "u", model: "gemini-3.8-flash", temperature: 0, max_tokens: 10 }, { api_key: "k" }, { onUsage: geminiUsage });
    expect(geminiUsage).toHaveBeenCalledWith(expect.objectContaining({ input_tokens: 9, output_tokens: 1 }));
  });

  it("estimates cost from the price table, and says unknown (null) rather than 0", () => {
    expect(priceKeyFor("anthropic-claude", "claude-sonnet-5-5")).toEqual({ provider_id: "anthropic", model: "claude-sonnet-5-5" });
    expect(priceKeyFor("openrouter", "x-ai/grok-4")).toEqual({ provider_id: "xai", model: "grok-4" });
    const known = estimateCallCost({ provider_id: "xai-grok", model: "grok-4", usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 } });
    expect(known.cost_usd).toBe(18);
    expect(estimateCallCost({ provider_id: "openrouter", model: "mistral/large", usage: { input_tokens: 10, output_tokens: 10 } }).cost_usd).toBeNull();
    // An OpenRouter ":free" model is known to cost nothing, not unknown.
    expect(estimateCallCost({ provider_id: "openrouter", model: "nvidia/nemotron-3-super-120b-a12b:free", usage: { input_tokens: 10, output_tokens: 10 } })).toEqual({ cost_usd: 0, price_source: "openrouter_free_model" });
    expect(estimateCallCost({ provider_id: "xai-grok", model: "grok-4", usage: { input_tokens: null, output_tokens: null } }).cost_usd).toBeNull();
  });

  it("redacts provider keys and key-shaped secrets from prompts", () => {
    const text = redactPromptSecrets(`key ${FAKE_KEY}; Authorization: Bearer abcdefghijklmnop1234; {"api_key": "hunter22"}`);
    expect(text).not.toContain(FAKE_KEY);
    expect(text).not.toContain("abcdefghijklmnop1234");
    expect(text).not.toContain("hunter22");
  });
});

describe("KAN-91 llm_calls", () => {
  let runId = "";

  it("stores each call whole, and the trace step names it", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        // The first reply is not JSON, so the call is asked for again.
        return reply(anthropicReply(calls === 1 ? "not json" : '{"gaps":[]}'));
      }),
    );
    const recorder = await openRecorder();
    runId = recorder.id;
    const longUser = `Source text ${"x".repeat(60_000)} end`;
    const complete = completionFor(route(), recorder);
    const result = await complete({ system: `You extract gaps. Never echo ${FAKE_KEY}.`, user: longUser, purpose: "gap-extract" });
    expect(result).toEqual({ gaps: [] });
    await closeRun({ recorder, status: "ok", route: route() });

    const stored = await listLlmCalls(runId);
    expect(stored.map((call) => call.attempt)).toEqual([1, 2]);
    const [first, second] = stored;
    expect(first).toMatchObject({
      run_id: runId,
      stage: "S2",
      workspace_id: "default",
      step: "llm:gap-extract",
      purpose: "gap-extract",
      provider_id: "anthropic-claude",
      model: "claude-sonnet-5-5",
      // Claude 5 is called without temperature, so the log records none (KAN-71).
      params: { temperature: null, max_tokens: 4000 },
      reply: "not json",
      status: "ok",
      usage: { input_tokens: 1300, output_tokens: 300 },
    });
    // Untruncated, with the key removed.
    expect(first!.user_prompt).toBe(longUser);
    expect(first!.system_prompt).not.toContain(FAKE_KEY);
    expect(first!.cost_usd).toBeGreaterThan(0);
    expect(first!.latency_ms).toBeGreaterThanOrEqual(0);
    expect(second!.system_prompt).toMatch(/not valid JSON/);

    const traced = (await getRun(runId))!.steps.filter((step) => step.name === "llm:gap-extract");
    expect(traced.map((step) => (step.data as { llm_call_id: string }).llm_call_id)).toEqual(stored.map((call) => call.id));
  });

  it("keeps a failed call too, and the failed step names it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply({ type: "error", error: { type: "invalid_request_error", message: "bad model" } }, 400)));
    const recorder = await openRecorder();
    await expect(completionFor(route(), recorder)({ system: "s", user: "u", purpose: "gap-extract" })).rejects.toThrow();
    await closeRun({ recorder, status: "error", error: "bad model", route: route() });
    const [call] = await listLlmCalls(recorder.id);
    expect(call).toMatchObject({ status: "error", reply: null, usage: null, cost_usd: null });
    expect(call!.error).toMatch(/bad model|400/);
    const step = (await getRun(recorder.id))!.steps.find((row) => row.name === "llm:gap-extract");
    expect(step!.data).toMatchObject({ llm_call_id: call!.id });
  });

  it("totals tokens and cost per run and per stage", async () => {
    const calls = await listLlmCalls(runId);
    const totals = totalsOf(calls);
    expect(totals).toMatchObject({ calls: 2, input_tokens: 2600, output_tokens: 600, total_tokens: 3200, unpriced: 0 });
    expect(totals.cost_usd).toBeGreaterThan(0);
    const byStage = await llmTotalsByStage("default");
    expect(byStage.S2!.calls).toBeGreaterThanOrEqual(2);
  });

  it("the run page lists the calls with collapsible prompts and reply, and the API returns them", async () => {
    const calls = await listLlmCalls(runId);
    const html = renderToStaticMarkup(createElement(LlmCallList, { calls }));
    expect(html).toContain("Model calls");
    expect(html).toContain("<details");
    expect(html).toContain("System prompt");
    expect(html).toContain("User prompt");
    expect(html).toContain("Reply");
    expect(html).toContain("not json");
    expect(html).toContain(`id="${calls[0]!.id}"`);
    const totals = renderToStaticMarkup(createElement(LlmTotalsLine, { calls }));
    expect(totals).toContain("2,600");
    expect(renderToStaticMarkup(createElement(LlmTotalsLine, { calls: [] }))).toContain("No model calls");

    const response = await runGet(new Request(`http://localhost/api/runs/${runId}`), { params: Promise.resolve({ id: runId }) });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { llm_calls: unknown[]; llm_totals: { calls: number } };
    expect(body.llm_calls).toHaveLength(2);
    expect(body.llm_totals.calls).toBe(2);
  });
});

describe("KAN-91 upload retention", () => {
  it("an S0 run keeps each upload's hash, size, name and stored file, never its content", async () => {
    const text = `KAN-91 retention ${run}: payers asked about over-75s.`;
    const base64 = Buffer.from(`binary ${run}`).toString("base64");
    const result = await runStage({
      stage: "S0",
      input: {
        files: [
          { filename: `kan91-${run}.txt`, title: "Retention text", source_type: "stakeholder_interview", stakeholder_function: "heor", text },
          { filename: `kan91-${run}.docx`, title: "Retention file", source_type: "stakeholder_interview", stakeholder_function: "heor", content_base64: base64, mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
        ],
      },
      actor: ACTOR,
      role: "medical_affairs",
    });
    const stored = await getRun(result.run_id);
    const serialized = JSON.stringify([stored!.input, stored!.steps]);
    expect(serialized).not.toContain(text);
    expect(serialized).not.toContain(base64);
    const files = (stored!.input as { files: Record<string, unknown>[] }).files;
    const ids = new Set((await listSourceFiles()).map((file) => file.id));
    for (const file of files) {
      expect(file).toMatchObject({ sha256: expect.stringMatching(/^[0-9a-f]{64}$/), bytes: expect.any(Number) });
      expect(file).not.toHaveProperty("text");
      expect(file).not.toHaveProperty("content_base64");
      expect(ids.has(String(file.stored_file_id))).toBe(true);
    }
    expect(files[0]).toMatchObject({ filename: `kan91-${run}.txt`, bytes: Buffer.byteLength(text), content: "text" });
    expect(files[1]).toMatchObject({ content: "base64", bytes: `binary ${run}`.length });
  });
});
