import { afterEach, describe, expect, it, vi } from "vitest";
import { anthropicAcceptsTemperature, anthropicText, findProvider } from "@/modules/llm/provider";

/**
 * KAN-71: Claude 5 models reject `temperature`, adaptive thinking splits one
 * answer across text blocks, and a refusal or a cut-off reply must never reach
 * a stage as text it then tries to parse.
 */

afterEach(() => vi.unstubAllGlobals());

const KEY = "sk-ant-test-not-a-real-key";

function capture(payload: unknown) {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return new Response(JSON.stringify(payload), { status: 200 });
    }),
  );
  return bodies;
}

const ask = (model: string) =>
  findProvider("anthropic-claude")!.complete(
    { system: "s", user: "u", model, temperature: 0, max_tokens: 64 },
    { api_key: KEY },
  );

describe("which Claude models take temperature", () => {
  it("Claude 5 and Opus 4.7/4.8 do not; older models do", () => {
    for (const model of [
      "claude-sonnet-5-5",
      "claude-opus-5-5",
      "claude-opus-5",
      "claude-sonnet-5",
      "claude-fable-5-1",
      "claude-opus-4-8",
      "claude-opus-4-7",
    ]) {
      expect(anthropicAcceptsTemperature(model), model).toBe(false);
    }
    for (const model of ["claude-haiku-4-5-20251001", "claude-haiku-4-5", "claude-sonnet-4-6", "claude-opus-4-6", "claude-sonnet-4-5"]) {
      expect(anthropicAcceptsTemperature(model), model).toBe(true);
    }
  });
});

describe("the request Synapse sends to Anthropic", () => {
  const OK = { stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] };

  it("leaves temperature out for claude-sonnet-5-5, the default model", async () => {
    const bodies = capture(OK);
    await expect(ask("claude-sonnet-5-5")).resolves.toBe("ok");
    expect(bodies[0]).not.toHaveProperty("temperature");
    expect(bodies[0]).toMatchObject({ model: "claude-sonnet-5-5", max_tokens: 64, system: "s" });
  });

  it("the provider tells the call log when temperature is not sent", () => {
    const claude = findProvider("anthropic-claude")!;
    expect(claude.sendsTemperature?.("claude-sonnet-5-5")).toBe(false);
    expect(claude.sendsTemperature?.("claude-haiku-4-5-20251001")).toBe(true);
    // Providers without the hook always send it.
    expect(findProvider("openai")!.sendsTemperature).toBeUndefined();
  });

  it("still sends it to a model that accepts it", async () => {
    const bodies = capture(OK);
    await ask("claude-haiku-4-5-20251001");
    expect(bodies[0]).toHaveProperty("temperature", 0);
  });
});

describe("reading Claude's reply", () => {
  it("skips thinking blocks and joins text blocks with nothing in between", async () => {
    capture({
      stop_reason: "end_turn",
      content: [
        { type: "thinking", thinking: "" },
        { type: "text", text: '{"name":"Head-to-' },
        { type: "thinking", thinking: "" },
        { type: "text", text: 'head trial"}' },
      ],
    });
    const text = await ask("claude-sonnet-5-5");
    expect(JSON.parse(text)).toEqual({ name: "Head-to-head trial" });
  });

  it("a refusal is an error naming its category", async () => {
    capture({ stop_reason: "refusal", stop_details: { category: "cyber" }, content: [] });
    await expect(ask("claude-sonnet-5-5")).rejects.toThrow(/declined this request \(cyber\)/);
  });

  it("a reply cut off at max_tokens is an error, with or without partial text", async () => {
    capture({ stop_reason: "max_tokens", content: [{ type: "text", text: '{"tactics":[{"na' }] });
    await expect(ask("claude-sonnet-5-5")).rejects.toThrow(/cut off at its max_tokens limit.*Raise Max tokens/);
    expect(() => anthropicText({ stop_reason: "max_tokens", content: [{ type: "thinking", thinking: "" }] })).toThrow(
      /whole max_tokens budget before answering/,
    );
  });

  it("a reply with no text at all is an error, not an empty string", () => {
    expect(() => anthropicText({ stop_reason: "end_turn", content: [{ type: "thinking", thinking: "" }] })).toThrow(/no answer text/);
  });
});
