/** Pure Development cost evidence: exact price identities, explicit unknowns and no billing guesses. */
import { MODEL_PRICES, type ModelPrice } from '@/accuracy/kernel/cost';
import type { LlmRequest, LlmUsage } from '@/modules/llm/provider';
export const COST_CATEGORIES = ['source_preparation', 'reference_preparation', 'proposer', 'critic', 'reviser', 'internal_judge', 'structural_repairs', 'json_retries', 'pair_assessments', 'external_evaluation'] as const;
export type CostCategory = typeof COST_CATEGORIES[number];
export type PriceEvidence = ModelPrice & { routed_provider_id: string; routed_model: string };
export type UsageCost = { cost_usd: number | null; price: PriceEvidence | null; reason: string | null };
export type RawCallBound = UsageCost & { input_utf8_bytes: number; input_tokens_upper: null; output_tokens_requested: number };
export type CostEstimate = { currency: 'USD'; total_usd: number | null; uncertainty: string[]; http_max_attempts: 1; categories: { category: CostCategory; calls_min: number; calls_max: number | null; cost_usd: number | null; reason: string }[] };
/** Match only exact served model IDs; aliases identify the same direct provider, never a reseller price. */
export function exactDevelopmentPrice(providerId: string, model: string): PriceEvidence | null {
  const direct: Record<string, string> = { 'xai-grok': 'xai', 'anthropic-claude': 'anthropic', 'google-gemini': 'google' };
  const row = MODEL_PRICES.find(price => price.provider_id === (direct[providerId] ?? providerId) && price.model === model);
  return row ? { ...row, routed_provider_id: providerId, routed_model: model } : null;
}
/** Price only complete provider counts; partial/mixed/estimated historical usage stays unknown. */
export function developmentUsageCost(providerId: string, model: string, usage: LlmUsage | null): UsageCost {
  const price = exactDevelopmentPrice(providerId, model);
  if (!price) return { cost_usd: null, price, reason: 'No exact provider/model price is available.' };
  if (!usage || usage.source !== 'provider' || usage.input_tokens_source === 'estimated' || usage.output_tokens_source === 'estimated' || ![usage.input_tokens, usage.output_tokens].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0)) return { cost_usd: null, price, reason: 'Complete provider-reported token counts are unavailable.' };
  const cost = (usage.input_tokens! * price.input_per_million + usage.output_tokens! * price.output_per_million) / 1_000_000;
  return Number.isFinite(cost) ? { cost_usd: cost, price, reason: null } : { cost_usd: null, price, reason: 'Usage exceeds the supported numeric range.' };
}
/** UTF-8 bytes are evidence, not a ceiling: adapters do not guarantee framing/hidden token bounds. */
export function rawCallBound(providerId: string, request: LlmRequest): RawCallBound {
  const price = exactDevelopmentPrice(providerId, request.model);
  return { cost_usd: null, price, input_utf8_bytes: new TextEncoder().encode(request.system + request.user).length, input_tokens_upper: null, output_tokens_requested: request.max_tokens, reason: price ? 'Provider tokenization, framing overhead and billed output bounds are not verified; acknowledge unknown charges.' : 'No exact provider/model price or verified raw request bound; acknowledge unknown charges.' };
}
/** Preview dynamic costs honestly; local snapshots/preparation make no new provider request. */
export function estimateDevelopmentCost(input: { target?: string; mode?: string; evaluation_only?: boolean } = {}): CostEstimate {
  const sections = input.target === 'all' ? 4 : 1;
  const agentic = input.mode !== 'single_pass';
  const categories = COST_CATEGORIES.map(category => {
    const local = category === 'source_preparation' || category === 'reference_preparation';
    const disabled = input.evaluation_only ? !local && category !== 'external_evaluation' : !agentic && ['critic', 'reviser', 'internal_judge'].includes(category);
    const min = local || disabled || ['structural_repairs', 'json_retries', 'pair_assessments', 'external_evaluation'].includes(category) ? 0 : sections;
    return { category, calls_min: min, calls_max: local || disabled ? 0 : null, cost_usd: local || disabled ? 0 : null, reason: local ? 'Existing snapshot/local preparation: no new provider call. Future preparation is not already paid.' : disabled ? 'Not requested in this mode.' : 'Actual prompts, output cardinality, repairs and evaluator choices determine calls; no finite total is promised.' };
  });
  return { currency: 'USD', total_usd: null, uncertainty: ['Dynamic call counts and unverified provider request bounds prevent a finite conservative total.', 'Unknown charges and in-flight requests can exceed an allowance; acknowledgment is execution scoped.'], http_max_attempts: 1, categories };
}
