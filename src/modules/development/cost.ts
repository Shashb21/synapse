/** Development cost evidence and conservative authorization for one provider request. */
import { billedTokenCost, modelBillingLimits, priceForModel, reportedXaiCost, usdForTokens, XAI_COST_EVIDENCE, type ModelPrice } from '@/modules/llm/cost';
import { usesStandardProviderEndpoint } from '@/modules/llm/provider-endpoint';
import type { LlmRequest, LlmUsage } from '@/modules/llm/provider';
export const COST_CATEGORIES = ['source_preparation', 'reference_preparation', 'proposer', 'critic', 'reviser', 'internal_judge', 'structural_repairs', 'json_retries', 'pair_assessments', 'external_evaluation'] as const;
export type CostCategory = typeof COST_CATEGORIES[number];
export type PriceEvidence = ModelPrice & { routed_provider_id: string; routed_model: string };
export type UsageCost = { cost_usd: number | null; price: PriceEvidence | null; reason: string | null; price_source?: string };
export type RawCallBound = UsageCost & {
  input_utf8_bytes: number;
  input_tokens_upper: number | null;
  output_tokens_requested: number;
  output_tokens_upper?: number | null;
  limit_source_url?: string;
};
export type CostEstimate = { currency: 'USD'; total_usd: number | null; uncertainty: string[]; http_max_attempts: 1; categories: { category: CostCategory; calls_min: number; calls_max: number | null; cost_usd: number | null; reason: string }[] };

function priceEvidence(provider: string, model: string, price: ModelPrice): PriceEvidence {
  return { ...price, routed_provider_id: provider, routed_model: model };
}

export function exactDevelopmentPrice(provider: string, model: string, input_tokens?: number, at?: Date, through?: Date): PriceEvidence | null {
  if (!usesStandardProviderEndpoint(provider)) return null;
  const price = priceForModel(provider, model, { input_tokens, at, through });
  return price ? priceEvidence(provider, model, price) : null;
}

function freePrice(price: PriceEvidence | null): boolean {
  return price?.provider_id === 'openrouter' && price.input_per_million === 0 && price.output_per_million === 0;
}

/** Price complete provider counts or an explicit free route. */
export function developmentUsageCost(provider: string, model: string, usage: LlmUsage | null, at?: Date, through?: Date): UsageCost {
  const price = exactDevelopmentPrice(provider, model, usage?.input_tokens ?? undefined, at, through);
  if (freePrice(price)) return { cost_usd: 0, price, reason: null };
  if (!usesStandardProviderEndpoint(provider)) return { cost_usd: null, price: null, reason: 'The provider endpoint has no verified request pricing.' };
  const actual = reportedXaiCost(provider, usage);
  if (actual !== null) return { cost_usd: actual, price: null, price_source: XAI_COST_EVIDENCE, reason: null };
  if (!price) return { cost_usd: null, price, reason: 'The exact rate for this provider, model and request time is unavailable.' };
  if (price.provider_id === 'google') {
    const tier = usage?.service_tier;
    const reason = tier && !['standard', 'unspecified'].includes(tier)
      ? 'The reported Gemini service tier has no verified settlement rate.'
      : 'The Gemini project billing tier is unavailable.';
    return { cost_usd: null, price: null, reason };
  }
  const complete = usage?.source === 'provider' && usage.input_tokens_source !== 'estimated' && usage.output_tokens_source !== 'estimated';
  const billed = complete && billedTokenCost(price, usage);
  if (!billed) return { cost_usd: null, price, reason: 'Complete provider billing evidence is unavailable.' };
  return { cost_usd: billed.cost, price: priceEvidence(provider, model, billed.price), reason: null };
}

/** Old receipts carry token evidence, but lack an attested endpoint and the applied rate. */
export const HISTORICAL_USAGE_COST: UsageCost = {
  cost_usd: null, price: null, reason: 'The saved receipt predates verified billing evidence.',
};

export function developmentReceiptBilling(provider: string, model: string, usage: LlmUsage | null, from: Date, through: Date) {
  const billing = developmentUsageCost(provider, model, usage, from, through);
  return { billing, cost_usd: billing.cost_usd, price_source: billing.cost_usd === null ? null : billing.price_source ?? billing.price?.rate_adjustment_url ?? billing.price?.source_url ?? null };
}

/** Use current provider/model ceilings and published standard rates to fund one send. */
export function rawCallBound(provider: string, request: LlmRequest, at = new Date()): RawCallBound {
  const evidence = {
    input_utf8_bytes: new TextEncoder().encode(request.system + request.user).length,
    input_tokens_upper: null,
    output_tokens_requested: request.max_tokens,
    output_tokens_upper: null,
  };
  const price = exactDevelopmentPrice(provider, request.model, undefined, at);
  if (freePrice(price)) return { ...evidence, cost_usd: 0, price, reason: null };
  const bounded = price && modelBillingLimits(provider, request.model, at);
  if (!bounded || (bounded.price.provider_id === 'xai' && request.max_tokens > bounded.limits.output_tokens_upper)) {
    return {
      ...evidence, cost_usd: null, price,
      reason: `A verified spending limit is unavailable for ${provider}/${request.model}. Start a new run with a supported priced model such as Grok 3, GPT-5.1 or Claude Sonnet 5.5, or an explicit free route.`,
    };
  }
  return {
    ...evidence,
    input_tokens_upper: bounded.limits.input_tokens_upper,
    output_tokens_upper: bounded.limits.output_tokens_upper,
    limit_source_url: bounded.limits.source_url,
    price: priceEvidence(provider, request.model, bounded.price),
    cost_usd: usdForTokens(bounded.price, bounded.limits.input_tokens_upper, bounded.limits.output_tokens_upper),
    reason: null,
  };
}

/** Preview dynamic costs honestly; local snapshots/preparation make no new provider request. */
export function estimateDevelopmentCost(input: { target?: string; mode?: string; evaluation_only?: boolean } = {}): CostEstimate {
  const sections = input.target === 'all' ? 4 : 1;
  const agentic = input.mode !== 'single_pass';
  const categories = COST_CATEGORIES.map(category => {
    const local = category === 'source_preparation' || category === 'reference_preparation';
    const disabled = input.evaluation_only ? !local && category !== 'external_evaluation' : !agentic && ['critic', 'reviser', 'internal_judge'].includes(category);
    const min = local || disabled || ['structural_repairs', 'json_retries', 'pair_assessments', 'external_evaluation'].includes(category) ? 0 : sections;
    return { category, calls_min: min, calls_max: local || disabled ? 0 : null, cost_usd: local || disabled ? 0 : null, reason: local ? 'Generation and evaluation use saved snapshots. Private file parsing has a separate per-upload allowance.' : disabled ? 'Not requested in this mode.' : 'Actual prompts, output cardinality, repairs and evaluator choices determine calls; no finite total is promised.' };
  });
  return { currency: 'USD', total_usd: null, uncertainty: ['The number of model calls depends on the data and results.', 'Each paid request needs a verified reservation within the remaining allowance.'], http_max_attempts: 1, categories };
}
