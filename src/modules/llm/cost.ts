import type { LlmUsage } from "./provider";

/** Standard text inference prices in USD per million tokens. */
export type ModelPrice = {
  provider_id: string;
  model: string;
  input_per_million: number;
  output_per_million: number;
  source_url: string;
  updated_at: string;
  route_source_url?: string;
  effective_from?: string;
  effective_until?: string;
  rate_adjustment_url?: string;
  cached_input_per_million?: number;
};

type Limits = { input_tokens_upper: number; output_tokens_upper: number; source_url: string };
type RateCard = {
  provider_id: string;
  model: string;
  ids: readonly string[];
  standard: readonly [input: number, output: number];
  cached_input_per_million?: number;
  long?: { minimum_input: number; rates: RateCard['standard'] };
  source_url: string;
  route_source_url?: string;
  effective_from?: string;
  effective_until?: string;
  limits?: Limits;
};
const CHECKED = '2026-11-25';
const GOOGLE_CUTOVER_UNCERTAINTY_MS = 14 * 60 * 60 * 1000;
export const XAI_COST_EVIDENCE = 'https://docs.x.ai/developers/cost-tracking';
const XAI_PRICE = 'https://docs.x.ai/developers/pricing';
const XAI_REDIRECT = 'https://docs.x.ai/developers/migration/may-15-retirement';
const XAI_MODEL = 'https://docs.x.ai/developers/models/grok-4.3';
const XAI_CHAT = 'https://docs.x.ai/developers/rest-api-reference/inference/chat-completions.md';
const XAI_REDIRECT_DATE = '2026-05-15T19:00:00Z';
const OPENAI_41 = 'https://developers.openai.com/api/docs/models/gpt-4.1';
const OPENAI_51 = 'https://developers.openai.com/api/docs/models/gpt-5.1';
const SONNET_55 = 'https://platform.claude.com/docs/en/models/sonnet-5-5/overview';
const CLAUDE_PRICING = 'https://platform.claude.com/docs/en/about-claude/pricing';
const SONNET_4_RETIREMENT = 'https://platform.claude.com/docs/en/about-claude/model-deprecations';
const GEMINI_PRICE = 'https://ai.google.dev/gemini-api/docs/pricing';
const GEMINI_PRO_MODEL = 'https://ai.google.dev/gemini-api/docs/models/gemini-2.5-pro';
const GEMINI_FLASH_MODEL = 'https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash';
const GEMINI_PRO_REDIRECT = '2026-12-01T00:00:00Z';
const GEMINI_FLASH_INCREASE = '2027-01-01T00:00:00Z';
const FREE_ROUTER = 'https://openrouter.ai/collections/free-models/';
const GROK_43 = {
  provider_id: 'xai', model: 'grok-4.3', standard: [1.25, 2.50],
  long: { minimum_input: 200_000, rates: [2.50, 5] }, source_url: XAI_PRICE,
} as const;
const GEMINI_FLASH = {
  provider_id: 'google', model: 'gemini-3.8-flash', source_url: GEMINI_PRICE,
  limits: { input_tokens_upper: 1_048_576, output_tokens_upper: 65_536, source_url: GEMINI_FLASH_MODEL },
} as const;

const RATE_CARDS: readonly RateCard[] = [
  { ...GROK_43, ids: ['grok-4.3', 'grok-4.3-latest'], route_source_url: XAI_MODEL },
  { ...GROK_43, ids: ['grok-4-0709', 'grok-4-1-fast-reasoning', 'grok-4-fast-reasoning'],
    route_source_url: XAI_REDIRECT, effective_from: XAI_REDIRECT_DATE },
  // These redirects disable hidden reasoning. The text-only adapter has no tools
  // and never raises Chat Completions' documented 128K default output ceiling.
  { ...GROK_43, ids: ['grok-3', 'grok-4-1-fast-non-reasoning', 'grok-4-fast-non-reasoning'],
    route_source_url: XAI_REDIRECT, effective_from: XAI_REDIRECT_DATE,
    limits: { input_tokens_upper: 1_000_000, output_tokens_upper: 128_000, source_url: XAI_CHAT } },
  { provider_id: 'anthropic', model: 'claude-sonnet-4-20250514', ids: ['claude-sonnet-4-20250514'], standard: [3, 15],
    source_url: CLAUDE_PRICING,
    route_source_url: SONNET_4_RETIREMENT, effective_until: '2026-06-15T00:00:00Z' },
  { provider_id: 'anthropic', model: 'claude-sonnet-5-5', ids: ['claude-sonnet-5-5'], standard: [2, 10], cached_input_per_million: 0.10, source_url: CLAUDE_PRICING,
    limits: { input_tokens_upper: 1_000_000, output_tokens_upper: 128_000, source_url: SONNET_55 } },
  { provider_id: 'openai', model: 'gpt-4.1', ids: ['gpt-4.1', 'gpt-4.1-2025-04-14'], standard: [2, 8], cached_input_per_million: 0.5, source_url: OPENAI_41,
    limits: { input_tokens_upper: 1_047_576, output_tokens_upper: 32_768, source_url: OPENAI_41 } },
  { provider_id: 'openai', model: 'gpt-5.1', ids: ['gpt-5.1', 'gpt-5.1-2025-11-13'], standard: [1.25, 10], cached_input_per_million: 0.125, source_url: OPENAI_51,
    limits: { input_tokens_upper: 400_000, output_tokens_upper: 128_000, source_url: OPENAI_51 } },
  { provider_id: 'google', model: 'gemini-2.5-pro', ids: ['gemini-2.5-pro'], standard: [1.25, 10],
    long: { minimum_input: 200_001, rates: [2.5, 15] }, source_url: GEMINI_PRICE, route_source_url: GEMINI_PRO_MODEL,
    effective_until: GEMINI_PRO_REDIRECT,
    limits: { input_tokens_upper: 1_048_576, output_tokens_upper: 65_536, source_url: GEMINI_PRO_MODEL } },
  { ...GEMINI_FLASH, ids: ['gemini-3.8-flash'], standard: [0.75, 3.75], effective_until: GEMINI_FLASH_INCREASE },
  { ...GEMINI_FLASH, ids: ['gemini-3.8-flash'], standard: [1.50, 7.50], effective_from: GEMINI_FLASH_INCREASE },
  { ...GEMINI_FLASH, ids: ['gemini-2.5-pro'], standard: [0.75, 3.75], route_source_url: GEMINI_PRO_MODEL,
    effective_from: GEMINI_PRO_REDIRECT, effective_until: GEMINI_FLASH_INCREASE },
  { ...GEMINI_FLASH, ids: ['gemini-2.5-pro'], standard: [1.50, 7.50], route_source_url: GEMINI_PRO_MODEL,
    effective_from: GEMINI_FLASH_INCREASE },
];

const PROVIDER_IDS: Readonly<Record<string, string>> = { 'xai-grok': 'xai', 'anthropic-claude': 'anthropic', 'google-gemini': 'google' };
const providerKey = (id: string): string => Object.hasOwn(PROVIDER_IDS, id) ? PROVIDER_IDS[id] : id;
const isOpenRouterFree = (provider: string, model: string): boolean =>
  provider === 'openrouter' && (model === 'openrouter/free' || /^[\w.-]+\/[\w.-]+:free$/.test(model));

function matchingCards(provider: string, model: string): RateCard[] {
  return RATE_CARDS.filter(card => card.provider_id === providerKey(provider) && card.ids.includes(model));
}

function modelPrice(card: RateCard, inputTokens: number): ModelPrice {
  const rates = card.long && inputTokens >= card.long.minimum_input ? card.long.rates : card.standard;
  return {
    provider_id: card.provider_id, model: card.model, input_per_million: rates[0], output_per_million: rates[1],
    source_url: card.source_url, updated_at: CHECKED,
    ...(card.cached_input_per_million === undefined ? {} : { cached_input_per_million: card.cached_input_per_million }),
    ...(card.route_source_url ? { route_source_url: card.route_source_url } : {}),
    ...(card.effective_from ? { effective_from: card.effective_from } : {}),
    ...(card.effective_until ? { effective_until: card.effective_until } : {}),
  };
}

function activeAt(card: RateCard, at: Date): boolean {
  const time = at.getTime();
  return Number.isFinite(time) && (!card.effective_from || time >= Date.parse(card.effective_from))
    && (!card.effective_until || time < Date.parse(card.effective_until));
}

/** Exact direct-provider model, snapshot, documented redirect, or explicitly free OpenRouter route. */
export function priceForModel(provider_id: string, model: string, options: { input_tokens?: number; at?: Date; through?: Date } = {}): ModelPrice | null {
  if (isOpenRouterFree(provider_id, model)) {
    return { provider_id, model, input_per_million: 0, output_per_million: 0, source_url: FREE_ROUTER, updated_at: CHECKED };
  }
  const at = options.at ?? new Date();
  const card = matchingCards(provider_id, model).find(entry => activeAt(entry, at));
  if (!card || (options.through && !activeAt(card, options.through))) return null;
  if (options.through && card.provider_id === 'google') {
    // Google publishes dates without a time zone. In the possible transition
    // window, only an independently verified billing receipt could choose a rate.
    const boundaries = [card.effective_from, card.effective_until];
    if (boundaries.some(date => date && at.getTime() <= Date.parse(date) + GOOGLE_CUTOVER_UNCERTAINTY_MS
      && options.through!.getTime() >= Date.parse(date) - GOOGLE_CUTOVER_UNCERTAINTY_MS)) return null;
  }
  return modelPrice(card, options.input_tokens ?? 0);
}

/** Cover Claude's workspace-selected US inference premium without changing its data residency. */
export function maximumWorkspaceRate(price: ModelPrice): ModelPrice {
  if (price.provider_id !== 'anthropic' || price.model !== 'claude-sonnet-5-5') return price;
  return {
    ...price,
    input_per_million: 2.20,
    output_per_million: 11,
    cached_input_per_million: 0.11,
    rate_adjustment_url: `${CLAUDE_PRICING}#data-residency-pricing`,
  };
}

/**
 * Full per-model ceilings include provider tokenization/framing. For dated prices,
 * reserve against every applicable future rate for the exact route, including a
 * redirect that could take effect between reserving and provider acceptance.
 */
export function modelBillingLimits(provider: string, model: string, at: Date): { price: ModelPrice; limits: Limits } | null {
  const cards = matchingCards(provider, model);
  if (!cards.some(card => activeAt(card, at))) return null;
  let highest: { price: ModelPrice; limits: Limits; cost: number } | null = null;
  for (const card of cards) {
    const grace = card.provider_id === 'google' ? GOOGLE_CUTOVER_UNCERTAINTY_MS : 0;
    if (card.effective_until && Date.parse(card.effective_until) + grace < at.getTime()) continue;
    if (!card.limits) return null;
    const price = maximumWorkspaceRate(modelPrice(card, card.limits.input_tokens_upper));
    const cost = usdForTokens(price, card.limits.input_tokens_upper, card.limits.output_tokens_upper);
    if (!highest || cost > highest.cost) highest = { price, limits: card.limits, cost };
  }
  return highest && { price: highest.price, limits: highest.limits };
}

export function isTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function usdForTokens(price: ModelPrice, input: number, output: number, cached = 0): number {
  // Rates are recorded to a thousandth of a dollar per million tokens.
  const regularInput = (input - cached) * Math.round(price.input_per_million * 1000);
  const cachedInput = cached * Math.round((price.cached_input_per_million ?? price.input_per_million) * 1000);
  return (regularInput + cachedInput + output * Math.round(price.output_per_million * 1000)) / 1_000_000_000;
}

/** Estimates tokens at four characters per token, with a minimum of one. */
export function estimateTokensFromText(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/** Estimates each message separately and totals prompt and completion usage. */
export function usageFromMessages(system: string, user: string, completion: string) {
  const prompt_tokens = estimateTokensFromText(system) + estimateTokensFromText(user);
  const completion_tokens = estimateTokensFromText(completion);
  return { prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens };
}

/** The documented price identity, scoped to the call's own provider. */
export function priceKeyFor(provider_id: string, model: string): { provider_id: string; model: string } {
  const price = priceForModel(provider_id, model);
  return { provider_id: price?.provider_id ?? providerKey(provider_id), model: price?.model ?? model };
}

export function listModelPrices(): ModelPrice[] {
  const at = new Date();
  return RATE_CARDS.filter(card => card.ids.includes(card.model) && activeAt(card, at)).map(card => modelPrice(card, 0));
}

type PriceRequest = { provider_id: string; model: string; at?: Date; through?: Date };
type BillingUsage = Pick<LlmUsage, 'input_tokens' | 'output_tokens' | 'input_tokens_source' | 'service_tier' | 'inference_geo'
  | 'cached_input_tokens' | 'cache_written_input_tokens' | 'cost_in_usd_ticks' | 'prior_charge_unknown' | 'malformed_token_details'>
  & Partial<Pick<LlmUsage, 'total_tokens' | 'reasoning_tokens'>>;

/** Published standard paid rates for estimating spend. */
export function estimateCostUsd(args: PriceRequest & { usage: { prompt_tokens: number; completion_tokens: number } }) {
  const price = priceForModel(args.provider_id, args.model, { input_tokens: args.usage.prompt_tokens, at: args.at, through: args.through });
  if (!price || !isTokenCount(args.usage.prompt_tokens) || !isTokenCount(args.usage.completion_tokens)) {
    return { cost_usd: null, price_source: null };
  }
  return { cost_usd: usdForTokens(price, args.usage.prompt_tokens, args.usage.completion_tokens), price_source: price.source_url };
}

/** A provider-reported xAI request charge already includes reasoning and cache pricing. */
export function reportedXaiCost(provider: string, usage: BillingUsage | null): number | null {
  if (providerKey(provider) !== 'xai' || usage?.prior_charge_unknown || !isTokenCount(usage?.cost_in_usd_ticks)) return null;
  return usage.cost_in_usd_ticks / 10_000_000_000;
}

/** Use the received pricing components when they establish a documented rate. */
export function billedTokenCost(price: ModelPrice, usage: BillingUsage | null): { cost: number; price: ModelPrice } | null {
  // Gemini's GenerateContent metadata reports usage and service level. The API
  // key inherits the project's free or paid billing tier, which the reply omits.
  if (price.provider_id === 'google') return null;
  if (usage?.prior_charge_unknown || (usage?.service_tier && !['default', 'standard'].includes(usage.service_tier))) return null;
  const input = usage?.input_tokens;
  const output = usage?.output_tokens;
  if (!isTokenCount(input) || !isTokenCount(output)) return null;
  const cached = usage?.cached_input_tokens;
  if (price.provider_id === 'openai') {
    const total = usage?.total_tokens;
    const reasoning = usage?.reasoning_tokens;
    // The Chat Completions total is prompt plus completion. Reasoning is a
    // component of completion, so adding it again would overstate the charge.
    if (usage?.malformed_token_details || !isTokenCount(input + output) || (total != null && total !== input + output)
      || (reasoning != null && (!isTokenCount(reasoning) || reasoning > output))) return null;
    if (cached === undefined && input > 0) return null;
    if (cached !== undefined && (!isTokenCount(cached) || cached > input)) return null;
    return { cost: usdForTokens(price, input, output, cached ?? 0), price };
  }
  if (price.provider_id === 'xai') return null; // The ticks include independently billed reasoning and cache usage.
  if (usage?.cache_written_input_tokens !== undefined && usage.cache_written_input_tokens !== 0) return null;
  if (price.provider_id === 'anthropic' && price.model === 'claude-sonnet-5-5') {
    if (usage?.inference_geo !== 'global' && usage?.inference_geo !== 'us' && (input > 0 || output > 0)) return null;
    if (usage?.inference_geo === 'us') price = maximumWorkspaceRate(price);
    if (cached !== undefined && (!isTokenCount(cached) || cached > input)) return null;
    return { cost: usdForTokens(price, input, output, cached ?? 0), price };
  }
  if (cached !== undefined && cached !== 0) return null;
  return { cost: usdForTokens(price, input, output), price };
}

/** Explicit free routes cost zero even without provider usage evidence. */
export function estimateCallCost(args: PriceRequest & { usage: BillingUsage | null }): {
  cost_usd: number | null; price_source: string | null;
} {
  const actual = reportedXaiCost(args.provider_id, args.usage);
  if (actual !== null) return { cost_usd: actual, price_source: XAI_COST_EVIDENCE };
  const price = priceForModel(args.provider_id, args.model, { input_tokens: args.usage?.input_tokens ?? undefined, at: args.at, through: args.through });
  if (price && isOpenRouterFree(args.provider_id, args.model)) return { cost_usd: 0, price_source: price.source_url };
  const billed = price && billedTokenCost(price, args.usage);
  return billed ? { cost_usd: billed.cost, price_source: billed.price.rate_adjustment_url ?? billed.price.source_url } : { cost_usd: null, price_source: null };
}
