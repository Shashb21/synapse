import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { sharedDb } from '@/lib/iegp/db';
import { createExperiment, getExperiment, updateExperiment } from '@/modules/development/store';
import { canonicalParsedJson, sha256 } from '@/modules/development/documents';
import { startExecution } from '@/modules/development/execution';
import { executionConfigSchema } from '@/modules/development/execution-schema';
import { getExecution } from '@/modules/development/execution-store';
import { applyCostAction, getCostAccount, reserveCost, settleCost } from '@/modules/development/cost-store';
import * as costStore from '@/modules/development/cost-store';
import { beginPreparationCall, openPreparationAllowance, settlePreparationCall } from '@/modules/development/preparation-cost-store';
import { developmentUsageCost, rawCallBound } from '@/modules/development/cost';
import { progressExecution } from '@/modules/development/worker';
import { getEvaluation } from '@/modules/development/evaluation-store';
import { startEvaluation } from '@/modules/development/evaluation';
import { startEvaluationSchema } from '@/modules/development/evaluation-schema';
import { progressEvaluation } from '@/modules/development/evaluation-worker';
import { googleGemini, openAi, openRouter } from '@/modules/llm/provider';
import * as llm from '@/modules/kernel/llm';
import type { DevelopmentDocument } from '@/modules/development/schema';

const originalOpenRouterModels = [...openRouter.models];
const originalOpenAiModels = [...openAi.models];
const originalGeminiModels = [...googleGemini.models];
const quote = 'Comparative effectiveness remains unknown.';
const gapReply = JSON.stringify({ gaps: [{ name: 'Comparative evidence', statement: quote, domain: 'comparative_effectiveness', source_quote: quote }] });
const plainRequest = { model: 'gpt-4.1', system: '', user: '', temperature: 0, max_tokens: 1000 };
const route = { provider_id: 'openai', model: plainRequest.model, fallbacks: [] };
const free = { provider_id: 'openrouter', model: 'openrouter/free', fallbacks: [] };
const reported = { source: 'provider' as const, cached_input_tokens: 0, input_tokens: 1000, output_tokens: 1000, total_tokens: 2000, reasoning_tokens: null };
const pricedOutcome = () => developmentUsageCost(route.provider_id, route.model, reported);
const unknownOutcome = { cost_usd: null, price: null, reason: 'The provider did not report both token counts.' };

// Create the platform pool with several connections before the test DB bootstrap.
vi.hoisted(() => { process.env.DATABASE_PLATFORM_POOL_MAX = '4'; });

beforeEach(() => {
  vi.stubEnv('SYNAPSE_DEVELOPMENT_DELIVERY', 'github_actions');
  vi.stubEnv('CRON_SECRET', 'isolated-test-worker-secret-long-enough');
  vi.stubEnv('OPENAI_API_KEY', 'fake-openai-key');
  vi.stubEnv('OPENROUTER_API_KEY', 'fake-openrouter-key');
  vi.spyOn(llm, 'isTestStub').mockReturnValue(false);
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network forbidden in this test.'));
  openRouter.models.push(free.model);
  openAi.models.push(route.model);
});
afterEach(() => {
  openRouter.models.splice(0, openRouter.models.length, ...originalOpenRouterModels);
  openAi.models.splice(0, openAi.models.length, ...originalOpenAiModels);
  googleGemini.models.splice(0, googleGemini.models.length, ...originalGeminiModels);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function fixture(allowance_usd: number, selected = route, target: 'all' | 'gap_extraction' = 'gap_extraction', gapRoute = selected) {
  const e = await createExperiment('Finite cost safety', null, 'owner');
  const parsed = { blocks: [{ id: 'b1', text: quote, heading: 'Evidence', location: '1' }] };
  const document = {
    id: `${e.id}-source`, experiment_id: e.id, role: 'source', compatibility: 'compatible', filename: 'source.txt',
    sha256: sha256(quote), parsed_sha256: sha256(canonicalParsedJson(parsed)), parsed_at: '2026-11-25T00:00:00Z',
    parser: { name: 'test', version: '1', model: null, prompt: null }, parsed,
  } as DevelopmentDocument;
  await updateExperiment(e.id, 1, { document, content_base64: Buffer.from(quote).toString('base64') });
  const stages = Object.fromEntries(['gap_extraction', 'tactic_extraction', 'matching_coverage', 'partial_splitting'].map(section => [section, { route: section === 'gap_extraction' ? gapRoute : selected }]));
  const config = executionConfigSchema.parse({ mode: 'single_pass', stages, evaluator: selected });
  const execution = await startExecution(e.id, { revision: 2, target, config, prerequisites: {}, cost_controls: { allowance_usd, unknown_acknowledged: false } });
  return { e, execution };
}

it.each([[0.3, 2], [0.29, 1]])('compares both concurrent reservations in PostgreSQL with USD %s available', async (amount, accepted) => {
  const { e, execution } = await fixture(amount);
  const db = sharedDb();
  expect(db.$client.options.max).toBeGreaterThanOrEqual(2);
  const transaction = db.transaction.bind(db);
  const ready = Promise.withResolvers<void>();
  const backends = new Set<number>();
  const spy = vi.spyOn(db, 'transaction').mockImplementation((work, config) =>
    transaction(async tx => {
      const [session] = await tx.execute(sql`select pg_backend_pid() as pid`);
      backends.add(Number(session.pid));
      if (backends.size === 2) ready.resolve();
      await ready.promise;
      return work(tx);
    }, config));
  const base = rawCallBound(route.provider_id, plainRequest);
  const results = await Promise.allSettled([
    reserveCost(execution.id, `${execution.id}-gen`, 'generation', { ...base, cost_usd: 0.1 }),
    reserveCost(execution.id, `${execution.id}-eval`, 'evaluation', { ...base, cost_usd: 0.2 }),
  ]);
  spy.mockRestore();
  expect(backends.size).toBe(2);
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(accepted);
  expect((await getCostAccount(e.id, execution.id))?.reservations).toHaveLength(accepted);
});

it('keeps the bound after an incomplete outcome until verified reconciliation', async () => {
  const bound = rawCallBound(route.provider_id, plainRequest);
  const { e, execution } = await fixture(bound.cost_usd! + 1);
  const id = `${execution.id}-first`;
  await reserveCost(execution.id, id, 'generation', bound);
  await settleCost(execution.id, id, unknownOutcome);
  expect(await getCostAccount(e.id, execution.id)).toMatchObject({
    reserved_usd: bound.cost_usd, unknown_usage_calls: 1, generation_usage_usd: null,
  });
  await applyCostAction(e.id, execution.id, { action: 'override', enabled: true }, 'owner');
  await applyCostAction(e.id, execution.id, { action: 'acknowledge_unknown' }, 'owner');
  await expect(reserveCost(execution.id, `${execution.id}-second`, 'evaluation', bound)).rejects.toMatchObject({ code: 'cost_paused' });
  await settleCost(execution.id, id, pricedOutcome());
  await settleCost(execution.id, id, unknownOutcome);
  expect(await getCostAccount(e.id, execution.id)).toMatchObject({ reserved_usd: 0, unknown_usage_calls: 0, generation_usage_usd: 0.01 });
  await applyCostAction(e.id, execution.id, { action: 'resume' }, 'owner');
  await reserveCost(execution.id, `${execution.id}-second`, 'evaluation', bound);
});

it.each([
  { key: 'free-project-key', total: 110, tier: 'standard', source: 'provider' },
  { key: 'paid-project-key', total: 110, tier: 'standard', source: 'provider' },
  { key: 'paid-project-key', total: 10_110, tier: 'standard', source: 'estimated' },
  { key: 'paid-project-key', total: 110, tier: 'priority', source: 'provider' },
])('keeps the Gemini allowance hold through receipt replay for $key with $total tokens at $tier service', async ({ key, total, tier, source }) => {
  vi.stubEnv('GEMINI_API_KEY', key);
  vi.stubEnv('GEMINI_BASE_URL', 'https://generativelanguage.googleapis.com/v1beta');
  const model = 'gemini-3.8-flash';
  googleGemini.models.push(model);
  const selected = { provider_id: googleGemini.id, model, fallbacks: [] };
  const bound = rawCallBound(selected.provider_id, { ...plainRequest, model });
  expect(bound.cost_usd).toBeGreaterThan(0);
  const { e, execution } = await fixture(bound.cost_usd!, selected);
  const transport = vi.mocked(fetch).mockResolvedValueOnce(Response.json({
    candidates: [{ content: { parts: [{ text: gapReply }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10, totalTokenCount: total, serviceTier: tier },
  }));

  await progressExecution(execution.id);
  await progressExecution(execution.id);
  await progressExecution(execution.id);
  expect(transport).toHaveBeenCalledOnce();
  expect(new Headers(transport.mock.calls[0][1]?.headers).get('x-goog-api-key')).toBe(key);
  const finished = await getExecution(e.id, execution.id);
  expect(finished).toMatchObject({
    generation_status: 'succeeded',
    calls: [{ receipt: { cost_usd: null, price_source: null, usage: { source, service_tier: tier }, billing: { cost_usd: null, price: null } } }],
    cost: {
      generation_usage_usd: null, reserved_usd: bound.cost_usd, unknown_usage_calls: 1,
      reservations: [{ status: 'settled', bound_usd: bound.cost_usd, usage_cost: { cost_usd: null } }],
    },
  });
  await expect(reserveCost(execution.id, `${execution.id}-next`, 'evaluation', bound)).rejects.toMatchObject({ code: 'cost_paused' });
});

it('keeps the OpenAI allowance hold through replay when reported zero usage contradicts the total and reasoning', async () => {
  vi.stubEnv('OPENAI_BASE_URL', 'https://api.openai.com/v1');
  const bound = rawCallBound(route.provider_id, plainRequest);
  const { e, execution } = await fixture(bound.cost_usd!);
  const transport = vi.mocked(fetch).mockResolvedValueOnce(Response.json({
    choices: [{ message: { content: gapReply }, finish_reason: 'stop' }],
    service_tier: 'default',
    usage: {
      prompt_tokens: 0, completion_tokens: 0, total_tokens: 10_010,
      prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 10_000 },
    },
  }));

  await progressExecution(execution.id);
  await progressExecution(execution.id);
  await progressExecution(execution.id);
  expect(transport).toHaveBeenCalledOnce();
  const finished = await getExecution(e.id, execution.id);
  expect(finished).toMatchObject({
    generation_status: 'succeeded',
    calls: [{ receipt: { cost_usd: null, price_source: null, billing: { cost_usd: null } } }],
    cost: {
      generation_usage_usd: null, reserved_usd: bound.cost_usd, unknown_usage_calls: 1,
      reservations: [{ status: 'settled', bound_usd: bound.cost_usd, usage_cost: { cost_usd: null } }],
    },
  });
  await expect(reserveCost(execution.id, `${execution.id}-next`, 'evaluation', bound)).rejects.toMatchObject({ code: 'cost_paused' });
});

it.each([
  ['active', null], ['settled', null], ['settled', { cost_usd: 0.1 }],
])('blocks new paid commitments while a legacy %s unverified charge is unresolved', async (status, usage) => {
  const { e, execution } = await fixture(100);
  const legacy = `${execution.id}-legacy`;
  await sharedDb().execute(sql`insert into development_cost_reservations(call_id,execution_id,kind,bound_evidence,status,usage_cost)
    values(${legacy},${execution.id},'evaluation','{"cost_usd":null}'::jsonb,${status},${usage ? JSON.stringify(usage) : null}::jsonb)`);
  const bound = rawCallBound(route.provider_id, plainRequest);
  await expect(reserveCost(execution.id, `${execution.id}-new`, 'generation', bound)).rejects.toThrow(/earlier request.*unresolved charge/);
  await settleCost(execution.id, legacy, pricedOutcome());
  await applyCostAction(e.id, execution.id, { action: 'resume' }, 'owner');
  await reserveCost(execution.id, `${execution.id}-new`, 'generation', bound);
});

it.each([[null, 2.357296], [1, 2.357296], [3, 3]])('reprices or keeps a USD %s hold for the same proven-unsent checkpoint', async (previous, expected) => {
  const { e, execution } = await fixture(10);
  const reserve = costStore.reserveCost;
  vi.spyOn(costStore, 'reserveCost').mockImplementationOnce(async (executionId, callId, kind, bound) => {
    await sharedDb().execute(sql`insert into development_cost_reservations(call_id,execution_id,kind,bound_usd,bound_evidence,status)
      values(${callId},${executionId},${kind},${previous},${JSON.stringify({ cost_usd: previous })}::jsonb,'active')`);
    await reserve(executionId, callId, kind, bound);
  });
  const transport = vi.spyOn(openAi, 'complete').mockImplementation(async (_request, _auth, hooks) => {
    const saved = await getExecution(e.id, execution.id);
    expect(saved.calls[0].status).toBe('sending');
    expect(saved.cost?.reservations).toHaveLength(1);
    expect(saved.cost?.reservations[0].bound_usd).toBe(expected);
    hooks?.onUsage?.(reported);
    return gapReply;
  });
  await progressExecution(execution.id);
  await progressExecution(execution.id);
  await progressExecution(execution.id);
  expect(transport).toHaveBeenCalledOnce();
  expect(await getExecution(e.id, execution.id)).toMatchObject({
    generation_status: 'succeeded',
    cost: { generation_usage_usd: 0.01, reservations: [{ status: 'settled', bound_usd: expected }] },
  });
});

it('reserves free generation and evaluation at zero allowance and honors an owner pause before dispatch', async () => {
  const { e, execution } = await fixture(0, free);
  const transport = vi.spyOn(openRouter, 'complete').mockResolvedValue(gapReply);
  const reserve = costStore.reserveCost;
  vi.spyOn(costStore, 'reserveCost').mockImplementationOnce(async (...args) => {
    await reserve(...args);
    await applyCostAction(e.id, execution.id, { action: 'pause' }, 'owner');
  });
  await progressExecution(execution.id);
  expect(transport).not.toHaveBeenCalled();
  expect((await getExecution(e.id, execution.id)).calls[0]).toMatchObject({ status: 'queued', sending_at: null });
  await applyCostAction(e.id, execution.id, { action: 'resume' }, 'owner');
  await progressExecution(execution.id);
  await progressExecution(execution.id);
  const finished = await getExecution(e.id, execution.id);
  expect(transport).toHaveBeenCalledOnce();
  expect(finished.calls[0].receipt).toMatchObject({ cost_usd: 0, billing: { cost_usd: 0 } });
  expect(finished.cost?.reservations).toHaveLength(1);
  const evaluation = await startEvaluation(e.id, startEvaluationSchema.parse({
    execution_id: execution.id, attempt_id: finished.sections[0].id, output_id: finished.sections[0].result!.output_id,
    section: 'gap_extraction', cost_controls: { allowance_usd: 0 }, config: { sections: { gap_extraction: { route: free } } },
  }));
  transport.mockResolvedValue(JSON.stringify({ criteria: evaluation.manifest.criteria.map(c => ({ criterion_id: c.id, score: 3, reason: 'Supported.' })), matches: [], unmatched_output_ids: [], unmatched_reference_ids: [] }));
  await progressEvaluation(evaluation.id);
  await progressEvaluation(evaluation.id);
  expect(transport).toHaveBeenCalledTimes(2);
  expect(await getEvaluation(e.id, evaluation.id)).toMatchObject({ status: 'succeeded', receipt: { cost_usd: 0 } });
  expect(await getCostAccount(e.id, execution.id)).toMatchObject({ allowance_usd: 0, generation_usage_usd: 0, evaluation_usage_usd: 0 });
});

it('funds only one overlapping real paid worker when the combined bounds exceed the allowance', async () => {
  const bound = rawCallBound(route.provider_id, plainRequest).cost_usd!;
  const { e, execution } = await fixture(bound, route, 'all');
  const sent = vi.spyOn(openAi, 'complete').mockImplementationOnce(async (_request, _auth, hooks) => {
    hooks?.onUsage?.({ cached_input_tokens: 0, input_tokens: 1000, output_tokens: 1000, total_tokens: 2000, reasoning_tokens: null });
    return gapReply;
  });
  await progressExecution(execution.id);
  await progressExecution(execution.id);
  const soFar = await getExecution(e.id, execution.id);
  const pending = soFar.calls.find(call => call.status === 'queued');
  expect(pending).toMatchObject({ status: 'queued', sending_at: null });
  expect(soFar.cost).toMatchObject({ paused: true, generation_usage_usd: 0.01 });
  const evaluation = await startEvaluation(e.id, startEvaluationSchema.parse({
    execution_id: execution.id, attempt_id: soFar.sections[0].id, output_id: soFar.sections[0].result!.output_id,
    section: 'gap_extraction', cost_controls: { allowance_usd: 0 }, config: { sections: { gap_extraction: { route } } },
  }));
  await applyCostAction(e.id, execution.id, { action: 'increase', amount_usd: 0.01 }, 'owner');
  await applyCostAction(e.id, execution.id, { action: 'resume' }, 'owner');

  const release = Promise.withResolvers<void>();
  sent.mockImplementation(async raw => {
    // The other worker must try while this request still holds the entire remaining allowance.
    await release.promise;
    return raw.system.includes('independent provisional evaluator')
      ? JSON.stringify({ criteria: [], matches: [], unmatched_output_ids: [], unmatched_reference_ids: [] })
      : JSON.stringify({ tactics: [] });
  });
  const jobs = [progressExecution(execution.id), progressEvaluation(evaluation.id)];
  try { await Promise.race(jobs); }
  finally { release.resolve(); }
  await Promise.all(jobs);
  expect(sent).toHaveBeenCalledTimes(2);
  const outcome = await getExecution(e.id, execution.id);
  const evaluator = await getEvaluation(e.id, evaluation.id);
  expect([outcome.calls.find(call => call.id === pending!.id)?.status, evaluator.status].filter(status => status === 'queued')).toHaveLength(1);
  expect(outcome.cost?.reserved_usd).toBe(bound);
  expect(outcome.cost?.reservations).toHaveLength(2);
});

it('uses one durable upload authorization and atomically refuses a second unaffordable preparation send', async () => {
  const { e } = await fixture(10);
  const draft = await getExperiment(e.id);
  const controls = { id: randomUUID(), allowance_usd: 0.3 };
  const opened = await Promise.allSettled([
    openPreparationAllowance(draft, 'tester', 'source', controls),
    openPreparationAllowance(draft, 'tester', 'source', controls),
  ]);
  expect(opened.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(opened.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'preparation_already_started' } });
  const cap = { ...rawCallBound(route.provider_id, plainRequest), cost_usd: 0.2 };
  const sends = await Promise.allSettled([beginPreparationCall(controls.id, cap), beginPreparationCall(controls.id, cap)]);
  expect(sends.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(sends.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'preparation_allowance_exceeded' } });
  const send = sends.find(result => result.status === 'fulfilled')!;
  await settlePreparationCall(controls.id, send.value, unknownOutcome);
  await expect(beginPreparationCall(controls.id, cap)).rejects.toMatchObject({ code: 'preparation_allowance_exceeded' });
  await expect(beginPreparationCall(controls.id, { ...cap, cost_usd: 0 })).resolves.toBeTruthy();
});

it('continues independent Run All sections after an unpriced section is refused', async () => {
  const { e, execution } = await fixture(100, route, 'all', { ...route, model: 'gpt-5.1-mini' });
  const transport = vi.spyOn(openAi, 'complete').mockResolvedValue(JSON.stringify({ tactics: [{
    name: 'Panel study', type: 'rwe_study', status: 'ongoing', evidence_question: 'What is the comparative effectiveness?', source_quote: quote,
  }] }));
  await progressExecution(execution.id);
  let saved = await getExecution(e.id, execution.id);
  expect(saved.sections.find(section => section.section === 'gap_extraction')).toMatchObject({ status: 'failed', error: expect.stringMatching(/verified spending limit/) });
  expect(saved.generation_status).toBe('queued');
  expect(transport).not.toHaveBeenCalled();
  await progressExecution(execution.id);
  await progressExecution(execution.id);
  saved = await getExecution(e.id, execution.id);
  expect(transport).toHaveBeenCalledOnce();
  expect(saved.sections.find(section => section.section === 'tactic_extraction')?.status).toBe('succeeded');
  expect(saved.sections.find(section => section.section === 'matching_coverage')?.status).toBe('blocked');
});
