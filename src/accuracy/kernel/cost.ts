/**
 * Live-ish model pricing (USD per 1M tokens). Updated manually from provider pages;
 * control panel reads this table for estimates when OAuth LLM calls do not return billing APIs.
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

/** Display helper for stored `cost_usd` (numeric → string) or live estimates. */
export function formatCostUsd(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

export function parseCostUsd(value: string | number | null | undefined): number {
  if (value === null || value === undefined || value === "") return 0;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function formatTokenUsage(usage: unknown): string | null {
  if (!usage || typeof usage !== "object") return null;
  const row = usage as {
    total_tokens?: unknown;
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
  };
  const total =
    typeof row.total_tokens === "number"
      ? row.total_tokens
      : typeof row.prompt_tokens === "number" && typeof row.completion_tokens === "number"
        ? row.prompt_tokens + row.completion_tokens
        : null;
  if (total === null || !Number.isFinite(total) || total <= 0) return null;
  return `${Math.round(total).toLocaleString()} tok`;
}

export function sumRunCostsUsd(
  runs: Array<{ cost_usd?: string | number | null }>,
): number {
  return runs.reduce((acc, run) => acc + parseCostUsd(run.cost_usd), 0);
}

