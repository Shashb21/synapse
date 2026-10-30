/** Durable owner API tests: arrange a source draft, act through routes/workers, assert receipts. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { sharedDb } from '@/lib/iegp/db';
import { createExperiment, updateExperiment } from '@/modules/development/store';
import { canonicalParsedJson, sha256 } from '@/modules/development/documents';
import type { DevelopmentDocument } from '@/modules/development/schema';
import { POST, GET } from '@/app/api/admin/development/[id]/executions/route';
import { GET as detail } from '@/app/api/admin/development/[id]/executions/[executionId]/route';
import { progressExecution } from '@/modules/development/worker';
import { getExecution } from '@/modules/development/execution-store';
import { setAiSection } from '@/modules/kernel/ai-switch';
import { xaiGrok, PROVIDERS, RETRY } from '@/modules/llm/provider';
import * as owner from '@/modules/auth/owner';
import * as llm from '@/modules/kernel/llm';
import type { JsonCompletion } from '@/modules/kernel/contracts';
import * as worker from '@/modules/development/worker';
import * as executionStore from '@/modules/development/execution-store';
import { POST as deliver } from '@/app/api/internal/development-worker/route';
import { setAiEnabled } from '@/modules/kernel/ai-switch';
let sourceId = '';

const quote = 'Comparative effectiveness remains unknown. An ongoing observational study measures outcomes.';
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const request = (body: unknown) => new Request('http://localhost/api/admin/development', { method: 'POST', body: JSON.stringify(body) });
async function draft() {
  const experiment = await createExperiment('Execution proof', null, 'owner');
  const parsed = { blocks: [{ id: 'b1', text: quote, heading: 'Evidence', location: '1' }] };
  const document = { id: `${experiment.id}-source`, experiment_id: experiment.id, role: 'source', compatibility: 'compatible', filename: 'source.txt', sha256: sha256(quote), parsed_sha256: sha256(canonicalParsedJson(parsed)), parsed_at: '2026-10-30T00:00:00Z', parser: { name: 'test', version: '1', model: null, prompt: null }, parsed } as DevelopmentDocument;
  sourceId = document.id;
  return updateExperiment(experiment.id, 1, { document, content_base64: Buffer.from(quote).toString('base64') });
}
const start = (id: string, revision = 2, target = 'all', config = { mode: 'single_pass' }, prerequisites = {}) => POST(request({ revision, target, config, prerequisites }), ctx(id));
beforeEach(async () => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unscripted network is forbidden in execution tests.'));
  vi.stubEnv('SYNAPSE_DEVELOPMENT_DELIVERY', 'github_actions');
  vi.stubEnv('CRON_SECRET', 'isolated-test-worker-secret-long-enough');
  vi.stubEnv('XAI_API_KEY', 'test-key-never-send');
  vi.spyOn(llm, 'isTestStub').mockReturnValue(false);
  for (const section of ['gap_extraction', 'tactic_extraction', 'mapping', 'partial_split'] as const) await setAiSection({ section, enabled: true, actor_name: 'test' });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
it('refuses unavailable delivery, stale revisions and concurrent conflicting starts; manifests contain sources only', async () => {
  const e = await draft();
  vi.stubEnv('SYNAPSE_DEVELOPMENT_DELIVERY', '');
  expect((await start(e.id)).status).toBe(503);
  vi.stubEnv('SYNAPSE_DEVELOPMENT_DELIVERY', 'github_actions');
  expect((await start(e.id, 1)).status).toBe(409);
  const responses = await Promise.all([start(e.id), start(e.id)]);
  expect(responses.map(r => r.status).sort()).toEqual([202, 409]);
  const execution = (await responses.find(r => r.status === 202)!.json()).execution;
  expect(execution.manifest.sources).toHaveLength(1);
  expect(execution.manifest.config.mode).toBe('single_pass');
  expect(execution.evaluation_status).toBe('not_requested');
  expect((await GET(request({}), ctx(e.id))).status).toBe(200);
  expect((await detail(request({}), { params: Promise.resolve({ id: 'foreign', executionId: execution.id }) })).status).toBe(404);
});
it('claims before sending, replays saved raw replies and concurrent deliveries cannot duplicate a call', async () => {
  const e = await draft();
  const execution = (await (await start(e.id, 2, 'gap_extraction')).json()).execution;
  const send = vi.spyOn(xaiGrok, 'complete').mockImplementation(async (_request, _auth, hooks) => {
    const rows = await sharedDb().execute(sql`select status from development_execution_calls where execution_id=${execution.id}`);
    expect(rows[0].status).toBe('sending');
    expect(hooks?.maxAttempts).toBe(1);
    return JSON.stringify({ gaps: [{ name: 'Comparative evidence', statement: quote, domain: 'comparative_effectiveness', source_quote: quote }] });
  });
  await Promise.all([progressExecution(execution.id), progressExecution(execution.id)]);
  expect(send).toHaveBeenCalledOnce();
  await progressExecution(execution.id);
  const reopened = await getExecution(e.id, execution.id);
  expect(reopened.generation_status).toBe('succeeded');
  expect(reopened.sections[0].result?.review_status).toBe('unreviewed');
  await progressExecution(execution.id);
  expect(send).toHaveBeenCalledOnce();
});
it('requires owner access and latest prerequisite identities, and validates provider settings', async () => {
  const e = await draft();
  expect((await start(e.id, 2, 'matching_coverage')).status).toBe(409);
  expect((await start(e.id, 2, 'all', { mode: 'single_pass', stages: { gap_extraction: { route: { provider_id: 'missing', model: 'invalid' } } } } as never)).status).toBe(400);
  vi.spyOn(owner, 'ownerGate').mockResolvedValue(NextResponse.json({ code: 'owner_only' }, { status: 403 }));
  expect((await start(e.id)).status).toBe(403);
  expect((await GET(request({}), ctx(e.id))).status).toBe(403);
});

const gap = { name: 'Comparative evidence', statement: 'Comparative effectiveness remains unknown.', domain: 'comparative_effectiveness', source_quote: quote };
const tactic = { name: 'Observational outcomes study', type: 'rwe_study', status: 'ongoing', evidence_question: 'What are patient outcomes?', source_quote: quote };
const dimensions = { relevance: 'yes', population: 'partial', geography: 'unknown', timing: 'yes', intervention: 'yes', comparator: 'no', outcomes: 'partial', setting: 'unknown', methodology: 'partial', decision_utility: 'no' };
type Section = import('@/modules/development/schema').DevelopmentSection;
type Options = { reject?: boolean; revise?: boolean; coverage?: 'full' | 'partial' | 'limited' | 'not_relevant'; badReference?: boolean; badTactic?: boolean; tacticStatus?: string };
/** Script the real stage prompt contracts; every call remains offline and recorded. */
function scripted(section: Section, options: Options = {}) {
  let critics = 0;
  return vi.fn<JsonCompletion>().mockImplementation(async request => {
    const body = request.user.startsWith('{') ? JSON.parse(request.user) : {};
    const verdict = options.reject ? 'reject' : 'accept';
    const review = request.role === 'critic' && options.revise && ++critics === 1 ? 'revise' : 'keep';
    if (section === 'gap_extraction') {
      if (request.role === 'proposer') return { gaps: [gap] };
      if (request.role === 'reviser') return { gaps: body.candidates.map((row: { id: string }) => ({ ...gap, id: row.id })) };
      if (request.role === 'critic') return { critiques: body.candidates.map((row: { subject: string }) => ({ subject: row.subject, verdict: review, confidence: 80, note: 'Source supports the question.' })) };
      return { decisions: body.candidates.filter((row: { decide: boolean }) => row.decide).map((row: { subject: string }) => ({ subject: row.subject, verdict, confidence: 80, reason: 'Question checked against source.', match: 'new', match_gap_id: null, duplicate_of: null })) };
    }
    if (section === 'tactic_extraction') {
      if (request.role === 'proposer') return { tactics: [{ ...tactic, status: options.tacticStatus ?? tactic.status }] };
      if (request.role === 'reviser') return { tactics: body.rows.map((row: { id: string }) => ({ ...tactic, id: row.id })) };
      if (request.role === 'critic') return { reviews: body.candidates.map((row: { id: string }) => ({ id: row.id, verdict: review, confidence: 80, note: 'Source supports the study.' })) };
      return { decisions: body.decide.map((row: { id: string }) => ({ id: row.id, verdict, match: 'new', target_tactic_id: null, duplicate_of: null, confidence: 80, reason: 'Study checked against source.' })) };
    }
    if (section === 'matching_coverage') {
      if (request.role === 'proposer' || request.role === 'reviser') return { rows: body.gaps.map((row: { id: string }) => ({ gap_id: row.id, mapping_status: options.coverage === 'full' ? 'addressed' : options.coverage === 'not_relevant' ? 'open' : 'partially_addressed', confidence: 78, rationale: 'Study answers only the outcomes slice.', mappings: [{ tactic_id: options.badTactic ? 'unknown-tactic' : body.tactics[0].id, coverage: options.coverage ?? 'partial', confidence: 78, rationale: 'Comparative outcome evidence remains unavailable.', dimensions: options.coverage === 'not_relevant' ? null : dimensions, references: [{ entity_type: 'source', entity_id: options.badReference ? 'unseen-source' : sourceId, reason: 'Source records the ongoing study.' }] }] })) };
      if (request.role === 'critic') return { reviews: body.rows.map((row: { gap: { id: string }; mappings: { tactic_id: string }[] }) => ({ gap_id: row.gap.id, verdict: review, confidence: 80, note: 'Source supports the coverage.', mappings: row.mappings.map(mapping => ({ tactic_id: mapping.tactic_id, verdict: review, note: 'Assess the comparative slice.' })) })) };
      return { verdicts: body.rows.map((row: { gap: { id: string } }) => ({ gap_id: row.gap.id, verdict, confidence: 80, reason: 'Coverage checked.' })) };
    }
    if (request.role === 'proposer' || request.role === 'reviser') return { addressed_name: 'Observed outcomes', addressed_statement: 'Patient outcomes are measured in the observational population.', addressed_tactic_ids: [options.badTactic ? 'unknown-tactic' : body.mapped_tactics[0].id], open_name: 'Comparative outcomes', open_statement: 'Comparative outcomes against standard care remain unknown.', uncovered_dimensions: ['population'], confidence: 78, rationale: 'The supplied study observes outcomes without a comparator.' };
    if (request.role === 'critic') return { verdict: review, confidence: 80, note: 'Children preserve distinct scope.', issues: [] };
    return { verdict, confidence: 80, note: 'Split follows supplied coverage.' };
  });
}

/** Drive persisted work through fresh worker invocations without any browser polling dependency. */
async function finish(experimentId: string, executionId: string) {
  for (let i = 0; i < 100; i++) {
    const e = await getExecution(experimentId, executionId);
    if (!['queued', 'running'].includes(e.generation_status)) return e;
    await progressExecution(executionId);
  }
  throw new Error('Scripted execution did not finish within 100 bounded deliveries.');
}
/** Mock only raw provider text; actual routing, repair, stage adapters and database claims remain real. */
function providerScript(executionId: string, options: Options = {}) {
  const scripts = Object.fromEntries(['gap_extraction', 'tactic_extraction', 'matching_coverage', 'partial_splitting'].map(s => [s, scripted(s as Section, options)]));
  const sends = PROVIDERS.map(provider => vi.spyOn(provider, 'complete').mockImplementation(async raw => {
    const rows = await sharedDb().execute(sql`select c.request,c.route,s.section from development_execution_calls c join development_execution_sections s on s.id=c.section_id where c.execution_id=${executionId} and c.status='sending'`);
    expect(rows).toHaveLength(1);
    expect((rows[0].route as { actual: { provider_id: string } }).actual.provider_id).toBe(provider.id);
    const call = rows[0].request as { role: import('@/modules/kernel/contracts').CompletionRole; purpose: string };
    return JSON.stringify(await scripts[rows[0].section as string]({ system: raw.system, user: raw.user, purpose: call.purpose, role: call.role }));
  }));
  return { send: sends[0], sends, scripts };
}
it.each(['single_pass', 'standard'] as const)('runs all four real stages through immutable API and durable replay in %s', async mode => {
  const e = await draft();
  const response = await start(e.id, 2, 'all', { mode });
  expect(response.status).toBe(202);
  const execution = (await response.json()).execution;
  const { send, scripts } = providerScript(execution.id, { revise: mode === 'standard' });
  const before = await sharedDb().execute(sql`select * from platform_settings order by key`);
  const result = await finish(e.id, execution.id);
  expect(result.generation_status).toBe('succeeded');
  expect(result.sections.map(s => s.status)).toEqual(['succeeded', 'succeeded', 'succeeded', 'succeeded']);
  expect(result.sections[3].result?.local_state.gaps).toHaveLength(1);
  expect(result.sections.every(s => s.result?.review_status === 'unreviewed')).toBe(true);
  expect(result.evaluation_status).toBe('not_requested');
  expect(result.calls.every(c => c.status === 'succeeded' && c.receipt?.text)).toBe(true);
  expect(send).toHaveBeenCalledTimes(result.calls.length);
  for (const script of Object.values(scripts)) expect(script.mock.calls.map(([r]) => r.role)).toEqual(mode === 'standard' ? ['proposer', 'critic', 'reviser', 'critic', 'critic', 'internal_judge'] : ['proposer']);
  expect(await sharedDb().execute(sql`select * from platform_settings order by key`)).toEqual(before);
  const calls = await sharedDb().execute(sql`select workspace_id from llm_calls where run_id in (select id from development_execution_sections where execution_id=${execution.id})`);
  expect(calls).toHaveLength(result.calls.length);
  expect(calls.every(c => c.workspace_id === null)).toBe(true);
  const bindings = Object.fromEntries(result.sections.slice(0, 3).map(s => [s.section, { attempt_id: s.id, output_id: s.result!.output_id }]));
  const rerun = await POST(request({ revision: 2, target: 'partial_splitting', config: { mode }, prerequisites: bindings }), ctx(e.id));
  expect(rerun.status).toBe(202);
  const next = (await rerun.json()).execution;
  send.mockRestore();
  providerScript(next.id, { revise: mode === 'standard' });
  expect((await finish(e.id, next.id)).generation_status).toBe('succeeded');
  expect((await getExecution(e.id, execution.id)).sections).toEqual(result.sections);
});
it('checkpoints JSON repairs as distinct raw sends and reuses the real completionFor repair algorithm', async () => {
  const e = await draft();
  const execution = (await (await start(e.id, 2, 'gap_extraction')).json()).execution;
  const send = vi.spyOn(xaiGrok, 'complete').mockResolvedValueOnce('not-json').mockResolvedValue(JSON.stringify({ gaps: [gap] }));
  const result = await finish(e.id, execution.id);
  expect(result.generation_status).toBe('succeeded');
  expect(send).toHaveBeenCalledTimes(2);
  expect(result.calls[1].request.request.system).toContain('previous reply was not valid JSON');
  expect(result.calls.map(c => c.request.role)).toEqual(['proposer', 'proposer']);
});
it('does not resend an interrupted sending call when its expired lease is recovered', async () => {
  const e = await draft();
  const execution = (await (await start(e.id, 2, 'gap_extraction')).json()).execution;
  const send = vi.spyOn(xaiGrok, 'complete').mockResolvedValue(JSON.stringify({ gaps: [gap] }));
  await progressExecution(execution.id);
  await sharedDb().execute(sql`update development_execution_calls set status='sending',receipt=null where execution_id=${execution.id}`);
  await sharedDb().execute(sql`update development_executions set claim_token='crashed-worker',claim_until=now()-interval '1 second',generation_status='running' where id=${execution.id}`);
  await progressExecution(execution.id);
  expect((await getExecution(e.id, execution.id)).generation_status).toBe('needs_attention');
  await progressExecution(execution.id);
  expect(send).toHaveBeenCalledOnce();
});
it('keeps a successful provider send indeterminate when authoritative receipt storage fails', async () => {
  const e = await draft();
  const execution = (await (await start(e.id, 2, 'gap_extraction')).json()).execution;
  const send = vi.spyOn(xaiGrok, 'complete').mockResolvedValue(JSON.stringify({ gaps: [gap] }));
  vi.spyOn(executionStore, 'settleCall').mockRejectedValueOnce(new Error('Receipt storage unavailable'));
  await progressExecution(execution.id);
  expect((await getExecution(e.id, execution.id)).generation_status).toBe('needs_attention');
  await progressExecution(execution.id);
  expect(send).toHaveBeenCalledOnce();
});
it('checks master and section switches immediately before every actual send, including repairs', async () => {
  const e = await draft();
  const execution = (await (await start(e.id, 2, 'gap_extraction')).json()).execution;
  const send = vi.spyOn(xaiGrok, 'complete').mockImplementationOnce(async () => {
    await setAiSection({ section: 'gap_extraction', enabled: false, actor_name: 'test' });
    return 'not-json';
  });
  const result = await finish(e.id, execution.id);
  expect(result.generation_status).toBe('failed');
  expect(send).toHaveBeenCalledOnce();
  await setAiEnabled({ enabled: false, actor_name: 'test' });
  try { expect((await start(e.id)).status).toBe(409); }
  finally { await setAiEnabled({ enabled: true, actor_name: 'test' }); }
});
it('authenticates scheduler delivery independently of owner sessions', async () => {
  vi.spyOn(worker, 'progressExecution').mockResolvedValue({ processed: false });
  expect((await deliver(request({}))).status).toBe(401);
  const authorized = new Request('http://localhost/api/internal/development-worker', { method: 'POST', headers: { authorization: 'Bearer isolated-test-worker-secret-long-enough' } });
  expect((await deliver(authorized)).status).toBe(200);
});
it('lets the exact bearer-authenticated worker route reach its own auth gate without customer cookies', async () => {
  const { gateFor } = await import('@/modules/auth/gate');
  expect(gateFor('/api/internal/development-worker')).toBe('open');
  expect(gateFor('/api/internal/development-worker/other')).toBe('workspace');
  expect(gateFor('/api/internal/other')).toBe('workspace');
});
it('fails only dependent stages after an extraction rejection, retaining independent S3 success', async () => {
  const e = await draft();
  const execution = (await (await start(e.id, 2, 'all', { mode: 'standard' })).json()).execution;
  providerScript(execution.id, { reject: true });
  // Keep independent S3 valid while S2's actual model judge rejects its output.
  const original = xaiGrok.complete;
  vi.spyOn(xaiGrok, 'complete').mockImplementation(async (raw, auth, hooks) => {
    const rows = await sharedDb().execute(sql`select s.section from development_execution_calls c join development_execution_sections s on s.id=c.section_id where c.execution_id=${execution.id} and c.status='sending'`);
    if (rows[0].section === 'tactic_extraction') {
      const calls = await sharedDb().execute(sql`select request from development_execution_calls where execution_id=${execution.id} and status='sending'`);
      const call = calls[0].request as { role: import('@/modules/kernel/contracts').CompletionRole; purpose: string };
      return JSON.stringify(await scripted('tactic_extraction')({ ...raw, purpose: call.purpose, role: call.role }));
    }
    return original(raw, auth, hooks);
  });
  const result = await finish(e.id, execution.id);
  expect(result.sections.map(s => s.status)).toEqual(['rejected', 'succeeded', 'blocked', 'blocked']);
  expect(result.calls.every(c => !['matching_coverage', 'partial_splitting'].includes(result.sections.find(s => s.id === c.section_id)!.section))).toBe(true);
});
it('freezes source-only inputs across draft edits and excludes reference answers from all generation calls', async () => {
  const e = await draft();
  const source = e.documents[0];
  await updateExperiment(e.id, 2, { document: { ...source, id: `${e.id}-gold`, role: 'reference', parsed: { GOLD_REFERENCE_SECRET: 'never send to generation' } }, content_base64: 'eA==' });
  const execution = (await (await start(e.id, 3)).json()).execution;
  providerScript(execution.id);
  await updateExperiment(e.id, 3, { name: 'Changed after queueing' });
  const result = await finish(e.id, execution.id);
  expect(result.generation_status).toBe('succeeded');
  expect(result.manifest.revision).toBe(3);
  expect(result.manifest.sources.map(s => s.role)).toEqual(['source']);
  expect(JSON.stringify(result.calls)).not.toContain('GOLD_REFERENCE_SECRET');
  await expect(sharedDb().execute(sql`update development_executions set manifest='{}'::jsonb where id=${execution.id}`)).rejects.toThrow();
  expect((await getExecution(e.id, execution.id)).manifest).toEqual(result.manifest);
});
it('invalidates exact downstream lineage after a newer failed upstream attempt and after generation settings change', async () => {
  const e = await draft();
  const first = (await (await start(e.id)).json()).execution;
  providerScript(first.id);
  const result = await finish(e.id, first.id);
  const prerequisites = Object.fromEntries(result.sections.slice(0, 3).map(s => [s.section, { attempt_id: s.id, output_id: s.result!.output_id }]));
  const altered = await POST(request({ revision: 2, target: 'partial_splitting', config: { mode: 'single_pass', stages: { gap_extraction: { route: { temperature: 0.7 } } } }, prerequisites }), ctx(e.id));
  expect(altered.status).toBe(409);
  const next = (await (await start(e.id, 2, 'gap_extraction')).json()).execution;
  vi.spyOn(xaiGrok, 'complete').mockResolvedValue('{"wrong":[]}');
  expect((await finish(e.id, next.id)).generation_status).toBe('failed');
  expect((await POST(request({ revision: 2, target: 'partial_splitting', config: { mode: 'single_pass' }, prerequisites }), ctx(e.id))).status).toBe(409);
});
it('allows evaluator-only changes without invalidating generation prerequisites and never sends evaluator requests', async () => {
  const e = await draft();
  const first = (await (await start(e.id)).json()).execution;
  providerScript(first.id);
  const result = await finish(e.id, first.id);
  const prerequisites = Object.fromEntries(result.sections.slice(0, 3).map(s => [s.section, { attempt_id: s.id, output_id: s.result!.output_id }]));
  const response = await POST(request({ revision: 2, target: 'partial_splitting', config: { mode: 'single_pass', evaluator: { provider_id: 'openai', model: 'gpt-5.1', fallbacks: [] } }, prerequisites }), ctx(e.id));
  expect(response.status).toBe(202);
  const next = (await response.json()).execution;
  providerScript(next.id);
  const completed = await finish(e.id, next.id);
  expect(completed.generation_status).toBe('succeeded');
  expect(completed.evaluation_status).toBe('not_requested');
  expect(completed.calls.every(c => c.route.actual.provider_id === 'xai-grok')).toBe(true);
});
it('rejects body/query/wrong or absent worker secrets and fails closed without durable configuration', async () => {
  for (const candidate of [request({ secret: 'isolated-test-worker-secret-long-enough' }), new Request('http://localhost/api/internal/development-worker?secret=isolated-test-worker-secret-long-enough', { method: 'POST' }), new Request('http://localhost', { method: 'POST', headers: { authorization: 'Bearer wrong-secret' } })]) expect((await deliver(candidate)).status).toBe(401);
  vi.stubEnv('CRON_SECRET', '');
  expect((await deliver(request({}))).status).toBe(401);
  vi.stubEnv('CRON_SECRET', 'isolated-test-worker-secret-long-enough');
  vi.stubEnv('SYNAPSE_DEVELOPMENT_DELIVERY', '');
  expect((await deliver(new Request('http://localhost', { method: 'POST', headers: { authorization: 'Bearer isolated-test-worker-secret-long-enough' } }))).status).toBe(503);
});
it.each(['standard', 'single_pass'] as const)('uses explicit actual role routes and settings in %s without shared routing writes', async mode => {
  const e = await draft();
  for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY']) vi.stubEnv(key, 'test-only-fake-key');
  const route = (provider_id: string, model: string, temperature: number) => ({ provider_id, model, temperature, max_tokens: 4096, fallbacks: [] });
  const overrides = mode === 'standard' ? { critic: route('openai', 'gpt-5.1', 0.4), reviser: route('anthropic-claude', 'claude-sonnet-5-5', 0.5), internal_judge: route('google-gemini', 'gemini-3.8-flash', 0.6) } : { proposer: route('openai', 'gpt-5.1', 0.7) };
  const input = { revision: 2, target: 'gap_extraction', config: { mode, stages: { gap_extraction: { route: route('xai-grok', 'grok-4', 0.3), overrides } } }, prerequisites: {} };
  const before = await sharedDb().execute(sql`select * from routing_config order by stage`);
  const response = await POST(request(input), ctx(e.id));
  expect(response.status).toBe(202);
  const execution = (await response.json()).execution;
  const { sends } = providerScript(execution.id, { revise: mode === 'standard' });
  const completed = await finish(e.id, execution.id);
  expect(completed.generation_status).toBe('succeeded');
  expect(completed.calls.map(c => [c.request.role, c.route.actual.provider_id, c.request.request.temperature])).toEqual(mode === 'standard' ? [['proposer', 'xai-grok', 0.3], ['critic', 'openai', 0.4], ['reviser', 'anthropic-claude', 0.5], ['critic', 'openai', 0.4], ['critic', 'openai', 0.4], ['internal_judge', 'google-gemini', 0.6]] : [['proposer', 'openai', 0.7]]);
  if (mode === 'standard') expect(completed.calls[2].route.actual_temperature).toBeNull();
  expect(sends.reduce((sum, mock) => sum + mock.mock.calls.length, 0)).toBe(completed.calls.length);
  expect(await sharedDb().execute(sql`select * from routing_config order by stage`)).toEqual(before);
});
it('retains explicit fallback identity immutably and never re-resolves shared routing on continuation', async () => {
  const e = await draft();
  vi.stubEnv('ANTHROPIC_API_KEY', '');
  vi.stubEnv('OPENAI_API_KEY', 'test-only-fake-key');
  const config = { mode: 'single_pass', stages: { gap_extraction: { route: { provider_id: 'anthropic-claude', model: 'claude-sonnet-5-5', fallbacks: ['openai'] } } } };
  const response = await POST(request({ revision: 2, target: 'gap_extraction', config, prerequisites: {} }), ctx(e.id));
  expect(response.status).toBe(202);
  const execution = (await response.json()).execution;
  const { sends } = providerScript(execution.id);
  vi.stubEnv('ANTHROPIC_API_KEY', 'primary-now-available');
  const completed = await finish(e.id, execution.id);
  expect(completed.calls[0].route.requested.provider_id).toBe('anthropic-claude');
  expect(completed.calls[0].route.actual).toMatchObject({ provider_id: 'openai', degraded: true });
  expect(sends[1]).not.toHaveBeenCalled();
  expect(sends[2]).toHaveBeenCalledOnce();
});
it('uses one actual HTTP attempt for transient failures and preserves the provider default retry policy', async () => {
  const e = await draft();
  const execution = (await (await start(e.id, 2, 'gap_extraction')).json()).execution;
  const fetch = vi.mocked(globalThis.fetch).mockImplementation(async () => new Response('{"error":{"message":"temporarily overloaded"}}', { status: 503 }));
  const sleep = vi.spyOn(RETRY, 'sleep').mockResolvedValue();
  const result = await finish(e.id, execution.id);
  expect(result.generation_status).toBe('failed');
  expect(fetch).toHaveBeenCalledOnce();
  expect(sleep).not.toHaveBeenCalled();
  expect(RETRY.attempts).toBe(4);
  await progressExecution(execution.id);
  expect(fetch).toHaveBeenCalledOnce();
  await expect(xaiGrok.complete(result.calls[0].request.request, { api_key: 'test-key-never-send' })).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(5);
  expect(sleep).toHaveBeenCalledTimes(3);
});
it('retains reported usage when provider output validation fails and keeps unpriced calls unknown', async () => {
  const e = await draft();
  const execution = (await (await start(e.id, 2, 'gap_extraction')).json()).execution;
  vi.mocked(globalThis.fetch).mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: '{"gaps":[' }, finish_reason: 'length' }], usage: { prompt_tokens: 10, completion_tokens: 4 } }), { status: 200 }));
  const failed = await finish(e.id, execution.id);
  expect(failed.calls[0].failure_accounting?.usage).toMatchObject({ input_tokens: 10, output_tokens: 4, source: 'provider' });
  xaiGrok.models.push('unpriced-experiment-test-model');
  try {
    const nextResponse = await POST(request({ revision: 2, target: 'gap_extraction', config: { mode: 'single_pass', stages: { gap_extraction: { route: { model: 'unpriced-experiment-test-model', fallbacks: [] } } } }, prerequisites: {} }), ctx(e.id));
    expect(nextResponse.status).toBe(202);
    const next = (await nextResponse.json()).execution;
    vi.spyOn(xaiGrok, 'complete').mockResolvedValue(JSON.stringify({ gaps: [gap] }));
    const completed = await finish(e.id, next.id);
    expect(completed.calls[0].receipt?.cost_usd).toBeNull();
    expect(completed.calls[0].receipt?.price_source).toBeNull();
  } finally { xaiGrok.models.splice(xaiGrok.models.indexOf('unpriced-experiment-test-model'), 1); }
});
it('recovers a pre-dispatch queued request and rejects a mismatched replay request without sending', async () => {
  const e = await draft();
  const execution = (await (await start(e.id, 2, 'gap_extraction')).json()).execution;
  const begin = vi.spyOn(executionStore, 'beginCall').mockRejectedValueOnce(new Error('Interrupted before sending marker'));
  const send = vi.spyOn(xaiGrok, 'complete').mockResolvedValue(JSON.stringify({ gaps: [gap] }));
  await progressExecution(execution.id);
  expect(send).not.toHaveBeenCalled();
  const stored = await getExecution(e.id, execution.id);
  expect(stored.calls[0].status).toBe('queued');
  begin.mockRestore();
  // Simulate process exit before dispatch: restore the pending section for a new lease.
  await sharedDb().execute(sql`update development_execution_sections set status='queued' where execution_id=${execution.id}`);
  await sharedDb().execute(sql`update development_executions set claim_until=now()-interval '1 second',generation_status='running' where id=${execution.id}`);
  const claim = await executionStore.claimExecution(execution.id);
  expect(claim).not.toBeNull();
  const call = stored.calls[0];
  await expect(executionStore.checkpointCall(claim!.execution, claim!.token, stored.sections[0], 0, 'mismatched-request-hash', call.request, call.route)).rejects.toMatchObject({ code: 'replay_mismatch' });
  await executionStore.releaseExecution(execution.id, claim!.token, 'queued');
  expect((await finish(e.id, execution.id)).generation_status).toBe('succeeded');
  expect(send).toHaveBeenCalledOnce();
});
