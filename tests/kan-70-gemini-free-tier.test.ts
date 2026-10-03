import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findProvider, geminiText, RETRY } from "@/modules/llm/provider";
import { classifyProviderError, ProviderError } from "@/modules/llm/provider-error";
import { customerErrorMessage } from "@/modules/kernel/stage-errors";

/** KAN-70: the free Gemini tier works as the test LLM. */
const SECRET = "AIzaTEST-not-a-real-key-123456";
const REQUEST = { system: "s", user: "u", model: "gemini-3.8-flash", temperature: 0, max_tokens: 64 };
const OK = { candidates: [{ content: { parts: [{ text: '{"ok":true}' }] }, finishReason: "STOP" }] };

/** Gemini's free-tier 429 body, as the API sends it. */
function quota429(quotaId: string, retryDelay = "3s") {
  return JSON.stringify({
    error: {
      code: 429,
      status: "RESOURCE_EXHAUSTED",
      message:
        "You exceeded your current quota, please check your plan and billing details. Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests",
      details: [
        { "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId }] },
        { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay },
      ],
    },
  });
}

let waits: number[];
let bodies: Record<string, unknown>[];
const realSleep = RETRY.sleep;

function respond(...replies: Array<{ status: number; body: string }>) {
  const queue = [...replies];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      const next = queue.shift() ?? { status: 200, body: JSON.stringify(OK) };
      return new Response(next.body, { status: next.status });
    }),
  );
}

const gemini = () => findProvider("google-gemini")!.complete(REQUEST, { api_key: SECRET });

beforeEach(() => {
  waits = [];
  bodies = [];
  RETRY.sleep = async (ms: number) => {
    waits.push(ms);
  };
});

afterEach(() => {
  RETRY.sleep = realSleep;
  vi.unstubAllGlobals();
});

describe("KAN-70 Gemini free tier", () => {
  it("asks for JSON and returns the reply text", async () => {
    respond();
    await expect(gemini()).resolves.toBe('{"ok":true}');
    expect((bodies[0]!.generationConfig as Record<string, unknown>).responseMimeType).toBe("application/json");
  });

  it("calls a free-tier 429 a rate limit, not billing; OpenAI's insufficient_quota is still billing", () => {
    expect(classifyProviderError(429, "RESOURCE_EXHAUSTED", "You exceeded your current quota, please check your plan and billing details.")).toBe(
      "rate_limit",
    );
    expect(classifyProviderError(429, "insufficient_quota", "You exceeded your current quota")).toBe("billing");
    expect(classifyProviderError(400, "invalid_request_error", "Your credit balance is too low")).toBe("billing");
  });

  it("waits what Gemini asks for after a per-minute 429, then succeeds", async () => {
    respond({ status: 429, body: quota429("GenerateRequestsPerMinutePerProjectPerModel-FreeTier", "7s") });
    await expect(gemini()).resolves.toBe('{"ok":true}');
    expect(waits).toEqual([7_000]);
    expect(bodies).toHaveLength(2);
  });

  it("backs off, capped, and gives up after the last attempt", async () => {
    const busy = { status: 503, body: JSON.stringify({ error: { code: 503, status: "UNAVAILABLE", message: "overloaded" } }) };
    respond(busy, busy, busy, busy);
    await expect(gemini()).rejects.toMatchObject({ kind: "unavailable" });
    expect(bodies).toHaveLength(RETRY.attempts);
    expect(waits).toEqual([2_000, 4_000, 8_000]);
  });

  it("retries a bodiless 404 but not a real model-not-found", async () => {
    respond({ status: 404, body: "" });
    await expect(gemini()).resolves.toBe('{"ok":true}');
    expect(waits).toEqual([2_000]);
    respond({ status: 404, body: JSON.stringify({ error: { code: 404, status: "NOT_FOUND", message: "model not found" } }) });
    await expect(gemini()).rejects.toMatchObject({ kind: "bad_request" });
    expect(waits).toEqual([2_000]);
  });

  it("does not retry a per-day quota, and says so", async () => {
    respond({ status: 429, body: quota429("GenerateRequestsPerDayPerProjectPerModel-FreeTier", "40000s") });
    const error = (await gemini().catch((e: unknown) => e)) as ProviderError;
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.kind).toBe("rate_limit");
    expect(error.message).toMatch(/daily request quota/);
    expect(customerErrorMessage(error)).toMatch(/limit for today/);
    expect(error.message).not.toContain(SECRET);
    expect(waits).toEqual([]);
  });

  it("never retries billing or auth", async () => {
    respond({ status: 402, body: JSON.stringify({ error: { message: "Payment required" } }) });
    await expect(gemini()).rejects.toMatchObject({ kind: "billing" });
    respond({ status: 403, body: JSON.stringify({ error: { message: "API key not valid", status: "PERMISSION_DENIED" } }) });
    await expect(gemini()).rejects.toMatchObject({ kind: "auth" });
    expect(waits).toEqual([]);
  });

  it("names a cut-off or blocked reply instead of returning broken JSON", () => {
    expect(() => geminiText({ candidates: [{ content: { parts: [{ text: '{"a":' }] }, finishReason: "MAX_TOKENS" }] })).toThrow(
      /cut off at its max_tokens limit/,
    );
    expect(() => geminiText({ promptFeedback: { blockReason: "SAFETY" } })).toThrow(/blocked the prompt \(SAFETY\)/);
    expect(() => geminiText({ candidates: [{ content: { parts: [] }, finishReason: "RECITATION" }] })).toThrow(/stopped early/);
  });
});
