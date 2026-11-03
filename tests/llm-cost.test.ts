import { describe, expect, it } from "vitest";
import { estimateCallCost, estimateCostUsd, estimateTokensFromText, listModelPrices, priceForModel, priceKeyFor, usageFromMessages } from "@/modules/llm/cost";

describe("LLM cost estimates", () => {
  it.each([
    ["xai", "grok-4", 3, 15],
    ["anthropic", "claude-sonnet-4-20250514", 3, 15],
    ["openai", "gpt-4.1", 2, 8],
    ["google", "gemini-2.5-pro", 1.25, 10],
  ])("preserves exact prices for %s/%s", (provider_id, model, input, output) => {
    const usage = { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 };
    const price = priceForModel(provider_id, model);
    const result = estimateCostUsd({ provider_id, model, usage });
    expect(price).toMatchObject({ input_per_million: input, output_per_million: output });
    expect(result).toEqual({ cost_usd: Number(input) + Number(output), price_source: price?.source_url });
  });

  it.each([
    ["xai-grok", "grok-4", "xai", "grok-4", 18],
    ["anthropic-claude", "claude-sonnet-4.5", "anthropic", "claude-sonnet-4.5", 18],
    ["google-gemini", "gemini-2.5-pro", "google", "gemini-2.5-pro", 11.25],
    ["openrouter", "x-ai/grok-4", "xai", "grok-4", 18],
    ["openrouter", "anthropic/claude-sonnet-4.5", "anthropic", "claude-sonnet-4.5", 18],
    ["openrouter", "openai/gpt-4.1", "openai", "gpt-4.1", 10],
    ["openrouter", "google/gemini-2.5-pro", "google", "gemini-2.5-pro", 11.25],
  ])("maps routed alias %s/%s", (provider_id, model, provider, mappedModel, cost) => {
    const usage = { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 };
    const key = priceKeyFor(String(provider_id), String(model));
    const result = estimateCostUsd({ provider_id: String(provider_id), model: String(model), usage });
    expect(key).toEqual({ provider_id: provider, model: mappedModel });
    expect(result.cost_usd).toBe(cost);
  });

  it("returns null for unknown prices", () => {
    const args = { provider_id: "unknown", model: "unknown", usage: { prompt_tokens: 1, completion_tokens: 1 } };
    const result = estimateCostUsd(args);
    expect(priceForModel(args.provider_id, args.model)).toBeNull();
    expect(result).toEqual({ cost_usd: null, price_source: null });
  });

  it.each([
    [null, null, null], [null, 1_000_000, 8], [1_000_000, null, 2], [0, 0, 0],
  ])("preserves missing and zero usage semantics (%s, %s)", (input_tokens, output_tokens, expected) => {
    const args = { provider_id: "openai", model: "gpt-4.1", usage: { input_tokens, output_tokens } };
    const result = estimateCallCost(args);
    expect(result).toEqual({ cost_usd: expected, price_source: expected === null ? null : "https://openai.com/api/pricing/" });
  });

  it.each(["maker/model:free", "openrouter/free"])("prices free model %s at zero", (model) => {
    const args = { provider_id: "openrouter", model, usage: { prompt_tokens: 100, completion_tokens: 200 } };
    const result = estimateCostUsd(args);
    expect(result).toEqual({ cost_usd: 0, price_source: "openrouter_free_model" });
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
    prices.pop();
    expect(listModelPrices()).toHaveLength(4);
  });
});
