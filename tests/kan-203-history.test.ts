/** Owner-facing history must remove credentials without changing replay data. */
import { expect, it, vi } from 'vitest';
import { redactOwnerHistory } from '@/modules/development/execution-store';

it('redacts configured credentials and credential-shaped values recursively without mutating the stored object', () => {
  const raw = { request: { text: 'key private-secret' }, response: ['sk-abcdefghijk', 'safe'] };
  const result = redactOwnerHistory(raw, ['private-secret']);
  expect(result).toEqual({ request: { text: 'key [redacted]' }, response: ['[redacted]', 'safe'] });
  expect(raw.request.text).toBe('key private-secret');
});

it('redacts nested credential property names without losing colliding diagnostics or changing replay', () => {
  const raw = { parsed: { 'private-provider-key': 'configured', 'xai-abcdefghijk': 'second shaped', nested: [{ 'sk-abcdefghijk': 'shaped' }], '[redacted]': 'literal', '[redacted] (2)': 'literal suffix' } };
  const replay = JSON.stringify(raw);
  const safe = redactOwnerHistory(raw, ['private-provider-key']);
  expect(JSON.stringify(safe)).not.toContain('private-provider-key');
  expect(JSON.stringify(safe)).not.toContain('sk-abcdefghijk');
  expect(JSON.stringify(safe)).not.toContain('xai-abcdefghijk');
  expect(safe.parsed).toMatchObject({ '[redacted]': 'literal', '[redacted] (2)': 'literal suffix', '[redacted] (3)': 'configured', '[redacted] (4)': 'second shaped' });
  expect(safe.parsed.nested).toEqual([{ '[redacted]': 'shaped' }]);
  expect(JSON.stringify(raw)).toBe(replay);
});

it('does not let an expired worker release its claim', async () => {
  const { sql } = await import('drizzle-orm');
  const { sharedDb } = await import('@/lib/iegp/db');
  const { createExperiment } = await import('@/modules/development/store');
  const { ensureExecutionTables, releaseExecution } = await import('@/modules/development/execution-store');
  await ensureExecutionTables();
  const experiment = await createExperiment('Expired claim', null, 'owner');
  const id = `${experiment.id}-execution`;
  const now = new Date().toISOString();
  await sharedDb().execute(sql`insert into development_executions(id,experiment_id,manifest,generation_status,created_at,updated_at,claim_token,claim_until) values(${id},${experiment.id},'{}'::jsonb,'running',${now},${now},'expired',now()-interval '1 second')`);
  await expect(releaseExecution(id, 'expired', 'failed')).rejects.toMatchObject({ code: 'claim_lost' });
  const rows = await sharedDb().execute(sql`select generation_status,claim_token from development_executions where id=${id}`);
  expect(rows[0]).toMatchObject({ generation_status: 'running', claim_token: 'expired' });
});

it('paginates retained history without skipping executions with the same timestamp', async () => {
  const { sql } = await import('drizzle-orm');
  const { sharedDb } = await import('@/lib/iegp/db');
  const { createExperiment } = await import('@/modules/development/store');
  const { listOwnerExecutionPage } = await import('@/modules/development/execution-store');
  const experiment = await createExperiment('Paged history', null, 'owner');
  await sharedDb().execute(sql`insert into development_executions(id,experiment_id,manifest,generation_status,created_at,updated_at) select ${experiment.id} || '-' || lpad(n::text,3,'0'),${experiment.id},'{}'::jsonb,'succeeded','2026-01-01','2026-01-01' from generate_series(1,51) n`);
  const first = await listOwnerExecutionPage(experiment.id);
  const second = await listOwnerExecutionPage(experiment.id, first.next_cursor!);
  expect(first.executions).toHaveLength(50);
  expect(second.executions).toHaveLength(1);
  expect(new Set([...first.executions, ...second.executions].map(e => e.id)).size).toBe(51);
  expect(second.next_cursor).toBeNull();
});

it('captures reference identities separately from generation inputs', async () => {
  const { referenceIdentities } = await import('@/modules/development/execution');
  const reference = { id: 'ref', role: 'reference', section: 'gap_extraction', sha256: 'raw', parsed_sha256: 'parsed', source_document_ids: ['source'] };
  const source = { id: 'source', role: 'source' };
  expect(referenceIdentities([reference, source] as never)).toEqual([{ id: 'ref', section: 'gap_extraction', sha256: 'raw', parsed_sha256: 'parsed', source_document_ids: ['source'] }]);
});

it('rejects evaluation associations for an attempt outside the experiment', async () => {
  const { createExperiment } = await import('@/modules/development/store');
  const { createEvaluationAssociation } = await import('@/modules/development/execution-store');
  const experiment = await createExperiment('Evaluation ownership', null, 'owner');
  await expect(createEvaluationAssociation(experiment.id, { attempt_id: 'foreign', output_id: 'missing', profile_id: 'p', evaluator_identity: 'e', reference_identity: 'r', reference_ids: [] })).rejects.toMatchObject({ code: 'not_found' });
});

it('marks evaluation identity changes outdated without changing generation', async () => {
  const { evaluationFreshness } = await import('@/modules/development/execution-store');
  const identity = { attempt_id: 'a', output_id: 'o', profile_id: 'p', evaluator_identity: 'e', reference_identity: 'r', reference_ids: [] };
  expect(evaluationFreshness(identity, identity)).toBe('current');
  expect(evaluationFreshness(identity, { ...identity, reference_identity: 'new' })).toBe('outdated');
});

it('rejects a credential-bearing provider reply instead of storing a changed replay', async () => {
  const { assertSafeReceiptText } = await import('@/modules/development/worker');
  expect(() => assertSafeReceiptText('response private-key', ['private-key'])).toThrow();
  expect(() => assertSafeReceiptText('response sk-abcdefghijk', [])).toThrow();
  expect(() => assertSafeReceiptText('ordinary response', [])).not.toThrow();
});

it('marks an older attempt outdated even when it previously succeeded', async () => {
  const { sectionFreshness } = await import('@/modules/development/execution');
  const manifest = { sources: [], config: { mode: 'single_pass', stages: { gap_extraction: {} } }, modules: { gap_extraction: {} }, prompts: { gap_extraction: {} }, code_identity: 'v1' };
  const old = { id: 'old', section: 'gap_extraction', status: 'succeeded', result: { output_id: 'a' }, prerequisites: {}, manifest };
  const newer = { ...old, id: 'new', status: 'failed', result: null };
  expect(sectionFreshness(old as never, [newer, old] as never, manifest as never)).toEqual({ current: false, reasons: ['newer_attempt'] });
});

it('accepts bounded history configuration and rejects invalid controls', async () => {
  const { historyConfig } = await import('@/modules/development/execution');
  expect(historyConfig(new Request('http://localhost/history'))).toBeUndefined();
  expect(historyConfig(new Request(`http://localhost/history?config=${encodeURIComponent('{"mode":"single_pass"}')}`))?.mode).toBe('single_pass');
  expect(() => historyConfig(new Request(`http://localhost/history?config=${encodeURIComponent('{"mode":"invalid"}')}`))).toThrow();
});

it('discards a credential echoed by the provider while retaining a failed receipt', async () => {
  const { createExperiment, updateExperiment } = await import('@/modules/development/store');
  const { sha256, canonicalParsedJson } = await import('@/modules/development/documents');
  const { startExecution } = await import('@/modules/development/execution');
  const { progressExecution } = await import('@/modules/development/worker');
  const { getExecution } = await import('@/modules/development/execution-store');
  const { xaiGrok } = await import('@/modules/llm/provider');
  const llm = await import('@/modules/kernel/llm');
  const { setAiSection } = await import('@/modules/kernel/ai-switch');
  vi.stubEnv('SYNAPSE_DEVELOPMENT_DELIVERY', 'github_actions');
  vi.stubEnv('CRON_SECRET', 'isolated-test-worker-secret-long-enough');
  vi.stubEnv('XAI_API_KEY', 'private-provider-key');
  vi.spyOn(llm, 'isTestStub').mockReturnValue(false);
  vi.spyOn(xaiGrok, 'complete').mockResolvedValue('Provider echoed private-provider-key');
  try {
    await setAiSection({ section: 'gap_extraction', enabled: true, actor_name: 'test' });
    const experiment = await createExperiment('Credential echo', null, 'owner');
    const parsed = { blocks: [{ id: 'b', text: 'Evidence.', heading: 'Evidence', location: '1' }] };
    await updateExperiment(experiment.id, 1, { document: { id: `${experiment.id}-source`, experiment_id: experiment.id, role: 'source', compatibility: 'compatible', filename: 'source.txt', sha256: sha256('Evidence.'), parsed_sha256: sha256(canonicalParsedJson(parsed)), parsed_at: '2026-10-30T00:00:00Z', parser: { name: 'test', version: '1', model: null, prompt: null }, parsed } as never, content_base64: 'RXZpZGVuY2Uu' });
    const execution = await startExecution(experiment.id, { revision: 2, target: 'gap_extraction', config: (await import('@/modules/development/execution-schema')).executionConfigSchema.parse({ mode: 'single_pass' }), prerequisites: {}, cost_controls: { allowance_usd: 100, unknown_acknowledged: true } });
    await progressExecution(execution.id);
    const saved = await getExecution(experiment.id, execution.id);
    expect(saved.calls[0].status).toBe('failed');
    expect(saved.calls[0].receipt).toBeNull();
    expect(JSON.stringify(saved)).not.toContain('private-provider-key');
  } finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); }
});

it('retains independent unscored associations bound to an exact output', async () => {
  const { sql } = await import('drizzle-orm');
  const { sharedDb } = await import('@/lib/iegp/db');
  const { createExperiment } = await import('@/modules/development/store');
  const { createEvaluationAssociation, listEvaluationAssociations } = await import('@/modules/development/execution-store');
  const experiment = await createExperiment('Evaluation association', null, 'owner');
  const execution = `${experiment.id}-execution`, attempt = `${experiment.id}-attempt`, now = new Date().toISOString();
  await sharedDb().execute(sql`insert into development_executions(id,experiment_id,manifest,generation_status,created_at,updated_at) values(${execution},${experiment.id},'{}'::jsonb,'succeeded',${now},${now})`);
  await sharedDb().execute(sql`insert into development_execution_sections(id,execution_id,experiment_id,section,ordinal,status,result,created_at) values(${attempt},${execution},${experiment.id},'gap_extraction',0,'succeeded','{"output_id":"output"}'::jsonb,${now})`);
  const identity = { attempt_id: attempt, output_id: 'output', profile_id: 'profile', evaluator_identity: 'evaluator', reference_identity: 'reference', reference_ids: [] };
  const saved = await createEvaluationAssociation(experiment.id, identity);
  expect(saved).toMatchObject({ ...identity, status: 'unscored' });
  expect(await listEvaluationAssociations(experiment.id, attempt)).toHaveLength(1);
  await expect(createEvaluationAssociation(experiment.id, { ...identity, output_id: 'different' })).rejects.toMatchObject({ code: 'not_found' });
});

it('detects transitive prerequisite changes and ignores evaluator-only changes', async () => {
  const { sectionFreshness } = await import('@/modules/development/execution');
  const sections = ['gap_extraction', 'tactic_extraction', 'matching_coverage', 'partial_splitting'];
  const keyed = Object.fromEntries(sections.map(section => [section, {}]));
  const manifest = { sources: [], config: { mode: 'single_pass', stages: keyed, evaluator: { model: 'old' } }, modules: keyed, prompts: keyed, code_identity: 'v1' };
  const gap = { id: 'g', section: 'gap_extraction', status: 'succeeded', result: { output_id: 'go', prerequisite_ids: {} }, prerequisites: {}, manifest };
  const tactic = { id: 't', section: 'tactic_extraction', status: 'succeeded', result: { output_id: 'to', prerequisite_ids: {} }, prerequisites: {}, manifest };
  const matching = { id: 'm', section: 'matching_coverage', status: 'succeeded', result: { output_id: 'mo', prerequisite_ids: { gap_extraction: 'go', tactic_extraction: 'to' } }, prerequisites: { gap_extraction: 'g', tactic_extraction: 't' }, manifest };
  const split = { id: 's', section: 'partial_splitting', status: 'succeeded', result: { output_id: 'so', prerequisite_ids: { matching_coverage: 'mo' } }, prerequisites: { matching_coverage: 'm' }, manifest };
  const history = [split, matching, tactic, gap];
  const evaluatorChanged = { ...manifest, config: { ...manifest.config, evaluator: { model: 'new' } } };
  expect(sectionFreshness(split as never, history as never, evaluatorChanged as never)).toEqual({ current: true, reasons: [] });
  const newerGap = { ...gap, id: 'new', status: 'failed', result: null };
  expect(sectionFreshness(split as never, [newerGap, ...history] as never, manifest as never).reasons).toContain('prerequisite_changed');
});

it('preserves timestamps in safe owner history', () => {
  expect(redactOwnerHistory({ at: new Date('2026-01-01T00:00:00Z') }, [])).toEqual({ at: '2026-01-01T00:00:00.000Z' });
});

it('compares only the references selected for an evaluation', async () => {
  const { evaluationBindings } = await import('@/modules/development/execution');
  const { executionConfigSchema } = await import('@/modules/development/execution-schema');
  const config = executionConfigSchema.parse({});
  const a = { id: 'a', role: 'reference', section: 'gap_extraction', sha256: '1', parsed_sha256: '2', source_document_ids: [] };
  const b = { ...a, id: 'b' };
  expect(evaluationBindings(config, [a, b] as never, ['a'])).toEqual(evaluationBindings(config, [a, { ...b, sha256: 'changed' }] as never, ['a']));
  expect(evaluationBindings(config, [a] as never, ['a'])).not.toEqual(evaluationBindings(config, [] as never, ['a']));
});

it('advances association lifecycle with expected-state ownership and rejects invalid transitions', async () => {
  const { sql } = await import('drizzle-orm');
  const { sharedDb } = await import('@/lib/iegp/db');
  const { createExperiment } = await import('@/modules/development/store');
  const { createEvaluationAssociation, transitionEvaluationAssociation } = await import('@/modules/development/execution-store');
  const experiment = await createExperiment('Evaluation lifecycle', null, 'owner');
  const execution = `${experiment.id}-execution`, attempt = `${experiment.id}-attempt`, now = new Date().toISOString();
  await sharedDb().execute(sql`insert into development_executions(id,experiment_id,manifest,generation_status,created_at,updated_at) values(${execution},${experiment.id},'{}'::jsonb,'succeeded',${now},${now})`);
  await sharedDb().execute(sql`insert into development_execution_sections(id,execution_id,experiment_id,section,ordinal,status,result,created_at) values(${attempt},${execution},${experiment.id},'gap_extraction',0,'succeeded','{"output_id":"output"}'::jsonb,${now})`);
  const saved = await createEvaluationAssociation(experiment.id, { attempt_id: attempt, output_id: 'output', profile_id: 'p', evaluator_identity: 'e', reference_identity: 'r', reference_ids: [] });
  await expect(transitionEvaluationAssociation(experiment.id, saved.id, 'unscored', 'queued')).resolves.toMatchObject({ status: 'queued' });
  await expect(transitionEvaluationAssociation(experiment.id, saved.id, 'unscored', 'queued')).rejects.toMatchObject({ code: 'evaluation_conflict' });
  await expect(transitionEvaluationAssociation(experiment.id, saved.id, 'queued', 'succeeded')).rejects.toMatchObject({ code: 'invalid_transition' });
  await expect(transitionEvaluationAssociation('foreign', saved.id, 'queued', 'running')).rejects.toMatchObject({ code: 'evaluation_conflict' });
});

it('prevents a replaced worker from publishing or settling after takeover', async () => {
  const { sql } = await import('drizzle-orm');
  const { sharedDb } = await import('@/lib/iegp/db');
  const { createExperiment } = await import('@/modules/development/store');
  const store = await import('@/modules/development/execution-store');
  const experiment = await createExperiment('Worker takeover', null, 'owner');
  const execution = `${experiment.id}-execution`, attempt = `${experiment.id}-attempt`, call = `${experiment.id}-call`, now = new Date().toISOString();
  await sharedDb().execute(sql`insert into development_executions(id,experiment_id,manifest,generation_status,created_at,updated_at,claim_token,claim_until) values(${execution},${experiment.id},'{}'::jsonb,'running',${now},${now},'old',now()-interval '1 second')`);
  await sharedDb().execute(sql`insert into development_execution_sections(id,execution_id,experiment_id,section,ordinal,status,created_at) values(${attempt},${execution},${experiment.id},'gap_extraction',0,'running',${now})`);
  await sharedDb().execute(sql`insert into development_execution_calls(id,execution_id,section_id,ordinal,identity,request,route,status) values(${call},${execution},${attempt},0,'id','{}'::jsonb,'{}'::jsonb,'sending')`);
  const current = await store.claimExecution(execution);
  expect(current).not.toBeNull();
  await expect(store.publishSection(execution, 'old', attempt, 'failed', null, null, {})).rejects.toMatchObject({ code: 'claim_lost' });
  await expect(store.settleCall(execution, 'old', call, { text: 'old', usage: null, cost_usd: null, price_source: null, llm_call_id: null })).rejects.toMatchObject({ code: 'receipt_unsettled' });
  await store.releaseExecution(execution, current!.token, 'needs_attention', 'Uncertain send');
  const saved = await store.getExecution(experiment.id, execution);
  expect(saved.sections[0].status).toBe('running');
  expect(saved.calls[0].status).toBe('needs_attention');
  expect(saved.calls[0].receipt).toBeNull();
});

it('exposes authenticated freshness, selected references, receipts and timestamps in list and detail', async () => {
  const { sql } = await import('drizzle-orm');
  const { NextResponse } = await import('next/server');
  const { sharedDb } = await import('@/lib/iegp/db');
  const { createExperiment, updateExperiment, getExperiment } = await import('@/modules/development/store');
  const { sha256, canonicalParsedJson } = await import('@/modules/development/documents');
  const executionModule = await import('@/modules/development/execution');
  const store = await import('@/modules/development/execution-store');
  const { executionConfigSchema } = await import('@/modules/development/execution-schema');
  const { setAiSection } = await import('@/modules/kernel/ai-switch');
  const { GET: list } = await import('@/app/api/admin/development/[id]/executions/route');
  const { GET: detail } = await import('@/app/api/admin/development/[id]/executions/[executionId]/route');
  const owner = await import('@/modules/auth/owner');
  vi.stubEnv('SYNAPSE_DEVELOPMENT_DELIVERY', 'github_actions');
  vi.stubEnv('CRON_SECRET', 'isolated-test-worker-secret-long-enough');
  vi.stubEnv('XAI_API_KEY', 'private-provider-key');
  try {
    await setAiSection({ section: 'gap_extraction', enabled: true, actor_name: 'test' });
    const e = await createExperiment('History API', null, 'owner');
    const parsed = { blocks: [{ id: 'b', text: 'Evidence.', heading: 'Evidence', location: '1' }] };
    const source = { id: `${e.id}-source`, experiment_id: e.id, role: 'source', compatibility: 'compatible', filename: 's', sha256: sha256('Evidence.'), parsed_sha256: sha256(canonicalParsedJson(parsed)), parsed_at: '2026-10-30T00:00:00Z', parser: { name: 'test', version: '1', model: null, prompt: null }, parsed, source_document_ids: [] };
    await updateExperiment(e.id, 1, { document: source as never, content_base64: 'RXZpZGVuY2Uu' });
    const ref = { ...source, id: `${e.id}-ref`, role: 'reference', section: 'gap_extraction', source_document_ids: [source.id] };
    await updateExperiment(e.id, 2, { document: ref as never, content_base64: 'RXZpZGVuY2Uu' });
    const config = executionConfigSchema.parse({ mode: 'single_pass' });
    const run = await executionModule.startExecution(e.id, { revision: 3, target: 'gap_extraction', config, prerequisites: {}, cost_controls: { allowance_usd: 100, unknown_acknowledged: true } });
    const section = run.sections[0], output = 'a'.repeat(64);
    await sharedDb().execute(sql`update development_execution_sections set status='succeeded',result=${JSON.stringify({ output_id: output, prerequisite_ids: {}, trace_id: 'trace-1', output: { 'private-provider-key': { 'sk-abcdefghijk': 'legacy diagnostic' } } })}::jsonb,started_at=now(),finished_at=now() where id=${section.id}`);
    await sharedDb().execute(sql`update development_executions set generation_status='succeeded' where id=${run.id}`);
    await sharedDb().execute(sql`insert into development_execution_calls(id,execution_id,section_id,ordinal,identity,request,route,status,receipt,sending_at,settled_at) values(${`${e.id}-call`},${run.id},${section.id},0,'identity','{}'::jsonb,'{}'::jsonb,'succeeded',${JSON.stringify({ text: 'safe reply', usage: { input_tokens: 1 }, cost_usd: 0.01, price_source: 'test', llm_call_id: 'trace-call' })}::jsonb,now(),now())`);
    const docs = (await getExperiment(e.id)).documents;
    const association = await store.createEvaluationAssociation(e.id, { attempt_id: section.id, output_id: output, profile_id: 'profile', reference_ids: [ref.id], ...executionModule.evaluationBindings(config, docs, [ref.id]) });
    const context = { params: Promise.resolve({ id: e.id, executionId: run.id }) };
    const get = async (query = '') => (await detail(new Request(`http://localhost/history${query}`), context)).json();
    const first = await get();
    expect(JSON.stringify(first)).not.toContain('private-provider-key');
    expect(JSON.stringify(first)).not.toContain('sk-abcdefghijk');
    expect((await store.getExecution(e.id, run.id)).sections[0].result?.output).toEqual({ 'private-provider-key': { 'sk-abcdefghijk': 'legacy diagnostic' } });
    expect(first.history[section.id].freshness.current).toBe(true);
    expect(first.history[section.id].evaluations[0]).toMatchObject({ id: association.id, freshness: 'current' });
    expect(first.execution.sections[0].started_at).toEqual(expect.any(String));
    expect(first.execution.sections[0].finished_at).toEqual(expect.any(String));
    expect(first.execution.calls[0]).toMatchObject({ receipt: { text: 'safe reply', cost_usd: 0.01, llm_call_id: 'trace-call' }, sending_at: expect.any(String), settled_at: expect.any(String) });
    const changedMode = await get(`?config=${encodeURIComponent(JSON.stringify({ mode: 'standard' }))}`);
    expect(changedMode.history[section.id].freshness.reasons).toContain('generation_inputs_changed');
    const changedEvaluator = structuredClone(config); changedEvaluator.evaluator.temperature = 0.7;
    const evaluation = await get(`?config=${encodeURIComponent(JSON.stringify(changedEvaluator))}`);
    expect(evaluation.history[section.id].freshness.current).toBe(true);
    expect(evaluation.history[section.id].evaluations[0].reasons).toContain('evaluator_changed');
    const other = { ...ref, id: `${e.id}-other` };
    await updateExperiment(e.id, 3, { document: other as never, content_base64: 'RXZpZGVuY2Uu' });
    expect((await get()).history[section.id].evaluations[0].freshness).toBe('current');
    await sharedDb().execute(sql`update development_documents set record=jsonb_set(record,'{sha256}','"changed"'::jsonb) where id=${ref.id}`);
    expect((await get()).history[section.id].evaluations[0].reasons).toContain('references_changed');
    await sharedDb().execute(sql`update development_documents set record=jsonb_set(record,'{sha256}','"changed"'::jsonb) where id=${source.id}`);
    expect((await get()).history[section.id].freshness.reasons).toContain('generation_inputs_changed');
    expect((await list(new Request('http://localhost/history?cursor=foreign'), { params: Promise.resolve({ id: e.id }) })).status).toBe(400);
    const listed = await list(new Request('http://localhost/history'), { params: Promise.resolve({ id: e.id }) });
    const listedBody = await listed.json();
    expect(listedBody.history[section.id]).toBeDefined();
    expect(JSON.stringify(listedBody)).not.toContain('private-provider-key');
    expect(JSON.stringify(listedBody)).not.toContain('sk-abcdefghijk');
    // The evaluation remains bound to the original output, but newer attempts make it outdated.
    for (const status of ['succeeded', 'failed'] as const) {
      const newerExecution = `${e.id}-${status}-execution`, newerAttempt = `${e.id}-${status}-attempt`;
      await sharedDb().execute(sql`insert into development_executions(id,experiment_id,manifest,generation_status,created_at,updated_at) values(${newerExecution},${e.id},${JSON.stringify(run.manifest)}::jsonb,${status},now()::text,now()::text)`);
      const result = status === 'succeeded' ? JSON.stringify({ output_id: 'new-output', prerequisite_ids: {} }) : null;
      await sharedDb().execute(sql`insert into development_execution_sections(id,execution_id,experiment_id,section,ordinal,status,result,created_at) values(${newerAttempt},${newerExecution},${e.id},'gap_extraction',0,${status},${result}::jsonb,now()::text)`);
      const response = await get();
      expect(response.history[section.id].evaluations[0]).toMatchObject({ id: association.id, attempt_id: section.id, output_id: output, freshness: 'outdated' });
      expect(response.history[section.id].evaluations[0].reasons).toContain('attempt_changed');
    }
    vi.spyOn(owner, 'ownerGate').mockResolvedValue(NextResponse.json({ code: 'owner_only' }, { status: 403 }));
    expect((await detail(new Request('http://localhost/history'), context)).status).toBe(403);
    expect((await list(new Request('http://localhost/history'), { params: Promise.resolve({ id: e.id }) })).status).toBe(403);
  } finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); }
});
