/** Arrange immutable generated fixtures, act through owner routes/workers, assert independent evaluations. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { sharedDb } from '@/lib/iegp/db';
import { createExperiment, updateExperiment } from '@/modules/development/store';
import { startExecution } from '@/modules/development/execution';
import { getExecution } from '@/modules/development/execution-store';
import { developmentOutputIdentity, executeDevelopmentSection } from '@/modules/development/stage-execution';
import { canonicalParsedJson, sha256 } from '@/modules/development/documents';
import { balancedProfile, effectiveCriteria } from '@/modules/development/profile-schema';
import { POST, GET } from '@/app/api/admin/development/[id]/evaluations/route';
import { GET as detail } from '@/app/api/admin/development/[id]/evaluations/[evaluationId]/route';
import { GET as executionDetail } from '@/app/api/admin/development/[id]/executions/[executionId]/route';
import { POST as save, GET as profiles } from '@/app/api/admin/development/[id]/profiles/route';
import { progressEvaluation } from '@/modules/development/evaluation-worker';
import { getEvaluation } from '@/modules/development/evaluation-store';
import { xaiGrok } from '@/modules/llm/provider';
import * as owner from '@/modules/auth/owner';
import * as evaluatorStore from '@/modules/development/evaluation-store';
import * as evaluatorRoutes from '@/modules/development/routes';
import { evaluatorReplySchema } from '@/modules/development/evaluation-schema';
import { setAiEnabled, setAiSection } from '@/modules/kernel/ai-switch';
import * as llm from '@/modules/kernel/llm';
import type { DevelopmentDocument, DevelopmentSection } from '@/modules/development/schema';
const quote = 'Comparative effectiveness remains unknown. An ongoing observational study measures outcomes.';
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (body: unknown) => new Request('http://localhost', { method: 'POST', body: JSON.stringify(body) });
async function fixture(section: DevelopmentSection = 'gap_extraction', empty = false) {
  const e = await createExperiment('Evaluation fixture', null, 'owner');
  const parsed = { blocks: [{ id: 'b1', text: quote, heading: 'Evidence', location: '1' }] };
  const source = { id: `${e.id}-source`, experiment_id: e.id, role: 'source', compatibility: 'compatible', filename: 'source.txt', sha256: sha256(quote), parsed_sha256: sha256(canonicalParsedJson(parsed)), parsed_at: '2026-10-30T00:00:00Z', parser: { name: 'test', version: '1', model: null, prompt: null }, parsed } as DevelopmentDocument;
  await updateExperiment(e.id, 1, { document: source, content_base64: Buffer.from(quote).toString('base64') });
  const execution = await startExecution(e.id, { revision: 2, target: 'all', config: { mode: 'single_pass' } as never, prerequisites: {}, cost_controls: { allowance_usd: 100, unknown_acknowledged: true } });
  const results: Partial<Record<DevelopmentSection, Awaited<ReturnType<typeof executeDevelopmentSection>>>> = {};
  for (const attempt of execution.sections) {
    const result = await executeDevelopmentSection({ section: attempt.section, sources: [source], prerequisites: attempt.section === 'matching_coverage' ? { gap_extraction: results.gap_extraction, tactic_extraction: results.tactic_extraction } : attempt.section === 'partial_splitting' ? { matching_coverage: results.matching_coverage } : {}, mode: 'single_pass', recorder: { id: attempt.id, step: async (_name, fn) => fn(), note: () => {}, steps: () => [] }, complete: async request => {
      const body = request.user.startsWith('{') ? JSON.parse(request.user) : {};
      if (attempt.section === 'gap_extraction') return { gaps: empty ? [] : [{ name: 'Comparative outcomes', statement: 'Comparative effectiveness remains unknown.', domain: 'comparative_effectiveness', source_quote: quote }] };
      if (attempt.section === 'tactic_extraction') return { tactics: [{ name: 'Outcomes study', type: 'rwe_study', status: 'ongoing', evidence_question: 'What are outcomes?', source_quote: quote }] };
      if (attempt.section === 'matching_coverage') return { rows: body.gaps.map((g: { id: string }) => ({ gap_id: g.id, mapping_status: 'partially_addressed', confidence: 80, rationale: 'Only the observational scope is covered.', mappings: [{ tactic_id: body.tactics[0].id, coverage: 'partial', confidence: 80, rationale: 'Comparator absent.', dimensions: { relevance: 'yes', population: 'partial', geography: 'unknown', timing: 'yes', intervention: 'yes', comparator: 'no', outcomes: 'partial', setting: 'unknown', methodology: 'partial', decision_utility: 'no' }, references: [{ entity_type: 'source', entity_id: source.id, reason: 'Source evidence.' }] }] })) };
      return { addressed_name: 'Observed outcomes', addressed_statement: 'Patient outcomes are measured in the observational population.', addressed_tactic_ids: [body.mapped_tactics[0].id], open_name: 'Comparative outcomes', open_statement: 'Comparative outcomes against standard care remain unknown.', uncovered_dimensions: ['population'], confidence: 78, rationale: 'No comparator is supplied.' };
    } });
    results[attempt.section] = result;
    await sharedDb().execute(sql`update development_execution_sections set status=${result.generation_status},result=${JSON.stringify(result)}::jsonb where id=${attempt.id}`);
  }
  await sharedDb().execute(sql`update development_executions set generation_status='succeeded' where id=${execution.id}`);
  const attempt = execution.sections.find(a => a.section === section)!;
  const input = { execution_id: execution.id, attempt_id: attempt.id, output_id: results[section]!.output_id, section };
  return { e, source, execution: await getExecution(e.id, execution.id), input, result: results[section]! };
}
function reply(section: DevelopmentSection, additions = {}) {
  return { criteria: effectiveCriteria(balancedProfile, section).map(c => ({ criterion_id: c.id, score: 3, reason: 'Supported by the frozen source.' })), matches: [], unmatched_output_ids: [], unmatched_reference_ids: [], ...additions };
}
const create = async (f: Awaited<ReturnType<typeof fixture>>, additions = {}) => POST(req({ ...f.input, cost_controls: { allowance_usd: 100, unknown_acknowledged: true }, ...additions }), ctx(f.e.id));
beforeEach(async () => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Paid or unscripted network forbidden.'));
  vi.spyOn(llm, 'isTestStub').mockReturnValue(false);
  vi.stubEnv('SYNAPSE_DEVELOPMENT_DELIVERY', 'github_actions'); vi.stubEnv('CRON_SECRET', 'isolated-test-worker-secret-long-enough'); vi.stubEnv('XAI_API_KEY', 'test-key-never-send');
  await setAiEnabled({ enabled: true, actor_name: 'test' });
  for (const section of ['gap_extraction', 'tactic_extraction', 'mapping', 'partial_split'] as const) await setAiSection({ section, enabled: true, actor_name: 'test' });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
it.each(['gap_extraction', 'tactic_extraction', 'matching_coverage', 'partial_splitting'] as const)('evaluates persisted %s without generation and preserves exact historical manifest', async section => {
  const f = await fixture(section);
  const response = await create(f); expect(response.status).toBe(202);
  const evaluation = (await response.json()).evaluation;
  const sends = vi.spyOn(xaiGrok, 'complete').mockImplementation(async (_request, _auth, hooks) => {
    const rows = await sharedDb().execute(sql`select status from development_evaluations where id=${evaluation.id}`);
    expect(rows[0].status).toBe('sending'); expect(hooks?.maxAttempts).toBe(1);
    return JSON.stringify(reply(section));
  });
  await Promise.all([progressEvaluation(evaluation.id), progressEvaluation(evaluation.id)]);
  expect(sends).toHaveBeenCalledOnce();
  await progressEvaluation(evaluation.id);
  const saved = await getEvaluation(f.e.id, evaluation.id);
  expect(saved.status).toBe('succeeded'); expect(saved.result?.rubric?.score).toBe(3);
  expect(saved.result?.rubric?.label).toBe('provisional_ai_assessment');
  expect(saved.result?.checks.passed).toBe(true); expect(saved.receipt?.llm_call_id).toBeTruthy();
  expect((await getExecution(f.e.id, f.execution.id)).manifest).toEqual(f.execution.manifest);
  expect((await getExecution(f.e.id, f.execution.id)).sections).toEqual(f.execution.sections);
  expect(saved.manifest.output.output_id).toBe(f.input.output_id); expect(saved.manifest.profile.id).toBe('balanced');
  await expect(sharedDb().execute(sql`update development_evaluations set manifest='{}'::jsonb where id=${evaluation.id}`)).rejects.toThrow();
  await expect(sharedDb().execute(sql`update development_evaluations set result='{}'::jsonb where id=${evaluation.id}`)).rejects.toThrow();
  expect((await GET(req({}), ctx(f.e.id))).status).toBe(200);
});
it('requires authorization before decoding and rejects foreign immutable IDs before dispatch', async () => {
  const f = await fixture();
  expect((await create(f, { attempt_id: 'foreign' })).status).toBe(404);
  expect((await create(f, { output_id: 'a'.repeat(64) })).status).toBe(409);
  expect((await create(f, { reference_ids: ['foreign'] })).status).toBe(404);
  expect((await create(f, { profile_id: 'foreign' })).status).toBe(404);
  expect((await create(f, { config: { sections: { gap_extraction: { method: 'bad' } } } })).status).toBe(400);
  vi.spyOn(owner, 'ownerGate').mockResolvedValue(NextResponse.json({}, { status: 403 }));
  const invalid = new Request('http://localhost', { method: 'POST', body: 'invalid-json' });
  expect((await POST(invalid, ctx(f.e.id))).status).toBe(403); expect((await profiles(invalid, ctx(f.e.id))).status).toBe(403); expect((await save(invalid, ctx(f.e.id))).status).toBe(403);
});
it.each(['malformed', 'out-of-range', 'duplicate', 'omitted'] as const)('fails %s evaluator replies explicitly and retains the provider receipt', async kind => {
  const f = await fixture(); const evaluation = (await (await create(f)).json()).evaluation;
  const response = reply('gap_extraction');
  if (kind === 'out-of-range') response.criteria[0].score = 5;
  if (kind === 'duplicate') response.criteria.push(response.criteria[0]);
  if (kind === 'omitted') response.criteria.pop();
  vi.spyOn(xaiGrok, 'complete').mockResolvedValue(kind === 'malformed' ? 'not-json' : JSON.stringify(response));
  await progressEvaluation(evaluation.id); await progressEvaluation(evaluation.id);
  const failed = await getEvaluation(f.e.id, evaluation.id);
  expect(failed.status).toBe('failed'); expect(failed.error).toBeTruthy(); expect(failed.receipt?.text).toBeTruthy();
  expect((await getExecution(f.e.id, f.execution.id)).generation_status).toBe('succeeded');
});
it('retains empty denominators and absent/incompatible references as unscored without a send', async () => {
  const f = await fixture('gap_extraction', true);
  const send = vi.spyOn(xaiGrok, 'complete');
  const evaluation = (await (await create(f, { config: { sections: { gap_extraction: { method: 'reference' } } } })).json()).evaluation;
  await progressEvaluation(evaluation.id);
  const saved = await getEvaluation(f.e.id, evaluation.id);
  expect(saved.result?.reference.status).toBe('unscored'); expect(saved.result?.reference.precision.value).toBeNull(); expect(saved.result?.reference.recall.value).toBeNull(); expect(send).not.toHaveBeenCalled();
});
it('never resends an interrupted send or a failed receipt settlement', async () => {
  const f = await fixture(); const evaluation = (await (await create(f)).json()).evaluation;
  const send = vi.spyOn(xaiGrok, 'complete').mockResolvedValue(JSON.stringify(reply('gap_extraction')));
  vi.spyOn(evaluatorStore, 'settleEvaluationReceipt').mockRejectedValueOnce(new Error('Receipt storage unavailable'));
  await progressEvaluation(evaluation.id);
  expect((await getEvaluation(f.e.id, evaluation.id)).status).toBe('needs_attention');
  await progressEvaluation(evaluation.id); expect(send).toHaveBeenCalledOnce();
});
it('fails closed on unavailable delivery, missing credentials and AI off before creation or dispatch', async () => {
  const f = await fixture();
  vi.stubEnv('SYNAPSE_DEVELOPMENT_DELIVERY', ''); expect((await create(f)).status).toBe(503);
  vi.stubEnv('SYNAPSE_DEVELOPMENT_DELIVERY', 'github_actions');
  const evaluation = (await (await create(f)).json()).evaluation;
  await setAiEnabled({ enabled: false, actor_name: 'test' });
  const send = vi.spyOn(xaiGrok, 'complete');
  expect((await create(f)).status).toBe(409);
  await progressEvaluation(evaluation.id); expect((await getEvaluation(f.e.id, evaluation.id)).status).toBe('failed'); expect(send).not.toHaveBeenCalled();
});
async function reference(f: Awaited<ReturnType<typeof fixture>>, compatible = true, pdf = false, count = 1, index = 0) {
  const section = f.input.section;
  const common = { id: 'expected-1', source_document_id: f.source.id };
  const answer = section === 'gap_extraction' ? { ...common, statement: 'GOLD_REFERENCE_SECRET comparison gap', quote } : section === 'tactic_extraction' ? { ...common, title: 'Outcomes study', description: 'GOLD_REFERENCE_SECRET ongoing observational study', quote } : section === 'matching_coverage' ? { ...common, gap_id: 'gold-gap', tactic_id: 'gold-tactic', relevance: 'relevant', coverage: 'partial', rationale: 'GOLD_REFERENCE_SECRET missing comparator' } : { ...common, parent_gap_id: 'gold-parent', addressed_statement: 'GOLD_REFERENCE_SECRET observational outcomes', residual_statement: 'Comparison remains unknown.', tactic_ids: ['gold-tactic'] };
  const expected = { version: 1, section, source_document_ids: [f.source.id], expected_answers: Array.from({ length: count }, (_, i) => ({ ...answer, id: `expected-${i + 1}` })) };
  const parsed = pdf ? { document: { blocks: [] }, expected_answers: expected } : expected;
  const document = { ...f.source, id: `${f.e.id}-reference-${index}`, role: 'reference', section, source_document_ids: [f.source.id], compatibility: compatible ? 'compatible' : 'incompatible', parsed, parsed_sha256: sha256(canonicalParsedJson(parsed)), sha256: sha256('original expected answer bytes'), review_status: pdf ? 'provisional' : 'unreviewed' } as DevelopmentDocument;
  await updateExperiment(f.e.id, 2 + index, { document, content_base64: Buffer.from('original expected answer bytes').toString('base64') });
  return document;
}
it.each(['gap_extraction', 'tactic_extraction', 'matching_coverage', 'partial_splitting'] as const)('records explicit one-to-one %s reference judgments with denominators and original review provenance', async section => {
  const f = await fixture(section), document = await reference(f, true, section === 'tactic_extraction');
  const response = await create(f, { reference_ids: [document.id], config: { sections: { [section]: { method: 'rubric_and_reference' } } } });
  expect(response.status).toBe(202); const evaluation = (await response.json()).evaluation;
  vi.spyOn(xaiGrok, 'complete').mockImplementation(async request => {
    expect(request.user).toContain('GOLD_REFERENCE_SECRET');
    const user = JSON.parse(request.user);
    return JSON.stringify(reply(section, { matches: [{ output_id: user.output_items[0].id, reference_id: user.reference_items[0].id, reason: 'Same question and supplied scope despite different record names.' }] }));
  });
  await progressEvaluation(evaluation.id); await progressEvaluation(evaluation.id);
  const saved = await getEvaluation(f.e.id, evaluation.id);
  expect(saved.status).toBe('succeeded'); expect(saved.result?.reference.precision).toEqual({ numerator: 1, denominator: 1, value: 1 }); expect(saved.result?.reference.recall).toEqual({ numerator: 1, denominator: 1, value: 1 });
  expect(saved.result?.reference.label).toBe('provisional_semantic_reference'); expect(saved.manifest.references[0].review_status).toBe(document.review_status);
  expect(saved.manifest.references[0].sha256).toBe(document.sha256); expect(saved.manifest.references[0].parsed_sha256).toBe(document.parsed_sha256);
  expect(saved.manifest.generation.sources.every((s: DevelopmentDocument) => s.role === 'source')).toBe(true);
  expect((await getExecution(f.e.id, f.execution.id)).manifest).toEqual(f.execution.manifest);
  expect((await getExecution(f.e.id, f.execution.id)).sections).toEqual(f.execution.sections);
});
it.each(['unknown', 'duplicate', 'omitted'] as const)('refuses %s semantic identities without rewriting generation', async kind => {
  const f = await fixture(), document = await reference(f);
  const evaluation = (await (await create(f, { reference_ids: [document.id], config: { sections: { gap_extraction: { method: 'reference' } } } })).json()).evaluation;
  const match = { output_id: 'candidate:0', reference_id: `${document.id}:expected-1`, reason: 'Matching semantics.' };
  const matches = kind === 'unknown' ? [{ ...match, reference_id: 'unknown' }] : kind === 'duplicate' ? [match, match] : [];
  vi.spyOn(xaiGrok, 'complete').mockResolvedValue(JSON.stringify(reply('gap_extraction', { criteria: [], matches })));
  await progressEvaluation(evaluation.id); await progressEvaluation(evaluation.id);
  expect((await getEvaluation(f.e.id, evaluation.id)).status).toBe('failed'); expect((await getExecution(f.e.id, f.execution.id)).manifest).toEqual(f.execution.manifest);
  expect((await getExecution(f.e.id, f.execution.id)).sections).toEqual(f.execution.sections);
});
it('keeps incompatible references unscored and freezes the complete custom profile before later edits', async () => {
  const f = await fixture(), document = await reference(f, false);
  const customInput = { name: 'Custom', defaults: balancedProfile.defaults, sections: balancedProfile.sections };
  const customResponse = await save(req(customInput), ctx(f.e.id)); expect(customResponse.status).toBe(201);
  const custom = (await customResponse.json()).profile;
  const evaluation = (await (await create(f, { profile_id: custom.id, profile_version: 1, reference_ids: [document.id], config: { sections: { gap_extraction: { method: 'rubric_and_reference' } } } })).json()).evaluation;
  expect((await save(req({ ...customInput, name: 'Changed later', profile_id: custom.id, base_version: 1 }), ctx(f.e.id))).status).toBe(201);
  vi.spyOn(xaiGrok, 'complete').mockResolvedValue(JSON.stringify(reply('gap_extraction')));
  await progressEvaluation(evaluation.id); await progressEvaluation(evaluation.id);
  const saved = await getEvaluation(f.e.id, evaluation.id);
  expect(saved.manifest.profile.name).toBe('Custom'); expect(saved.manifest.profile.version).toBe(1);
  expect(saved.result?.reference.status).toBe('unscored'); expect(saved.result?.reference.reasons.join(' ')).toContain('incompatible'); expect(saved.result?.reference.recall.value).toBeNull();
});
it('leaves precision unscored with empty output and reports zero recall over a nonempty reference denominator', async () => {
  const f = await fixture('gap_extraction', true), document = await reference(f);
  const evaluation = (await (await create(f, { reference_ids: [document.id], config: { sections: { gap_extraction: { method: 'reference' } } } })).json()).evaluation;
  const send = vi.spyOn(xaiGrok, 'complete'); await progressEvaluation(evaluation.id);
  const saved = await getEvaluation(f.e.id, evaluation.id);
  expect(saved.result?.reference.precision).toEqual({ numerator: 0, denominator: 0, value: null }); expect(saved.result?.reference.recall).toEqual({ numerator: 0, denominator: 1, value: 0 }); expect(send).not.toHaveBeenCalled();
});
it('recovers an expired sending marker as needs_attention without automatically retrying', async () => {
  const f = await fixture(), evaluation = (await (await create(f)).json()).evaluation;
  await sharedDb().execute(sql`update development_evaluations set status='sending',claim_token='interrupted',claim_until=now()-interval '1 second' where id=${evaluation.id}`);
  const send = vi.spyOn(xaiGrok, 'complete'); await progressEvaluation(evaluation.id); await progressEvaluation(evaluation.id);
  expect((await getEvaluation(f.e.id, evaluation.id)).status).toBe('needs_attention'); expect(send).not.toHaveBeenCalled();
});
it('fails before dispatch if frozen credentials disappear and persists no credential in the manifest', async () => {
  const f = await fixture(), evaluation = (await (await create(f)).json()).evaluation;
  expect(JSON.stringify(evaluation.manifest)).not.toContain('test-key-never-send');
  vi.stubEnv('XAI_API_KEY', ''); const send = vi.spyOn(xaiGrok, 'complete'); await progressEvaluation(evaluation.id);
  expect((await getEvaluation(f.e.id, evaluation.id)).status).toBe('failed'); expect(send).not.toHaveBeenCalled();
});
it.each(['checks_only', 'reference'] as const)('rejects %s jobs without durable delivery instead of leaving queued work', async method => {
  const f = await fixture('gap_extraction', true);
  vi.stubEnv('SYNAPSE_DEVELOPMENT_DELIVERY', '');
  const send = vi.spyOn(xaiGrok, 'complete');
  const response = await create(f, { config: { sections: { gap_extraction: { method } } } });
  expect(response.status).toBe(503);
  expect((await response.json()).code).toBe('delivery_unavailable');
  expect(await evaluatorStore.listEvaluations(f.e.id)).toEqual([]);
  expect(send).not.toHaveBeenCalled();
});
it('rejects aggregate reference identities beyond 2000 before route resolution or reservation', async () => {
  const f = await fixture();
  const first = await reference(f, true, false, 1001), second = await reference(f, true, false, 1000, 1);
  const route = vi.spyOn(evaluatorRoutes, 'freezeRoute'), reserve = vi.spyOn(evaluatorStore, 'reserveEvaluation'), send = vi.spyOn(xaiGrok, 'complete');
  const response = await create(f, { reference_ids: [first.id, second.id], config: { sections: { gap_extraction: { method: 'reference' } } } });
  expect(response.status).toBe(422); expect((await response.json()).code).toBe('evaluation_too_large');
  expect(route).not.toHaveBeenCalled(); expect(reserve).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  expect(await evaluatorStore.listEvaluations(f.e.id)).toEqual([]);
});
it('accepts and scores the aggregate 2000-reference boundary with exact unmatched denominators', async () => {
  const f = await fixture();
  const first = await reference(f, true, false, 1000), second = await reference(f, true, false, 1000, 1);
  const response = await create(f, { reference_ids: [first.id, second.id], config: { sections: { gap_extraction: { method: 'reference' } } } });
  expect(response.status).toBe(202); const evaluation = (await response.json()).evaluation;
  vi.spyOn(xaiGrok, 'complete').mockImplementation(async request => {
    const user = JSON.parse(request.user);
    const raw = { criteria: [], matches: [], unmatched_output_ids: user.output_items.map((item: { id: string }) => item.id), unmatched_reference_ids: user.reference_items.map((item: { id: string }) => item.id) };
    expect(raw.unmatched_reference_ids).toHaveLength(2000); expect(evaluatorReplySchema.safeParse(raw).success).toBe(true);
    return JSON.stringify(raw);
  });
  await progressEvaluation(evaluation.id); await progressEvaluation(evaluation.id);
  const saved = await getEvaluation(f.e.id, evaluation.id);
  expect(saved.status).toBe('succeeded'); expect(saved.result?.reference.precision).toEqual({ numerator: 0, denominator: 1, value: 0 }); expect(saved.result?.reference.recall).toEqual({ numerator: 0, denominator: 2000, value: 0 });
});
it.each([2000, 2001])('bounds expanded mapping identities at admission for %s items', async count => {
  const f = await fixture('matching_coverage');
  // Build a persisted large output fixture; admission concerns its immutable identity and expanded size.
  const result = structuredClone(f.result), candidate = result.candidates[0];
  candidate.mappings = Array.from({ length: count }, () => structuredClone((candidate.mappings as unknown[])[0]));
  result.output_id = developmentOutputIdentity(result);
  await sharedDb().execute(sql`update development_execution_sections set result=${JSON.stringify(result)}::jsonb where id=${f.input.attempt_id}`);
  f.input.output_id = result.output_id;
  const route = vi.spyOn(evaluatorRoutes, 'freezeRoute'), reserve = vi.spyOn(evaluatorStore, 'reserveEvaluation'), send = vi.spyOn(xaiGrok, 'complete');
  const response = await create(f);
  expect(response.status).toBe(count === 2000 ? 202 : 422);
  if (count === 2000) {
    const evaluation = (await response.json()).evaluation, user = JSON.parse(evaluation.manifest.request.user);
    expect(user.output_items).toHaveLength(2000);
    expect(evaluatorReplySchema.safeParse({ criteria: [], matches: [], unmatched_output_ids: user.output_items.map((item: { id: string }) => item.id), unmatched_reference_ids: [] }).success).toBe(true);
    // Complete this boundary fixture without a provider call; exact rubric checks remain unchanged elsewhere.
    await sharedDb().execute(sql`update development_evaluations set status='failed',error='Admission boundary fixture only' where id=${evaluation.id}`);
  } else {
    expect((await response.json()).code).toBe('evaluation_too_large');
    expect(route).not.toHaveBeenCalled(); expect(reserve).not.toHaveBeenCalled();
    expect(await evaluatorStore.listEvaluations(f.e.id)).toEqual([]);
  }
  expect(send).not.toHaveBeenCalled();
});

it('redacts owner evaluation and profile responses without changing retained evidence', async () => {
  const f = await fixture();
  const result = structuredClone(f.result);
  result.reason = 'test-key-never-send';
  Object.assign(result.output as object, { 'sk-abcdefghijklmnopqrstuvwx': 'test-key-never-send' });
  result.output_id = developmentOutputIdentity(result);
  await sharedDb().execute(sql`update development_execution_sections set result=${JSON.stringify(result)}::jsonb where id=${f.input.attempt_id}`);
  f.input.output_id = result.output_id;
  const response = await create(f);
  const body = await response.json();
  expect(JSON.stringify(body)).not.toContain('test-key-never-send');
  const saved = await getEvaluation(f.e.id, body.evaluation.id);
  expect(saved.manifest.output.reason).toBe('test-key-never-send');
  expect(saved.manifest.output.output_id).toBe(result.output_id);
  expect(saved.manifest.output.output).toHaveProperty('sk-abcdefghijklmnopqrstuvwx');
  const providerReply = reply('gap_extraction'); providerReply.criteria[0].reason = 'test-key-never-send sk-abcdefghijklmnopqrstuvwx';
  vi.spyOn(xaiGrok, 'complete').mockResolvedValue(JSON.stringify(providerReply));
  await progressEvaluation(saved.id); await progressEvaluation(saved.id);
  expect((await getEvaluation(f.e.id, saved.id)).receipt?.text).toContain('test-key-never-send');
  expect(JSON.stringify(await (await GET(req({}), ctx(f.e.id))).json())).not.toContain('test-key-never-send');
  expect(JSON.stringify(await (await detail(req({}), { params: Promise.resolve({ id: f.e.id, evaluationId: saved.id }) })).json())).not.toContain('test-key-never-send');
  expect(JSON.stringify(await (await detail(req({}), { params: Promise.resolve({ id: f.e.id, evaluationId: saved.id }) })).json())).not.toContain('sk-abcdefghijklmnopqrstuvwx');
  const profile = await save(req({ name: 'test-key-never-send', defaults: balancedProfile.defaults, sections: balancedProfile.sections }), ctx(f.e.id));
  expect(JSON.stringify(await profile.json())).not.toContain('test-key-never-send');
  expect(JSON.stringify(await (await profiles(req({}), ctx(f.e.id))).json())).not.toContain('test-key-never-send');
});
it('shows real evaluation state under its exact attempt in execution history', async () => {
  const f = await fixture();
  const evaluation = (await (await create(f)).json()).evaluation;
  const read = async () => (await (await executionDetail(req({}), { params: Promise.resolve({ id: f.e.id, executionId: f.execution.id }) })).json()).history[f.input.attempt_id].evaluations;
  expect(await read()).toEqual(expect.arrayContaining([expect.objectContaining({ id: evaluation.id, status: 'queued', output_id: f.input.output_id, profile_id: 'balanced', freshness: 'unavailable' })]));
  vi.spyOn(xaiGrok, 'complete').mockImplementation(async () => {
    expect(await read()).toEqual(expect.arrayContaining([expect.objectContaining({ id: evaluation.id, status: 'sending' })]));
    return JSON.stringify(reply('gap_extraction'));
  });
  await progressEvaluation(evaluation.id);
  expect(await read()).toEqual(expect.arrayContaining([expect.objectContaining({ id: evaluation.id, status: 'received' })]));
  await progressEvaluation(evaluation.id);
  expect(await read()).toEqual(expect.arrayContaining([expect.objectContaining({ id: evaluation.id, status: 'succeeded' })]));
});
it('compares only the selected output, profile version, section settings and reference provenance', async () => {
  const { compareEvaluation } = await import('@/modules/development/evaluation-freshness');
  const f = await fixture(), document = await reference(f);
  const evaluation = (await (await create(f, { reference_ids: [document.id] })).json()).evaluation;
  const selection = { attempt_id: f.input.attempt_id, output_id: f.input.output_id, profile: evaluation.manifest.profile, config: evaluation.manifest.config, references: [document] };
  expect(compareEvaluation(evaluation, null).freshness).toBe('unavailable');
  expect(compareEvaluation(evaluation, selection).freshness).toBe('current');
  expect(compareEvaluation(evaluation, { ...selection, output_id: 'different' }).reasons).toContain('output_changed');
  expect(compareEvaluation(evaluation, { ...selection, profile: { ...selection.profile, version: 2 } }).reasons).toContain('profile_changed');
  const changed = structuredClone(selection.config); changed.sections.gap_extraction.route.temperature = 0.9;
  expect(compareEvaluation(evaluation, { ...selection, config: changed }).reasons).toContain('evaluator_changed');
  const unrelated = structuredClone(selection.config); unrelated.sections.tactic_extraction.route.temperature = 0.9;
  expect(compareEvaluation(evaluation, { ...selection, config: unrelated }).freshness).toBe('current');
  expect(compareEvaluation(evaluation, { ...selection, references: [{ ...document, review_status: 'provisional' }] }).reasons).toContain('references_changed');
  expect(compareEvaluation(evaluation, { ...selection, references: [{ ...document, parsed_sha256: 'changed' }] }).reasons).toContain('references_changed');
  expect(compareEvaluation(evaluation, { ...selection, references: [{ ...document, id: 'other-reference' }] }).reasons).toContain('references_changed');
  expect(compareEvaluation(evaluation, { ...selection, references: [] }).reasons).toContain('references_changed');
});

it('keeps redacted reference snapshots current against unchanged raw provenance', async () => {
  const { compareEvaluation } = await import('@/modules/development/evaluation-freshness');
  const f = await fixture(), document = await reference(f);
  vi.stubEnv('XAI_API_KEY', 'GOLD_REFERENCE_SECRET');
  const created = (await (await create(f, { reference_ids: [document.id] })).json()).evaluation;
  const listed = (await (await GET(new Request('http://localhost'), ctx(f.e.id))).json()).evaluations[0];
  const fetched = (await (await detail(new Request('http://localhost'), { params: Promise.resolve({ id: f.e.id, evaluationId: created.id }) })).json()).evaluation;
  const selection = { attempt_id: f.input.attempt_id, output_id: f.input.output_id, profile: created.manifest.profile, config: created.manifest.config, references: [document] };
  for (const evaluation of [created, listed, fetched]) {
    expect(JSON.stringify(evaluation.manifest.references)).not.toContain('GOLD_REFERENCE_SECRET');
    expect(compareEvaluation(evaluation, selection).freshness).toBe('current');
    expect(compareEvaluation(evaluation, { ...selection, references: [{ ...document, parsed_sha256: 'changed' }] }).reasons).toContain('references_changed');
    expect(compareEvaluation(evaluation, { ...selection, references: [{ ...document, review_status: 'provisional' }] }).reasons).toContain('references_changed');
  }
});
