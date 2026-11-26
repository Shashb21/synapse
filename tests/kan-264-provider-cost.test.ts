import { afterEach, expect, it, vi } from 'vitest';
import { estimateCallCost, estimateCostUsd, priceForModel } from '@/modules/llm/cost';
import { developmentReceiptBilling, developmentUsageCost, rawCallBound } from '@/modules/development/cost';
import { googleGemini, usageFromPayload, type LlmUsage } from '@/modules/llm/provider';

const now = new Date('2026-11-25T12:00:00Z');
const request = (model: string, max_tokens = 100) => ({ model, max_tokens, system: '你好', user: '😀', temperature: 0 });
const usage = (input_tokens: number, output_tokens: number) => ({
  source: 'provider' as const, cached_input_tokens: 0, input_tokens, output_tokens, total_tokens: input_tokens + output_tokens, reasoning_tokens: null,
});

afterEach(() => vi.unstubAllEnvs());

it.each([
  ['openai', 'gpt-4.1-2025-04-14', 'gpt-4.1', 2, 8],
  ['openai', 'gpt-5.1-2025-11-13', 'gpt-5.1', 1.25, 10],
  ['anthropic-claude', 'claude-sonnet-5-5', 'claude-sonnet-5-5', 2, 10],
  ['xai-grok', 'grok-4-0709', 'grok-4.3', 1.25, 2.50],
])('prices exact documented routes %s/%s', (provider, served, model, input, output) => {
  expect(priceForModel(provider, served, { at: now })).toMatchObject({ model, input_per_million: input, output_per_million: output });
});

it.each([
  ['openai', 'gpt-4.1-custom'], ['openai', 'gpt-5.1-mini'], ['google-gemini', 'gemini-2.5-pro-preview'],
  ['xai-grok', 'grok-4'], ['anthropic-claude', 'claude-sonnet-4.5'], ['openrouter', 'openai/gpt-4.1'],
  ['openrouter', 'bad:free'], ['openai', 'vendor/mock:free'],
])('does not borrow a price for %s/%s', (provider, model) => {
  expect(estimateCallCost({ provider_id: provider, model, usage: usage(0, 0), at: now }).cost_usd).toBeNull();
  expect(rawCallBound(provider, request(model), now).cost_usd).toBeNull();
});

it('distinguishes incomplete billing evidence, zero-token paid usage and explicit free routes', () => {
  const paid = { provider_id: 'openai', model: 'gpt-4.1', at: now };
  expect(estimateCallCost({ ...paid, usage: { input_tokens: 2, output_tokens: null } }).cost_usd).toBeNull();
  expect(estimateCallCost({ ...paid, usage: usage(0, 0) }).cost_usd).toBe(0);
  expect(estimateCallCost({ ...paid, usage: usage(1, 0) }).cost_usd).toBe(0.000002);
  expect(developmentUsageCost(paid.provider_id, paid.model, { ...usage(0, 0), source: 'estimated' }, now).cost_usd).toBeNull();
  for (const model of ['vendor/mock:free', 'openrouter/free']) {
    expect(estimateCallCost({ provider_id: 'openrouter', model, usage: null }).cost_usd).toBe(0);
    expect(developmentUsageCost('openrouter', model, null, now).cost_usd).toBe(0);
    expect(rawCallBound('openrouter', request(model), now).cost_usd).toBe(0);
  }
});

it('keeps provider ceilings distinct from byte estimates and uses the highest applicable tier', () => {
  const bound = rawCallBound('openai', request('gpt-4.1'), now);
  expect(bound).toMatchObject({ input_utf8_bytes: 10, input_tokens_upper: 1_047_576, output_tokens_upper: 32_768, cost_usd: 2.357296 });
  expect(priceForModel('google', 'gemini-2.5-pro', { at: now, input_tokens: 200_000 })).toMatchObject({ input_per_million: 1.25, output_per_million: 10 });
  expect(priceForModel('google', 'gemini-2.5-pro', { at: now, input_tokens: 200_001 })).toMatchObject({ input_per_million: 2.5, output_per_million: 15 });
  expect(priceForModel('xai', 'grok-4.3', { at: now, input_tokens: 200_000 })).toMatchObject({ input_per_million: 2.5, output_per_million: 5 });
  expect(rawCallBound('google-gemini', request('gemini-2.5-pro'), now).price).toMatchObject({ input_per_million: 2.5, output_per_million: 15 });
});

it('estimates dated standard paid Gemini rates and reserves a safe bound across the cutovers', () => {
  const model = 'gemini-2.5-pro', provider = 'google-gemini';
  const dates = ['2026-11-30T23:59:59Z', '2026-12-01T00:00:00Z', '2027-01-01T00:00:00Z'].map(date => new Date(date));
  const estimate = { provider_id: provider, model, usage: { prompt_tokens: 100_000, completion_tokens: 1000 } };
  expect(dates.map(at => estimateCostUsd({ ...estimate, at }).cost_usd)).toEqual([0.135, 0.07875, 0.1575]);
  expect(estimateCostUsd({ ...estimate, at: dates[0], through: dates[1] }).cost_usd).toBeNull();
  expect(rawCallBound(provider, request(model), dates[0]).price).toMatchObject({ input_per_million: 2.5, output_per_million: 15 });
  for (const cutover of ['2026-11-30T10:00:00Z', '2026-12-01T14:00:00Z']) {
    expect(rawCallBound(provider, request(model), new Date(cutover)).price).toMatchObject({ input_per_million: 2.5, output_per_million: 15 });
  }
  expect(rawCallBound(provider, request(model), new Date('2026-12-01T14:00:00.001Z')).price).toMatchObject({ input_per_million: 1.5, output_per_million: 7.5 });
  expect(rawCallBound(provider, request('gemini-3.8-flash'), dates[0]).price).toMatchObject({ input_per_million: 1.5, output_per_million: 7.5 });
});

it('reconciles Gemini prompt, tool-use prompt, candidates and thoughts with the reported total', () => {
  const parsed = usageFromPayload({ usageMetadata: {
    promptTokenCount: 100, toolUsePromptTokenCount: 4, candidatesTokenCount: 10,
    thoughtsTokenCount: 8, cachedContentTokenCount: 9, totalTokenCount: 122, serviceTier: 'priority',
  } });
  expect(parsed).toMatchObject({
    input_tokens: 104, output_tokens: 18, total_tokens: 122, reasoning_tokens: 8, cached_input_tokens: 9, service_tier: 'priority',
  });
  expect(developmentReceiptBilling('google-gemini', 'gemini-3.8-flash', parsed && { ...parsed, source: 'provider' }, now, now))
    .toMatchObject({ cost_usd: null, price_source: null, billing: { cost_usd: null, price: null } });
});

it.each([
  { totalTokenCount: 10_110 }, { totalTokenCount: 109 }, { totalTokenCount: undefined }, { totalTokenCount: '110' },
  { candidatesTokenCount: undefined }, { toolUsePromptTokenCount: -1 }, { thoughtsTokenCount: 0.5 },
  { toolUsePromptTokenCount: 7 }, { cachedContentTokenCount: 101 }, { cachedContentTokenCount: null },
  { promptTokenCount: Number.MAX_SAFE_INTEGER, totalTokenCount: Number.MAX_SAFE_INTEGER },
])('rejects unreconciled Gemini token evidence %j', override => {
  const parsed = usageFromPayload({ usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10, totalTokenCount: 110, ...override } });
  expect(parsed).toMatchObject({ input_tokens: null, output_tokens: null });
  expect(estimateCallCost({ provider_id: 'google-gemini', model: 'gemini-3.8-flash', usage: parsed, at: now }).cost_usd).toBeNull();
  expect(developmentReceiptBilling('google-gemini', 'gemini-3.8-flash', parsed && { ...parsed, source: 'provider' }, now, now))
    .toMatchObject({ cost_usd: null, billing: { cost_usd: null, price: null } });
});

it.each(['free-project-key', 'paid-project-key'])('funds the paid maximum and records unknown actual for Gemini credential %s', async api_key => {
  vi.stubEnv('GEMINI_BASE_URL', 'https://generativelanguage.googleapis.com/v1beta');
  const fetchMock = vi.fn<typeof fetch>(async () => Response.json({
    candidates: [{ content: { parts: [{ text: '{}' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10, totalTokenCount: 110, serviceTier: 'standard' },
  }));
  vi.stubGlobal('fetch', fetchMock);
  const provider = googleGemini.id, model = 'gemini-3.8-flash';
  try {
    const onUsage = vi.fn<(usage: LlmUsage) => void>();
    await expect(googleGemini.complete(request(model), { api_key }, { onUsage, maxAttempts: 1, standardBilling: true })).resolves.toBe('{}');
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
    expect(new Headers(init?.headers).get('x-goog-api-key')).toBe(api_key);
    expect(JSON.parse(String(init?.body))).toMatchObject({ serviceTier: 'standard' });
    expect(init?.redirect).toBe('manual');
    const parsed = onUsage.mock.calls[0][0];
    expect(parsed).toMatchObject({ input_tokens: 100, output_tokens: 10, total_tokens: 110, service_tier: 'standard' });
    expect(estimateCallCost({ provider_id: provider, model, usage: parsed, at: now })).toEqual({ cost_usd: null, price_source: null });
    const receipt = developmentReceiptBilling(provider, model, { ...parsed, source: 'provider' }, now, now);
    expect(receipt).toMatchObject({ cost_usd: null, price_source: null, billing: { cost_usd: null, price: null, reason: expect.stringMatching(/project billing tier/i) } });
    expect(rawCallBound(provider, request(model), now).cost_usd).toBe(2.064384);
    expect(rawCallBound('openrouter', request('openrouter/free'), now).cost_usd).toBe(0);
  } finally { vi.unstubAllGlobals(); }
});

it('fails closed for custom endpoint pricing even when the model ID is documented', () => {
  vi.stubEnv('OPENAI_BASE_URL', 'https://reseller.example/v1');
  vi.stubEnv('OPENROUTER_BASE_URL', 'https://reseller.example/api/v1');
  expect(rawCallBound('openai', request('gpt-4.1'), now).cost_usd).toBeNull();
  expect(rawCallBound('openrouter', request('openrouter/free'), now).cost_usd).toBeNull();
});

it('uses the documented Claude residency premium for a conservative reservation', () => {
  const bound = rawCallBound('anthropic-claude', request('claude-sonnet-5-5'), now);
  expect(bound.cost_usd).toBe(3.608);
  expect(bound.price).toMatchObject({ input_per_million: 2.2, output_per_million: 11 });
  const actual = (inference_geo?: string) => developmentUsageCost('anthropic-claude', 'claude-sonnet-5-5', { ...usage(1000, 1000), inference_geo }, now).cost_usd;
  expect(actual()).toBeNull();
  expect(actual('global')).toBe(0.012);
  expect(actual('us')).toBe(0.0132);
});

it('keeps missing provider components and unpriced service tiers unknown', async () => {
  const { usageFromPayload } = await import('@/modules/llm/provider');
  expect(usageFromPayload({ usageMetadata: { thoughtsTokenCount: 10, promptTokenCount: 1000 } })?.output_tokens).toBeNull();
  expect(usageFromPayload({ usage: { cache_read_input_tokens: 10, output_tokens: 100 } })?.input_tokens).toBeNull();
  const observed = usageFromPayload({ service_tier: 'priority', usage: { prompt_tokens: 100, completion_tokens: 100 } });
  expect(observed?.service_tier).toBe('priority');
  expect(estimateCallCost({ provider_id: 'openai', model: 'gpt-4.1', usage: observed }).cost_usd).toBeNull();
  expect(developmentUsageCost('openai', 'gpt-4.1', { ...usage(100, 100), prior_charge_unknown: true }, now).cost_usd).toBeNull();
});

it('uses one HTTP attempt and pins standard billing for a reserved provider request', async () => {
  const { openAi } = await import('@/modules/llm/provider');
  const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 307 }));
  vi.stubGlobal('fetch', fetchMock);
  try {
    await expect(openAi.complete(request('gpt-4.1'), { api_key: 'test-key' }, { maxAttempts: 1, standardBilling: true })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0];
    expect(init?.redirect).toBe('manual');
    expect(JSON.parse(String(init?.body))).toMatchObject({ service_tier: 'default' });
  } finally { vi.unstubAllGlobals(); }
});

it('uses validated xAI per-request charge evidence and the documented OpenAI cache price', async () => {
  const { usageFromPayload } = await import('@/modules/llm/provider');
  const xai = { provider_id: 'xai-grok', model: 'grok-4.3', at: now };
  const report = usageFromPayload({ usage: { prompt_tokens: 100, completion_tokens: 100, cost_in_usd_ticks: 37_756_000 } });
  expect(estimateCallCost({ ...xai, usage: report })).toMatchObject({ cost_usd: 0.0037756 });
  for (const cost_in_usd_ticks of [undefined, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    expect(estimateCallCost({ ...xai, usage: { ...usage(100, 100), cost_in_usd_ticks } }).cost_usd).toBeNull();
  }
  expect(estimateCallCost({ ...xai, usage: { ...usage(100, 100), cost_in_usd_ticks: 0, prior_charge_unknown: true } }).cost_usd).toBeNull();
  const openai = { provider_id: 'openai', model: 'gpt-5.1', at: now };
  expect(estimateCallCost({ ...openai, usage: { ...usage(1000, 1000), cached_input_tokens: 800 } }).cost_usd).toBe(0.01035);
  expect(estimateCallCost({ ...openai, usage: { input_tokens: 1000, output_tokens: 1000 } }).cost_usd).toBeNull();
  expect(estimateCallCost({ ...openai, usage: { ...usage(0, 0), cached_input_tokens: 1 } }).cost_usd).toBeNull();
});

it.each([
  { total_tokens: 10_010, completion_tokens_details: { reasoning_tokens: 10_000 } },
  { total_tokens: 1 }, { total_tokens: -1 }, { total_tokens: '0' }, { total_tokens: null },
  { completion_tokens_details: { reasoning_tokens: 1 } },
  { completion_tokens_details: { reasoning_tokens: 0.5 } },
  { completion_tokens_details: { reasoning_tokens: null } },
  { completion_tokens_details: [] },
])('does not settle OpenAI charges with contradictory or malformed usage %j', override => {
  const parsed = usageFromPayload({ usage: { prompt_tokens: 0, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 0 }, ...override } });
  expect(estimateCallCost({ provider_id: 'openai', model: 'gpt-4.1', usage: parsed, at: now })).toEqual({ cost_usd: null, price_source: null });
  expect(developmentReceiptBilling('openai', 'gpt-4.1', parsed && { ...parsed, source: 'provider' }, now, now))
    .toMatchObject({ cost_usd: null, price_source: null, billing: { cost_usd: null } });
});

it('prices consistent OpenAI usage and preserves independent xAI charges and explicit free quotes', () => {
  const range = { prompt_tokens: 1_000, completion_tokens: 1_000, prompt_tokens_details: { cached_tokens: 200 } };
  const receiptAmount = (payload: Record<string, unknown>) => {
    const parsed = usageFromPayload({ usage: payload });
    return developmentReceiptBilling('openai', 'gpt-4.1', parsed && { ...parsed, source: 'provider' }, now, now).cost_usd;
  };
  expect(receiptAmount({ ...range, total_tokens: 2_000, completion_tokens_details: { reasoning_tokens: 400 } })).toBe(0.0097);
  expect(receiptAmount(range)).toBe(0.0097);
  expect(receiptAmount({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 })).toBe(0);
  const contradictory = usageFromPayload({ usage: { ...range, total_tokens: 900_000, cost_in_usd_ticks: 37_756_000 } });
  expect(estimateCallCost({ provider_id: 'xai-grok', model: 'grok-4.3', usage: contradictory, at: now }).cost_usd).toBe(0.0037756);
  expect(developmentReceiptBilling('openrouter', 'openrouter/free', contradictory, now, now).cost_usd).toBe(0);
});

it('rejects contradictory OpenAI billing counts from normalized usage', () => {
  for (const contradiction of [{ total_tokens: 10_010 }, { reasoning_tokens: 10_000 }]) {
    const report = { ...usage(0, 0), ...contradiction };
    expect(developmentReceiptBilling('openai', 'gpt-4.1', report, now, now).cost_usd).toBeNull();
  }
});
