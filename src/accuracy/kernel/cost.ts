/**
 * Live-ish model pricing (USD per 1M tokens). Updated manually from provider pages;
 * control panel reads this table for estimates because LLM calls do not return billing.
 */
export type ModelPrice = {
  provider_id: string;
  model: string;
  input_per_million: number;
  output_per_million: number;
  source_url: string;
  updated_at: string;
};

export const MODEL_PRICES: ModelPrice[] = [
  {
    provider_id: "xai",
    model: "grok-4",
    input_per_million: 3.0,
    output_per_million: 15.0,
    source_url: "https://docs.x.ai/docs/models",
    updated_at: "2026-09-23",
  },
  {
    provider_id: "anthropic",
    model: "claude-sonnet-4-20250514",
    input_per_million: 3.0,
    output_per_million: 15.0,
    source_url: "https://www.anthropic.com/pricing",
    updated_at: "2026-09-23",
  },
  {
    provider_id: "openai",
    model: "gpt-4.1",
    input_per_million: 2.0,
    output_per_million: 8.0,
    source_url: "https://openai.com/api/pricing/",
    updated_at: "2026-09-23",
  },
  {
    provider_id: "google",
    model: "gemini-2.5-pro",
    input_per_million: 1.25,
    output_per_million: 10.0,
    source_url: "https://ai.google.dev/pricing",
    updated_at: "2026-09-23",
  },
];

export function estimateTokensFromText(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function usageFromMessages(system: string, user: string, completion: string) {
  const prompt_tokens = estimateTokensFromText(system) + estimateTokensFromText(user);
  const completion_tokens = estimateTokensFromText(completion);
  return {
    prompt_tokens,
    completion_tokens,
    total_tokens: prompt_tokens + completion_tokens,
  };
}

export function priceForModel(provider_id: string, model: string): ModelPrice | null {
  const exact = MODEL_PRICES.find((p) => p.provider_id === provider_id && p.model === model);
  if (exact) return exact;
  const prefix = MODEL_PRICES.find(
    (p) => p.provider_id === provider_id && model.startsWith(p.model.split("-")[0] ?? ""),
  );
  return prefix ?? null;
}

export function estimateCostUsd(args: {
  provider_id: string;
  model: string;
  usage: { prompt_tokens: number; completion_tokens: number };
}): { cost_usd: number; price_source: string } {
  const row = priceForModel(args.provider_id, args.model);
  if (!row) {
    return { cost_usd: 0, price_source: "unknown_model" };
  }
  const cost_usd =
    (args.usage.prompt_tokens / 1_000_000) * row.input_per_million +
    (args.usage.completion_tokens / 1_000_000) * row.output_per_million;
  return { cost_usd: Math.round(cost_usd * 1_000_000) / 1_000_000, price_source: row.source_url };
}

export function listModelPrices(): ModelPrice[] {
  return [...MODEL_PRICES];
}

/**
 * The price table's provider and model for a routed call: kernel provider ids
 * (xai-grok, anthropic-claude, google-gemini) map to the table's, and an
 * OpenRouter model ("anthropic/claude-sonnet-4.5") is priced as its maker's.
 */
export function priceKeyFor(provider_id: string, model: string): { provider_id: string; model: string } {
  const KERNEL: Record<string, string> = { "xai-grok": "xai", "anthropic-claude": "anthropic", "google-gemini": "google", openai: "openai" };
  if (provider_id === "openrouter") {
    const [maker, ...rest] = model.split("/");
    const OPENROUTER: Record<string, string> = { "x-ai": "xai", anthropic: "anthropic", openai: "openai", google: "google" };
    return { provider_id: OPENROUTER[maker ?? ""] ?? maker ?? provider_id, model: rest.join("/") || model };
  }
  return { provider_id: KERNEL[provider_id] ?? provider_id, model };
}

/**
 * Estimated cost of one call from the provider's token counts (KAN-91). Null,
 * never 0, when the model's price is unknown or the counts are missing.
 */
export function estimateCallCost(args: {
  provider_id: string;
  model: string;
  usage: { input_tokens: number | null; output_tokens: number | null };
}): { cost_usd: number | null; price_source: string | null } {
  if (args.usage.input_tokens === null && args.usage.output_tokens === null) return { cost_usd: null, price_source: null };
  // OpenRouter's ":free" variants are billed at zero (https://openrouter.ai/docs/api-reference/limits).
  if (args.provider_id === "openrouter" && args.model.endsWith(":free")) {
    return { cost_usd: 0, price_source: "openrouter_free_model" };
  }
  const key = priceKeyFor(args.provider_id, args.model);
  if (!priceForModel(key.provider_id, key.model)) return { cost_usd: null, price_source: null };
  const { cost_usd, price_source } = estimateCostUsd({
    ...key,
    usage: { prompt_tokens: args.usage.input_tokens ?? 0, completion_tokens: args.usage.output_tokens ?? 0 },
  });
  return { cost_usd, price_source };
}
