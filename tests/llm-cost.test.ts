import { describe, expect, it } from "vitest";
import { estimateCallCost, estimateCostUsd, estimateTokensFromText, listModelPrices, priceForModel, priceKeyFor, usageFromMessages } from "@/modules/llm/cost";

describe("LLM cost estimates", () => {
  it.each([
    ["xai", "grok-4.3", 1.25, 2.5],
    ["anthropic", "claude-sonnet-5-5", 2, 10],
    ["openai", "gpt-4.1", 2, 8],
  ])("uses the documented direct rates for %s/%s", (provider_id, model, input, output) => {
    const usage = { prompt_tokens: 100_000, completion_tokens: 100_000 };
    const price = priceForModel(provider_id, model);
    const result = estimateCostUsd({ provider_id, model, usage });
    expect(price).toMatchObject({ input_per_million: input, output_per_million: output });
    expect(result).toEqual({ cost_usd: (Number(input) + Number(output)) / 10, price_source: price?.source_url });
  });

  it.each([
    ["xai-grok", "grok-4.3-latest", "xai", "grok-4.3", 0.375],
    ["anthropic-claude", "claude-sonnet-5-5", "anthropic", "claude-sonnet-5-5", 1.2],
    ["google-gemini", "gemini-3.8-flash", "google", "gemini-3.8-flash", 0.45],
    ["openrouter", "x-ai/grok-4", "openrouter", "x-ai/grok-4", null],
    ["openrouter", "anthropic/claude-sonnet-4.5", "openrouter", "anthropic/claude-sonnet-4.5", null],
    ["openrouter", "openai/gpt-4.1", "openrouter", "openai/gpt-4.1", null],
  ])("resolves provider-scoped price identity %s/%s", (provider_id, model, provider, mappedModel, cost) => {
    const usage = { prompt_tokens: 100_000, completion_tokens: 100_000 };
    const key = priceKeyFor(String(provider_id), String(model));
    const result = estimateCostUsd({ provider_id: String(provider_id), model: String(model), usage, at: new Date("2026-11-25Z") });
    expect(key).toEqual({ provider_id: provider, model: mappedModel });
    expect(result.cost_usd).toBe(cost);
  });

  it("returns null for unknown prices", () => {
    const args = { provider_id: "unknown", model: "unknown", usage: { prompt_tokens: 1, completion_tokens: 1 } };
    expect(priceForModel(args.provider_id, args.model)).toBeNull();
    expect(estimateCostUsd(args)).toEqual({ cost_usd: null, price_source: null });
  });

  it.each([
    [null, null, null], [null, 1_000_000, null], [1_000_000, null, null], [0, 0, 0],
  ])("preserves missing and zero usage semantics (%s, %s)", (input_tokens, output_tokens, expected) => {
    const result = estimateCallCost({ provider_id: "openai", model: "gpt-4.1", usage: { input_tokens, output_tokens } });
    expect(result).toEqual({ cost_usd: expected, price_source: expected === null ? null : "https://developers.openai.com/api/docs/models/gpt-4.1" });
  });

  it.each(["maker/model:free", "openrouter/free"])("prices free model %s at zero", (model) => {
    const result = estimateCostUsd({ provider_id: "openrouter", model, usage: { prompt_tokens: 100, completion_tokens: 200 } });
    expect(result).toEqual({ cost_usd: 0, price_source: "https://openrouter.ai/collections/free-models/" });
  });

  it.each([["", 1], ["abcd", 1], ["abcde", 2]])("estimates text tokens for %j", (text, expected) => {
    const result = estimateTokensFromText(text);
    expect(result).toBe(expected);
  });

  it("estimates each message separately and totals usage", () => {
    const system = "", user = "abcde", completion = "123456789";
    const result = usageFromMessages(system, user, completion);
    expect(result).toEqual({ prompt_tokens: 3, completion_tokens: 3, total_tokens: 6 });
  });

  it("returns a separate price list array", () => {
    const prices = listModelPrices();
    const count = prices.length;
    prices.pop();
    expect(listModelPrices()).toHaveLength(count);
  });
});
