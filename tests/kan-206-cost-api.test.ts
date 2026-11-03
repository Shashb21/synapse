/** Arrange isolated owner experiments, act through workers and API, assert durable spending safety. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { sharedDb } from '@/lib/iegp/db';
import { createExperiment, updateExperiment } from '@/modules/development/store';
import { canonicalParsedJson, sha256 } from '@/modules/development/documents';
import { startExecution } from '@/modules/development/execution';
import * as executionSafety from '@/modules/development/execution';
import { setAiSection } from '@/modules/kernel/ai-switch';
import { executionConfigSchema } from '@/modules/development/execution-schema';
import { getExecution } from '@/modules/development/execution-store';
import * as executionStore from '@/modules/development/execution-store';
import * as evaluationStore from '@/modules/development/evaluation-store';
import { progressExecution } from '@/modules/development/worker';
import { progressEvaluation } from '@/modules/development/evaluation-worker';
import { startEvaluation } from '@/modules/development/evaluation';
import { startEvaluationSchema } from '@/modules/development/evaluation-schema';
import { getEvaluation } from '@/modules/development/evaluation-store';
import { applyCostAction, getCostAccount, reserveCost, settleCost } from '@/modules/development/cost-store';
import * as costStore from '@/modules/development/cost-store';
import { rawCallBound } from '@/modules/development/cost';
import * as costEvidence from '@/modules/development/cost';
import { GET, POST } from '@/app/api/admin/development/[id]/executions/[executionId]/costs/route';
import { POST as estimate } from '@/app/api/admin/development/[id]/cost-estimate/route';
import * as owner from '@/modules/auth/owner';
import * as llm from '@/modules/kernel/llm';
import { xaiGrok } from '@/modules/llm/provider';
import type { DevelopmentDocument } from '@/modules/development/schema';
const controls = { allowance_usd: 1, unknown_acknowledged: true };
const request = (value: unknown) => new Request('http://localhost', { method: 'POST', body: JSON.stringify(value) });
const context = (experimentId: string, executionId: string) => ({ params: Promise.resolve({ id: experimentId, executionId }) });
const quote = 'Comparative effectiveness remains unknown.';
async function fixture(cost_controls: typeof controls | null = controls, target: 'all' | 'gap_extraction' = 'gap_extraction') {
  const e = await createExperiment('Cost safety', null, 'owner');
  const parsed = { blocks: [{ id: 'b1', text: quote, heading: 'Evidence', location: '1' }] };
  const document = { id: `${e.id}-source`, experiment_id: e.id, role: 'source', compatibility: 'compatible', filename: 'source.txt', sha256: sha256(quote), parsed_sha256: sha256(canonicalParsedJson(parsed)), parsed_at: new Date().toISOString(), parser: { name: 'test', version: '1', model: null, prompt: null }, parsed } as DevelopmentDocument;
  await updateExperiment(e.id, 1, { document, content_base64: Buffer.from(quote).toString('base64') });
  const execution = await startExecution(e.id, { revision: 2, target, config: executionConfigSchema.parse({ mode: 'single_pass' }), prerequisites: {}, cost_controls: cost_controls ?? undefined });
  return { e, execution };
}
beforeEach(() => {
  vi.stubEnv('SYNAPSE_DEVELOPMENT_DELIVERY', 'github_actions'); vi.stubEnv('CRON_SECRET', 'isolated-test-worker-secret-long-enough'); vi.stubEnv('XAI_API_KEY', 'test-key-never-send');
  vi.spyOn(llm, 'isTestStub').mockReturnValue(false);
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Paid network forbidden.'));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
it('authorizes before decoding, rejects foreign execution IDs and client actors, previews every category', async () => {
  const { e, execution } = await fixture();
  expect((await GET(request({}), context('foreign', execution.id))).status).toBe(404);
  expect((await POST(request({ action: 'resume', actor: 'spoof' }), context(e.id, execution.id))).status).toBe(400);
  const preview = await estimate(request({ target: 'all', mode: 'standard' }), { params: Promise.resolve({ id: e.id }) });
  expect(preview.status).toBe(200); expect((await preview.json()).estimate.categories).toHaveLength(10);
  vi.spyOn(owner, 'ownerGate').mockResolvedValue(NextResponse.json({}, { status: 403 }));
  expect((await POST(new Request('http://localhost', { method: 'POST', body: 'invalid' }), context(e.id, execution.id))).status).toBe(403);
});
it('atomically shares one allowance across simultaneous generation/evaluation reservations and audits explicit resume', async () => {
  const { e, execution } = await fixture();
  const bound = { ...rawCallBound('openai', { model: 'gpt-4.1', system: '', user: '', temperature: 0, max_tokens: 1 }), cost_usd: 0.75 };
  const results = await Promise.allSettled([reserveCost(execution.id, `${execution.id}-g`, 'generation', bound), reserveCost(execution.id, `${execution.id}-e`, 'evaluation', bound)]);
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect((await getCostAccount(e.id, execution.id))?.reserved_usd).toBe(0.75);
  expect((await getCostAccount(e.id, execution.id))?.paused).toBe(true);
  await applyCostAction(e.id, execution.id, { action: 'increase', amount_usd: 1 }, 'authenticated-owner');
  expect((await getCostAccount(e.id, execution.id))?.paused).toBe(true);
  await applyCostAction(e.id, execution.id, { action: 'resume' }, 'authenticated-owner');
  await reserveCost(execution.id, `${execution.id}-next`, 'evaluation', bound);
  expect((await getCostAccount(e.id, execution.id))?.reserved_usd).toBe(1.5);
  const account = await applyCostAction(e.id, execution.id, { action: 'override', enabled: true }, 'authenticated-owner');
  expect(account.events.at(-1)?.actor).toBe('authenticated-owner');
  await expect(reserveCost(execution.id, `${execution.id}-next`, 'evaluation', bound)).rejects.toMatchObject({ code: 'reservation_conflict' });
});
it('pauses at the real raw-call boundary and resumes the identical queued request without losing completed output', async () => {
  const { e, execution } = await fixture({ allowance_usd: 1, unknown_acknowledged: false });
  const send = vi.spyOn(xaiGrok, 'complete').mockImplementation(async (_request, _auth, hooks) => {
    expect(hooks?.maxAttempts).toBe(1);
    return JSON.stringify({ gaps: [{ name: 'Comparative evidence', statement: quote, domain: 'comparative_effectiveness', source_quote: quote }] });
  });
  await progressExecution(execution.id);
  const paused = await getExecution(e.id, execution.id);
  expect(send).not.toHaveBeenCalled(); expect(paused.cost?.paused).toBe(true); expect(paused.calls[0].status).toBe('queued');
  const savedRequest = paused.calls[0].request;
  expect(await progressExecution(execution.id)).toEqual({ processed: false });
  await applyCostAction(e.id, execution.id, { action: 'acknowledge_unknown' }, 'owner');
  expect((await getCostAccount(e.id, execution.id))?.paused).toBe(true);
  await applyCostAction(e.id, execution.id, { action: 'resume' }, 'owner');
  await progressExecution(execution.id); await progressExecution(execution.id);
  const finished = await getExecution(e.id, execution.id);
  expect(send).toHaveBeenCalledOnce(); expect(finished.calls[0].request).toEqual(savedRequest); expect(finished.sections[0].status).toBe('succeeded');
  const evaluation = await startEvaluation(e.id, startEvaluationSchema.parse({ execution_id: execution.id, attempt_id: finished.sections[0].id, output_id: finished.sections[0].result!.output_id, section: 'gap_extraction' }));
  await progressEvaluation(evaluation.id); expect(send).toHaveBeenCalledOnce(); expect((await getEvaluation(e.id, evaluation.id)).status).toBe('queued');
  await applyCostAction(e.id, execution.id, { action: 'resume' }, 'owner');
  await progressEvaluation(evaluation.id);
  expect(send).toHaveBeenCalledTimes(2);
  expect((await getEvaluation(e.id, evaluation.id)).cost?.execution_id).toBe(execution.id);
  expect((await getExecution(e.id, execution.id)).sections).toEqual(finished.sections);
});
it('preserves completed Run All sections while real generation and evaluation workers share the last allowance', async () => {
  // Synthetic verified bounds exercise the known-price branch; real adapters remain explicitly unknown.
  const originalBound = costEvidence.rawCallBound;
  vi.spyOn(costEvidence, 'rawCallBound').mockImplementation((provider, raw) => ({ ...originalBound(provider, raw), cost_usd: 0.75 }));
  vi.spyOn(costEvidence, 'developmentUsageCost').mockReturnValue({ cost_usd: 0.75, price: null, reason: null });
  const { e, execution } = await fixture(controls, 'all');
  const send = vi.spyOn(xaiGrok, 'complete').mockImplementation(async raw => {
    if (raw.system.includes('independent provisional evaluator')) return JSON.stringify({ criteria: [], matches: [], unmatched_output_ids: [], unmatched_reference_ids: [] });
    return JSON.stringify({ gaps: [{ name: 'Comparative evidence', statement: quote, domain: 'comparative_effectiveness', source_quote: quote }], tactics: [] });
  });
  await progressExecution(execution.id);
  await progressExecution(execution.id);
  const paused = await getExecution(e.id, execution.id);
  expect(send).toHaveBeenCalledOnce();
  expect(paused.cost?.paused).toBe(true);
  expect(paused.sections[0].status).toBe('succeeded');
  const queued = paused.calls.find(call => call.status === 'queued')!;
  expect(queued).toBeTruthy();
  const evaluation = await startEvaluation(e.id, startEvaluationSchema.parse({ execution_id: execution.id, attempt_id: paused.sections[0].id, output_id: paused.sections[0].result!.output_id, section: 'gap_extraction', cost_controls: { allowance_usd: 0, unknown_acknowledged: true } }));
  expect(await progressExecution(execution.id)).toEqual({ processed: false });
  expect(await progressEvaluation(evaluation.id)).toEqual({ processed: false });
  await applyCostAction(e.id, execution.id, { action: 'increase', amount_usd: 0.5 }, 'owner');
  await applyCostAction(e.id, execution.id, { action: 'resume' }, 'owner');
  await Promise.all([progressExecution(execution.id), progressEvaluation(evaluation.id)]);
  const competing = await getExecution(e.id, execution.id);
  const assessed = await getEvaluation(e.id, evaluation.id);
  expect(send).toHaveBeenCalledTimes(2);
  expect(competing.cost?.paused).toBe(true);
  expect(competing.cost!.reservations.filter(r => r.status === 'active').reduce((sum, r) => sum + (r.bound_usd ?? 0), 0) + (competing.cost?.generation_usage_usd ?? 0) + (competing.cost?.evaluation_usage_usd ?? 0)).toBe(1.5);
  expect(competing.sections[0]).toEqual(paused.sections[0]);
  expect(competing.calls.find(call => call.id === queued.id)?.request).toEqual(queued.request);
  expect([competing.calls.find(call => call.id === queued.id)?.status, assessed.status].filter(status => status === 'queued')).toHaveLength(1);
  // Funding does not resume implicitly; only the losing, saved call may dispatch after explicit resume.
  await applyCostAction(e.id, execution.id, { action: 'increase', amount_usd: 1 }, 'owner');
  expect((await getCostAccount(e.id, execution.id))?.paused).toBe(true);
  await applyCostAction(e.id, execution.id, { action: 'resume' }, 'owner');
  if (assessed.status === 'queued') await progressEvaluation(evaluation.id);
  else await progressExecution(execution.id);
  expect(send).toHaveBeenCalledTimes(3);
  expect((await getExecution(e.id, execution.id)).sections[0]).toEqual(paused.sections[0]);
});
it('defaults missing controls to no sends and requires finite corrections with append-only authenticated audit', async () => {
  const { e, execution } = await fixture(null);
  expect(execution.cost?.paused).toBe(true);
  const send = vi.spyOn(xaiGrok, 'complete');
  expect(await progressExecution(execution.id)).toEqual({ processed: false }); expect(send).not.toHaveBeenCalled();
  await sharedDb().execute(sql`update development_executions set generation_status='failed' where id=${execution.id}`);
  await applyCostAction(e.id, execution.id, { action: 'report', amount: 2, currency: 'USD', note: 'Provider dashboard' }, 'owner');
  const corrected = await applyCostAction(e.id, execution.id, { action: 'report', amount: 3, currency: 'EUR', note: 'Corrected total' }, 'owner');
  expect(corrected.events.filter(e => e.action === 'report')).toHaveLength(2); expect(corrected.reported_total).toMatchObject({ amount: 3, currency: 'EUR', actor: 'owner' });
  await expect(sharedDb().execute(sql`delete from development_cost_events where execution_id=${execution.id}`)).rejects.toThrow();
  expect((await POST(request({ action: 'report', amount: -1, currency: 'USD' }), context(e.id, execution.id))).status).toBe(400);
});
it('retains uncertain reservations, settles only saved evidence, and never resumes uncertain sends', async () => {
  const { e, execution } = await fixture();
  const bound = rawCallBound('openai', { model: 'gpt-4.1', system: '', user: '', temperature: 0, max_tokens: 1 });
  await reserveCost(execution.id, `${execution.id}-unknown`, 'generation', bound);
  expect((await getCostAccount(e.id, execution.id))?.unknown_active_reservations).toBe(1);
  await settleCost(execution.id, `${execution.id}-unknown`, { cost_usd: null, price: null, reason: 'Missing provider counts.' });
  expect((await getCostAccount(e.id, execution.id))?.unknown_usage_calls).toBe(1);
  const send = vi.spyOn(xaiGrok, 'complete').mockRejectedValue(new Error('Connection lost after dispatch.'));
  await progressExecution(execution.id);
  expect(send).toHaveBeenCalledOnce(); expect((await getCostAccount(e.id, execution.id))?.unknown_active_reservations).toBe(1);
  await progressExecution(execution.id); expect(send).toHaveBeenCalledOnce();
  await expect(applyCostAction(e.id, execution.id, { action: 'resume' }, 'owner')).rejects.toMatchObject({ code: 'uncertain_call' });
});
it('separates exact known generation/evaluation usage, price provenance and reported corrections', async () => {
  const { e, execution } = await fixture();
  const bound = rawCallBound('openai', { model: 'gpt-4.1', system: '', user: '', temperature: 0, max_tokens: 1 });
  const { developmentUsageCost } = await import('@/modules/development/cost');
  const usage = developmentUsageCost('openai', 'gpt-4.1', { source: 'provider', input_tokens: 1000, output_tokens: 1000, total_tokens: 2000, reasoning_tokens: null });
  for (const kind of ['generation', 'evaluation'] as const) {
    const call = `${execution.id}-${kind}`;
    await reserveCost(execution.id, call, kind, bound); await settleCost(execution.id, call, usage);
  }
  const account = await getCostAccount(e.id, execution.id);
  expect(account?.generation_usage_usd).toBe(0.01); expect(account?.evaluation_usage_usd).toBe(0.01);
  expect(account?.reservations[0].usage_cost?.price).toMatchObject({ model: 'gpt-4.1', updated_at: '2026-09-23' });
  expect(account?.reported_total).toBeNull(); expect(account?.estimate.total_usd).toBeNull();
  await expect(settleCost(execution.id, 'invalid', { cost_usd: Infinity, price: null, reason: null })).rejects.toMatchObject({ code: 'invalid_usage_cost' });
  await expect(reserveCost(execution.id, 'invalid', 'generation', { ...bound, cost_usd: -1 })).rejects.toMatchObject({ code: 'invalid_bound' });
});
it('requires unknown acknowledgment even with override and audits authenticated API actions', async () => {
  const { e, execution } = await fixture({ allowance_usd: 0, unknown_acknowledged: false });
  await expect(applyCostAction(e.id, execution.id, { action: 'resume' }, 'owner')).rejects.toMatchObject({ code: 'cost_paused' });
  await applyCostAction(e.id, execution.id, { action: 'override', enabled: true }, 'owner');
  await applyCostAction(e.id, execution.id, { action: 'resume' }, 'owner');
  const bound = rawCallBound('openai', { model: 'gpt-4.1', system: '', user: '', temperature: 0, max_tokens: 1 });
  await expect(reserveCost(execution.id, 'not-authorized', 'generation', bound)).rejects.toMatchObject({ code: 'cost_paused' });
  const access = await owner.ownerAccess();
  vi.spyOn(owner, 'ownerAccess').mockResolvedValue({ ...access, owner: true, email: 'verified@example.test' });
  const response = await POST(request({ action: 'acknowledge_unknown' }), context(e.id, execution.id));
  expect(response.status).toBe(200); expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect((await response.json()).account.events.at(-1).actor).toBe('verified@example.test');
  expect((await GET(request({}), context(e.id, execution.id))).status).toBe(200);
  await expect(applyCostAction(e.id, execution.id, { action: 'pause' }, '')).rejects.toMatchObject({ code: 'missing_actor' });
  await expect(applyCostAction('foreign', execution.id, { action: 'pause' }, 'owner')).rejects.toMatchObject({ code: 'not_found' });
});
it('keeps historical records readable and refuses unsafe historical authorization without an account', async () => {
  const e = await createExperiment('Historical costs', null, 'owner');
  const id = `${e.id}-old`, at = new Date().toISOString();
  await sharedDb().execute(sql`insert into development_executions(id,experiment_id,manifest,generation_status,created_at,updated_at) values(${id},${e.id},'{}'::jsonb,'succeeded',${at},${at})`);
  expect((await getExecution(e.id, id)).cost).toBeNull();
  await expect(applyCostAction(e.id, id, { action: 'increase', amount_usd: 1 }, 'owner')).rejects.toMatchObject({ code: 'historical_cost_unavailable' });
  await expect(reserveCost(id, 'old-call', 'generation', rawCallBound('openai', { model: 'gpt-4.1', system: '', user: '', temperature: 0, max_tokens: 1 }))).rejects.toMatchObject({ code: 'cost_paused' });
});
it.each(['code identity', 'AI switch', 'worker lease'] as const)('does not let spending resume bypass %s safety', async safety => {
  const { e, execution } = await fixture({ allowance_usd: 1, unknown_acknowledged: false });
  const send = vi.spyOn(xaiGrok, 'complete').mockResolvedValue('{}');
  await progressExecution(execution.id);
  expect((await getCostAccount(e.id, execution.id))?.paused).toBe(true);
  await applyCostAction(e.id, execution.id, { action: 'acknowledge_unknown' }, 'owner');
  await applyCostAction(e.id, execution.id, { action: 'resume' }, 'owner');
  if (safety === 'code identity') vi.spyOn(executionSafety, 'executionCodeIdentity').mockReturnValue('different-deployed-code');
  if (safety === 'AI switch') await setAiSection({ section: 'gap_extraction', enabled: false, actor_name: 'test' });
  if (safety === 'worker lease') await sharedDb().execute(sql`update development_executions set claim_token='other-worker',claim_until=now()+interval '5 minutes' where id=${execution.id}`);
  try {
    const progress = await progressExecution(execution.id);
    expect(send).not.toHaveBeenCalled();
    expect((await getExecution(e.id, execution.id)).calls[0].status).toBe('queued');
    if (safety === 'AI switch') {
      // A dispatch refusal fails its section first; the next bounded progression finalizes the execution.
      expect((await getExecution(e.id, execution.id)).sections[0].status).toBe('failed');
      await progressExecution(execution.id);
      expect(send).not.toHaveBeenCalled();
    }
    if (safety === 'worker lease') expect(progress).toEqual({ processed: false });
    else expect((await getExecution(e.id, execution.id)).generation_status).toBe('failed');
  } finally {
    if (safety === 'AI switch') await setAiSection({ section: 'gap_extraction', enabled: true, actor_name: 'test' });
  }
});
it.each(['generation', 'evaluation'] as const)('preserves an unsent %s reservation when another worker pauses the shared account', async kind => {
  const { e, execution } = await fixture();
  const send = vi.spyOn(xaiGrok, 'complete').mockResolvedValue(JSON.stringify({ gaps: [{ name: 'Comparative evidence', statement: quote, domain: 'comparative_effectiveness', source_quote: quote }] }));
  let evaluationId: string | undefined;
  if (kind === 'evaluation') {
    await progressExecution(execution.id); await progressExecution(execution.id);
    const finished = await getExecution(e.id, execution.id);
    const evaluation = await startEvaluation(e.id, startEvaluationSchema.parse({ execution_id: execution.id, attempt_id: finished.sections[0].id, output_id: finished.sections[0].result!.output_id, section: 'gap_extraction', cost_controls: { allowance_usd: 0, unknown_acknowledged: true } }));
    evaluationId = evaluation.id;
    send.mockResolvedValue(JSON.stringify({ criteria: evaluation.manifest.criteria.map(c => ({ criterion_id: c.id, score: 3, reason: 'Supported.' })), matches: [], unmatched_output_ids: [], unmatched_reference_ids: [] }));
    send.mockClear();
  }
  const originalBound = costEvidence.rawCallBound;
  vi.spyOn(costEvidence, 'rawCallBound').mockImplementation((provider, raw) => ({ ...originalBound(provider, raw), cost_usd: 0.75 }));
  const originalReserve = costStore.reserveCost;
  let callId = '';
  const reserve = vi.spyOn(costStore, 'reserveCost').mockImplementationOnce(async (executionId, id, callKind, bound) => {
    callId = id;
    await originalReserve(executionId, id, callKind, bound);
    // Recover a committed pre-send reservation after a competing worker exhausts the shared allowance.
    await expect(originalReserve(executionId, `${id}-competing`, callKind === 'generation' ? 'evaluation' : 'generation', bound)).rejects.toMatchObject({ code: 'cost_paused' });
    await expect(originalReserve(executionId, id, callKind, { ...bound, cost_usd: 0.5 })).rejects.toMatchObject({ code: 'reservation_conflict' });
    await originalReserve(executionId, id, callKind, bound);
  });
  const progress = () => kind === 'generation' ? progressExecution(execution.id) : progressEvaluation(evaluationId!);
  const pausedProgress = await progress();
  expect(pausedProgress).toMatchObject(kind === 'generation' ? { generation_status: 'queued' } : { evaluation_status: 'queued' });
  expect(send).not.toHaveBeenCalled();
  const paused = await getCostAccount(e.id, execution.id);
  const saved = paused!.reservations.find(r => r.call_id === callId)!;
  expect(saved).toMatchObject({ kind, status: 'active', bound_usd: 0.75, usage_cost: null, settled_at: null });
  expect(paused?.paused).toBe(true);
  if (kind === 'generation') {
    const queued = await getExecution(e.id, execution.id);
    expect(queued.calls.find(c => c.id === callId)).toMatchObject({ status: 'queued', sending_at: null });
    expect(queued.sections[0].status).toBe('running');
  } else expect(await getEvaluation(e.id, evaluationId!)).toMatchObject({ status: 'queued', sending_at: null });
  expect(await progress()).toEqual({ processed: false });
  reserve.mockRestore();
  await applyCostAction(e.id, execution.id, { action: 'increase', amount_usd: 0.5 }, 'owner');
  await applyCostAction(e.id, execution.id, { action: 'resume' }, 'owner');
  await progress(); await progress(); await progress();
  expect(send).toHaveBeenCalledOnce();
  const resumed = await getCostAccount(e.id, execution.id);
  expect(resumed!.reservations.filter(r => r.call_id === callId)).toHaveLength(1);
  expect(resumed!.reservations.find(r => r.call_id === callId)).toMatchObject({ status: 'settled', created_at: saved.created_at, bound_evidence: saved.bound_evidence });
});

it.each((['generation', 'evaluation'] as const).flatMap(kind => [false, true].flatMap(failedSend => [false, true].map(interrupted => ({ kind, failedSend, interrupted })))))('recovers $kind saved accounting (failure=$failedSend, interruption=$interrupted) without another provider send', async ({ kind, failedSend, interrupted }) => {
  const { e, execution } = await fixture();
  const send = vi.spyOn(xaiGrok, 'complete').mockResolvedValue(JSON.stringify({ gaps: [{ name: 'Comparative evidence', statement: quote, domain: 'comparative_effectiveness', source_quote: quote }] }));
  let evaluationId: string | undefined;
  let completedSections: unknown;
  if (kind === 'evaluation') {
    await progressExecution(execution.id); await progressExecution(execution.id);
    const finished = await getExecution(e.id, execution.id);
    completedSections = finished.sections;
    const evaluation = await startEvaluation(e.id, startEvaluationSchema.parse({ execution_id: execution.id, attempt_id: finished.sections[0].id, output_id: finished.sections[0].result!.output_id, section: 'gap_extraction', cost_controls: { allowance_usd: 0, unknown_acknowledged: true } }));
    evaluationId = evaluation.id;
    send.mockResolvedValue(JSON.stringify({ criteria: evaluation.manifest.criteria.map(c => ({ criterion_id: c.id, score: 3, reason: 'Supported.' })), matches: [], unmatched_output_ids: [], unmatched_reference_ids: [] }));
    send.mockClear();
  }
  if (failedSend) send.mockImplementation(async (_request, _auth, hooks) => {
    hooks?.onUsage?.({ source: 'provider', input_tokens: 10, output_tokens: 4, total_tokens: 14, reasoning_tokens: null });
    throw new Error('Saved provider failure.');
  });
  const originalBound = costEvidence.rawCallBound;
  const bound = vi.spyOn(costEvidence, 'rawCallBound').mockImplementation((provider, raw) => ({ ...originalBound(provider, raw), cost_usd: 0.75 }));
  const usage = vi.spyOn(costEvidence, 'developmentUsageCost').mockReturnValue({ cost_usd: 0.2, price: null, reason: null });
  const settlement = vi.spyOn(costStore, 'settleCost').mockRejectedValueOnce(new Error('Transient ledger unavailable.'));
  const release = interrupted ? (kind === 'generation'
    ? vi.spyOn(executionStore, 'releaseExecution').mockRejectedValue(new Error('Simulated process interruption.'))
    : vi.spyOn(evaluationStore, 'releaseEvaluation').mockRejectedValue(new Error('Simulated process interruption.'))) : null;
  const progress = () => kind === 'generation' ? progressExecution(execution.id) : progressEvaluation(evaluationId!);
  if (interrupted) await expect(progress()).rejects.toThrow('Simulated process interruption.');
  else await progress();
  release?.mockRestore();
  const savedExecution = await getExecution(e.id, execution.id);
  const saved = kind === 'generation' ? savedExecution.calls[0] : await getEvaluation(e.id, evaluationId!);
  expect(send).toHaveBeenCalledOnce();
  expect(saved.status).toBe(kind === 'evaluation' ? 'received' : failedSend ? 'failed' : 'succeeded');
  expect(saved.receipt !== null).toBe(!failedSend);
  if (failedSend) expect(saved.failure_accounting?.usage).toMatchObject({ source: 'provider', input_tokens: 10, output_tokens: 4 });
  const reservations = (await getCostAccount(e.id, execution.id))!.reservations.filter(r => r.kind === kind);
  expect(reservations).toHaveLength(1);
  expect(reservations[0]).toMatchObject({ status: 'active', usage_cost: null });
  if (interrupted) {
    await applyCostAction(e.id, execution.id, { action: 'pause' }, 'owner');
    if (kind === 'generation') await sharedDb().execute(sql`update development_executions set claim_until=now()-interval '1 second' where id=${execution.id}`);
    else await sharedDb().execute(sql`update development_evaluations set claim_until=now()-interval '1 second' where id=${evaluationId!}`);
  }
  await progress(); await progress(); await progress();
  const finished = await getExecution(e.id, execution.id);
  const recovered = kind === 'generation' ? finished.calls[0] : await getEvaluation(e.id, evaluationId!);
  expect(send).toHaveBeenCalledOnce();
  expect(recovered.receipt).toEqual(saved.receipt);
  expect(recovered.failure_accounting).toEqual(saved.failure_accounting);
  expect(finished.manifest).toEqual(execution.manifest);
  if (kind === 'generation') expect(finished.generation_status).toBe(failedSend ? 'failed' : 'succeeded');
  else {
    expect((recovered as evaluationStore.Evaluation).status).toBe(failedSend ? 'failed' : 'succeeded');
    expect((recovered as evaluationStore.Evaluation).manifest).toEqual((saved as evaluationStore.Evaluation).manifest);
    expect(finished.sections).toEqual(completedSections);
  }
  const account = await getCostAccount(e.id, execution.id);
  const finalReservations = account!.reservations.filter(r => r.kind === kind);
  expect(finalReservations).toHaveLength(1);
  expect(finalReservations[0]).toMatchObject({ call_id: reservations[0].call_id, status: failedSend ? 'active' : 'settled', bound_evidence: reservations[0].bound_evidence, created_at: reservations[0].created_at, usage_cost: { cost_usd: 0.2 } });
  expect(kind === 'generation' ? account!.generation_usage_usd : account!.evaluation_usage_usd).toBe(0.2);
  await progress();
  expect(await getCostAccount(e.id, execution.id)).toEqual(account);
  expect(send).toHaveBeenCalledOnce();
  if (failedSend) await expect(applyCostAction(e.id, execution.id, { action: 'resume' }, 'owner')).rejects.toMatchObject({ code: 'uncertain_call' });
  settlement.mockRestore(); bound.mockRestore(); usage.mockRestore(); send.mockRestore();
});
