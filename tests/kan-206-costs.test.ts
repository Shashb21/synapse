/** Arrange cost evidence, act through pure controls, assert unknowns cannot become zero. */
import { expect, it } from 'vitest';
import { exactDevelopmentPrice, developmentUsageCost, rawCallBound, estimateDevelopmentCost, COST_CATEGORIES } from '@/modules/development/cost';
import { costControlsSchema, costActionSchema } from '@/modules/development/cost-schema';
it('matches complete provider/model identities without prefix or reseller guesses', () => {
  expect(exactDevelopmentPrice('openai', 'gpt-4.1')?.model).toBe('gpt-4.1');
  expect(exactDevelopmentPrice('openai', 'gpt-unknown')).toBeNull();
  expect(exactDevelopmentPrice('openrouter', 'openai/gpt-4.1')).toBeNull();
});
it('prices complete provider evidence and preserves absent, mixed and partial usage', () => {
  const usage = { source: 'provider' as const, input_tokens: 1000, output_tokens: 1000, total_tokens: 2000, reasoning_tokens: null };
  expect(developmentUsageCost('openai', 'gpt-4.1', usage).cost_usd).toBe(0.01);
  for (const value of [null, { ...usage, input_tokens: null }, { ...usage, source: 'mixed' as const }, { ...usage, input_tokens: NaN }]) expect(developmentUsageCost('openai', 'gpt-4.1', value).cost_usd).toBeNull();
});
it('does not represent UTF-8 heuristics or undocumented overhead as billing ceilings', () => {
  const bound = rawCallBound('openai', { model: 'gpt-4.1', system: '你好', user: '😀', temperature: 0, max_tokens: 100 });
  expect(bound.cost_usd).toBeNull(); expect(bound.input_utf8_bytes).toBe(10); expect(bound.reason).toMatch(/overhead|bound/);
});
it('covers preparation, every generation role, retries, pairs and evaluation with dynamic uncertainty', () => {
  const estimate = estimateDevelopmentCost({ target: 'all', mode: 'agentic' });
  expect(estimate.categories.map(c => c.category)).toEqual([...COST_CATEGORIES]);
  expect(estimate.categories[0].cost_usd).toBe(0); expect(estimate.categories[1].cost_usd).toBe(0);
  expect(estimate.total_usd).toBeNull(); expect(estimate.http_max_attempts).toBe(1);
});
it('validates finite nonnegative amounts, ISO currencies and rejects client actor fields', () => {
  expect(costControlsSchema.parse({ allowance_usd: 1 }).unknown_acknowledged).toBe(false);
  for (const amount of [-1, Infinity, NaN]) expect(costControlsSchema.safeParse({ allowance_usd: amount }).success).toBe(false);
  expect(costActionSchema.safeParse({ action: 'report', amount: 0, currency: 'USD', note: '' }).success).toBe(true);
  for (const currency of ['XXX', 'BAD', 'usd', 'US']) expect(costActionSchema.safeParse({ action: 'report', amount: 1, currency }).success).toBe(false);
  expect(costActionSchema.safeParse({ action: 'resume', actor: 'client' }).success).toBe(false);
});
