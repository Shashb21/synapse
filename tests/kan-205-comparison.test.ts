/** Arrange saved trials, act on pure comparisons/owner reads, assert truthful compatibility. */
import { afterEach, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';
import * as owner from '@/modules/auth/owner';
import * as store from '@/modules/development/store';
import * as executions from '@/modules/development/execution-store';
import * as evaluations from '@/modules/development/evaluation-store';
import { buildComparison } from '@/modules/development/comparison';
import { GET } from '@/app/api/admin/development/comparison/route';
import type { Execution } from '@/modules/development/execution-store';
import type { Evaluation } from '@/modules/development/evaluation-store';
import { balancedProfile, effectiveCriteria } from '@/modules/development/profile-schema';
import { executionRouteSchema } from '@/modules/development/execution-schema';
import { scoreEvaluation } from '@/modules/development/evaluation-scoring';
import { canonicalParsedJson, sha256 } from '@/modules/development/documents';
import { developmentOutputIdentity } from '@/modules/development/stage-execution';
function fixture() {
  const requested = executionRouteSchema.parse({});
  const route = { requested, actual: { model: requested.model, provider_id: requested.provider_id, params: { temperature: requested.temperature, max_tokens: requested.max_tokens } }, actual_temperature: requested.temperature };
  const source = { id: 'source', sha256: 'bytes', parsed_sha256: sha256(canonicalParsedJson({ blocks: [{ text: 'input' }] })), parsed: { blocks: [{ text: 'input' }] }, parser: { name: 'plain', version: '1' } };
  const output = { section: 'gap_extraction', source_identity: 'source-identity', prerequisite_ids: {}, candidates: [], output: { mode: 'llm', proposed: 0, accepted: [], rejected: [], committed_gap_ids: [], committed_need_ids: [], joined_gap_ids: [], suggestion_ids: [] }, generation_status: 'succeeded' };
  const result = { ...output, output_id: developmentOutputIdentity(output as never) };
  const execution = { id: 'execution', experiment_id: 'experiment', manifest: { sources: [source], target: 'gap_extraction', config: { mode: 'standard', stages: {} }, routes: {}, modules: { gap_extraction: { id: 'module', version: '1' } }, prompts: { gap_extraction: { id: 'prompt', instruction: 'extract' } }, prerequisites: {}, code_identity: 'code' }, sections: [{ id: 'attempt', section: 'gap_extraction', result, prerequisites: {}, status: 'succeeded' }], calls: [] } as unknown as Execution;
  const evaluation = { id: 'evaluation', experiment_id: 'experiment', status: 'succeeded', created_at: '2026-10-30', manifest: { version: 1, execution_id: 'execution', attempt_id: 'attempt', output_id: result.output_id, section: 'gap_extraction', output: result, sources: [source], generation: execution.manifest, profile: balancedProfile, criteria: effectiveCriteria(balancedProfile, 'gap_extraction'), config: { sections: { gap_extraction: { method: 'rubric', route: requested } } }, route, references: [], reference_requested: false, reference_items: [], reference_issues: [], code_identity: 'evaluator-v1' }, result: { rubric: { score: 3 }, checks: { passed: true }, reference: { status: 'unscored' } } } as unknown as Evaluation;
  evaluation.result = scoreEvaluation(evaluation.manifest, { criteria: evaluation.manifest.criteria.map(criterion => ({ criterion_id: criterion.id, score: 3, reason: 'Supported by the frozen source.' })), matches: [], unmatched_output_ids: [], unmatched_reference_ids: [] });
  return { execution, evaluations: [evaluation] };
}
const compare = (left = fixture(), right = structuredClone(left)) => buildComparison(left, right);
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
it('compares equal frozen input/rubric and permits deliberate model/mode changes', () => {
  const left = fixture(), right = structuredClone(left);
  right.execution.manifest.config.mode = 'single_pass';
  right.execution.manifest.routes = { gap_extraction: { proposer: { actual: { model: 'different' } } } } as never;
  const result = compare(left, right);
  expect(result.compatibility.controlled).toBe(true);
  expect(result.compatibility.varying_factors).toEqual(expect.arrayContaining(['generation_mode', 'generation_routes']));
  expect(result.sections[0].evaluation_pairs[0].quality_available).toBe(true);
});
it.each(['source_bytes', 'parsed_identity', 'source_content', 'section', 'prerequisites', 'profile', 'criteria', 'method', 'evaluator', 'evaluator_version', 'reference', 'review_status'])('blocks differing %s', kind => {
  const left = fixture(), right = structuredClone(left), manifest = right.evaluations[0].manifest;
  if (kind === 'source_bytes') right.execution.manifest.sources[0].sha256 = 'changed';
  if (kind === 'parsed_identity') right.execution.manifest.sources[0].parsed_sha256 = 'changed';
  if (kind === 'source_content') right.execution.manifest.sources[0].parsed = { text: 'changed' };
  if (kind === 'section') right.execution.sections = [];
  if (kind === 'prerequisites') right.execution.sections[0].result!.prerequisite_ids = { tactic_extraction: 'different' };
  if (kind === 'profile') manifest.profile.version = 2;
  if (kind === 'criteria') manifest.criteria = [{ id: 'changed' }] as never;
  if (kind === 'method') manifest.config.sections.gap_extraction.method = 'checks_only';
  if (kind === 'evaluator') manifest.route!.actual.model = 'other';
  if (kind === 'evaluator_version') manifest.code_identity = 'v2';
  if (kind === 'reference' || kind === 'review_status') {
    const ref = { id: 'gold', sha256: 'gold', parsed_sha256: 'gold-parsed', section: 'gap_extraction', source_document_ids: ['source'], compatibility: 'compatible', review_status: 'unreviewed', parsed: {} };
    left.evaluations[0].manifest.references = [ref] as never;
    manifest.references = [{ ...ref, ...(kind === 'reference' ? { parsed_sha256: 'changed' } : { review_status: 'provisional' }) }] as never;
  }
  expect(compare(left, right).compatibility.controlled).toBe(false);
});
it('reports missing legacy metadata and malformed output without crashing or inventing scores', () => {
  const right = fixture(); delete (right.execution.manifest as Partial<Execution['manifest']>).sources;
  right.execution.sections[0].result = {} as never;
  const result = compare(fixture(), right);
  expect(result.compatibility.controlled).toBe(false); expect(result.compatibility.missing_evidence.length).toBeGreaterThan(0);
});
it('preserves failed/unscored latest history and excludes evaluations bound to other outputs', () => {
  const left = fixture(), right = fixture();
  right.evaluations[0].status = 'failed'; right.evaluations[0].result = null;
  right.evaluations.push({ ...structuredClone(right.evaluations[0]), id: 'foreign', manifest: { ...right.evaluations[0].manifest, output_id: 'other' } });
  const result = compare(left, right);
  expect(result.right.evaluations).toHaveLength(1);
  expect(result.sections[0].evaluation_pairs[0].quality_available).toBe(false);
  expect(result.compatibility.controlled).toBe(false);
});
const query = '?left_experiment_id=experiment&left_execution_id=execution&right_experiment_id=experiment&right_execution_id=execution';
it('authorizes before query/persistence I/O and rejects bounded malformed queries', async () => {
  const read = vi.spyOn(store, 'getExperiment');
  vi.spyOn(owner, 'ownerGate').mockResolvedValue(NextResponse.json({}, { status: 403 }));
  expect((await GET(new Request('http://localhost?' + 'x'.repeat(5000)))).status).toBe(403); expect(read).not.toHaveBeenCalled();
  vi.mocked(owner.ownerGate).mockResolvedValue(null);
  vi.spyOn(owner, 'ownerAccess').mockResolvedValue({ owner: true, email: 'owner' } as never);
  for (const suffix of ['', query + '&left_execution_id=duplicate', query.replace('execution&', 'x'.repeat(201) + '&'), query + '&unknown=x']) {
    expect((await GET(new Request('http://localhost' + suffix))).status).toBe(400);
  }
  expect(read).not.toHaveBeenCalled();
});
it('returns absent/foreign records safely and redacts all owner-facing evidence', async () => {
  vi.spyOn(owner, 'ownerGate').mockResolvedValue(null); vi.spyOn(owner, 'ownerAccess').mockResolvedValue({ owner: true, email: 'owner' } as never);
  const read = vi.spyOn(store, 'getExperiment').mockResolvedValue({} as never);
  vi.spyOn(executions, 'getExecution').mockResolvedValue(fixture().execution);
  vi.spyOn(evaluations, 'listAttemptEvaluations').mockResolvedValue(fixture().evaluations);
  vi.stubEnv('XAI_API_KEY', 'private-provider-key');
  const execution = fixture().execution; execution.error = 'private-provider-key';
  (execution.sections[0].result!.output as Record<string, unknown>).secret = 'private-provider-key';
  execution.sections[0].result!.output_id = developmentOutputIdentity(execution.sections[0].result!);
  const saved = fixture().evaluations[0]; saved.manifest.output = execution.sections[0].result!; saved.manifest.output_id = execution.sections[0].result!.output_id; saved.manifest.generation = execution.manifest;
  vi.mocked(evaluations.listAttemptEvaluations).mockResolvedValue([saved]);
  vi.mocked(executions.getExecution).mockResolvedValue(execution);
  const response = await GET(new Request('http://localhost' + query));
  expect(response.status).toBe(200); expect(response.headers.get('Cache-Control')).toBe('no-store');
  const body = await response.json(); expect(JSON.stringify(body)).not.toContain('private-provider-key');
  expect(body.comparison.compatibility.controlled).toBe(true);
  const { DevelopmentError: ForeignError } = await import('@/modules/development/schema');
  vi.mocked(executions.getExecution).mockRejectedValueOnce(new ForeignError(404, 'not_found', 'Foreign execution'));
  expect((await GET(new Request('http://localhost' + query))).status).toBe(404);
  const { DevelopmentError } = await import('@/modules/development/schema');
  read.mockRejectedValue(new DevelopmentError(404, 'not_found', 'Missing'));
  expect((await GET(new Request('http://localhost' + query))).status).toBe(404);
});
it('retains both older success and newer failure without silently choosing success', () => {
  const left = fixture(), right = fixture();
  right.evaluations.unshift({ ...structuredClone(right.evaluations[0]), id: 'latest-failure', status: 'failed', result: null, created_at: '2026-10-31' });
  const result = compare(left, right);
  expect(result.right.evaluations.map(e => e.id)).toEqual(['latest-failure', 'evaluation']);
  expect(result.sections[0].evaluation_pairs.map(pair => pair.quality_available)).toEqual([false, true]);
  expect(result.compatibility.controlled).toBe(false);
});
it('keeps reference-only unscored evidence and not-applicable output unavailable', () => {
  const left = fixture(), right = fixture();
  for (const side of [left, right]) side.evaluations[0].manifest.config.sections.gap_extraction.method = 'reference';
  expect(compare(left, right).sections[0].evaluation_pairs[0].quality_available).toBe(false);
  right.execution.sections[0].status = 'not_applicable';
  right.execution.sections[0].result!.generation_status = 'not_applicable';
  right.execution.sections[0].result!.output_id = developmentOutputIdentity(right.execution.sections[0].result!);
  expect(compare(left, right).compatibility.controlled).toBe(false);
});
it('compares equal complete reference provenance and blocks missing evaluator metadata', () => {
  const left = fixture(), right = fixture();
  const reference = { ...left.execution.manifest.sources[0], id: 'gold', section: 'gap_extraction', source_document_ids: ['source'], compatibility: 'compatible', review_status: 'unreviewed' };
  left.evaluations[0].manifest.references = [reference] as never;
  right.evaluations[0].manifest.references = [structuredClone(reference)] as never;
  expect(compare(left, right).compatibility.controlled).toBe(true);
  delete (right.evaluations[0].manifest as Partial<Evaluation['manifest']>).profile;
  expect(compare(left, right).compatibility.missing_evidence.length).toBeGreaterThan(0);
});

it.each(['generation_code', 'module_null', 'module_empty', 'prompt_empty', 'parser_empty', 'evaluator_route_empty', 'evaluator_actual_empty', 'evaluator_config_empty'])('leaves identical malformed %s metadata unavailable', kind => {
  const left = fixture();
  if (kind === 'generation_code') left.execution.manifest.code_identity = null as never;
  if (kind === 'module_null') left.execution.manifest.modules.gap_extraction = null as never;
  if (kind === 'module_empty') left.execution.manifest.modules.gap_extraction = {} as never;
  if (kind === 'prompt_empty') left.execution.manifest.prompts.gap_extraction = {} as never;
  if (kind === 'parser_empty') left.execution.manifest.sources[0].parser = {} as never;
  if (kind === 'evaluator_route_empty') left.evaluations[0].manifest.route = {} as never;
  if (kind === 'evaluator_actual_empty') left.evaluations[0].manifest.route!.actual = {} as never;
  if (kind === 'evaluator_config_empty') left.evaluations[0].manifest.config.sections.gap_extraction = {} as never;
  const result = compare(left, structuredClone(left));
  expect(result.compatibility.controlled).toBe(false);
  expect(result.compatibility.missing_evidence.length).toBeGreaterThan(0);
  expect(result.sections[0].evaluation_pairs[0].quality_available).toBe(false);
});
it.each([null, 'malformed', {}, { accepted: 'wrong' }])('leaves hash-valid malformed saved output %j unavailable', output => {
  const left = fixture(), result = left.execution.sections[0].result!;
  result.output = output; result.output_id = developmentOutputIdentity(result);
  left.evaluations[0].manifest.output_id = result.output_id;
  const comparison = compare(left, structuredClone(left));
  expect(comparison.compatibility.controlled).toBe(false);
  expect(comparison.sections[0].compatibility.missing_evidence).toContain('valid_immutable_output');
  expect(comparison.sections[0].evaluation_pairs[0].quality_available).toBe(false);
});
it('preserves provider-free checks-only comparisons with explicitly null evaluator routes', () => {
  const left = fixture();
  left.evaluations[0].manifest.config.sections.gap_extraction.method = 'checks_only';
  left.evaluations[0].manifest.route = null;
  left.evaluations[0].result!.rubric = null;
  expect(compare(left, structuredClone(left)).compatibility.controlled).toBe(true);
});

it('accepts the actual startExecution baseline prompt with an explicitly empty instruction', () => {
  const left = fixture();
  left.execution.manifest.prompts.gap_extraction = { id: 'development-baseline-v1', instruction: '' };
  const result = compare(left, structuredClone(left));
  expect(result.compatibility.controlled).toBe(true);
  expect(result.sections[0].evaluation_pairs[0].quality_available).toBe(true);
});
it.each([undefined, null, 12])('rejects absent/non-string baseline instruction %j', instruction => {
  const left = fixture(); left.execution.manifest.prompts.gap_extraction = { id: 'development-baseline-v1', instruction } as never;
  expect(compare(left, structuredClone(left)).compatibility.controlled).toBe(false);
});
it('blocks genuinely differing optional instructions', () => {
  const left = fixture(), right = structuredClone(left); right.execution.manifest.prompts.gap_extraction.instruction = 'changed';
  expect(compare(left, right).compatibility.controlled).toBe(false);
});
it.each(['check_items', 'check_detail', 'check_duplicate', 'check_aggregate', 'rubric_criteria', 'rubric_reason', 'rubric_label', 'rubric_range', 'criterion_range', 'criterion_omitted', 'criterion_duplicate', 'criterion_unknown', 'threshold', 'factual_association', 'rubric_aggregate', 'frozen_empty_criteria', 'reference_reasons', 'reference_ratio', 'reference_negative', 'reference_accounting', 'config_temperature', 'config_fallbacks', 'frozen_requested_tokens'])('rejects incomplete/impossible saved evidence: %s', kind => {
  const left = fixture(), evaluation = left.evaluations[0], result = evaluation.result!;
  if (kind === 'check_items') delete (result.checks as Partial<typeof result.checks>).items;
  if (kind === 'check_detail') delete (result.checks.items[0] as Partial<typeof result.checks.items[number]>).detail;
  if (kind === 'check_duplicate') result.checks.items[1] = structuredClone(result.checks.items[0]);
  if (kind === 'check_aggregate') result.checks.passed = !result.checks.passed;
  if (kind === 'rubric_criteria') delete (result.rubric as Partial<NonNullable<typeof result.rubric>>).criteria;
  if (kind === 'rubric_reason') delete (result.rubric!.criteria[0] as Partial<NonNullable<typeof result.rubric>['criteria'][number]>).reason;
  if (kind === 'rubric_label') result.rubric!.label = 'human' as never;
  if (kind === 'rubric_range') result.rubric!.score = 8;
  if (kind === 'criterion_range') result.rubric!.criteria[0].score = -1;
  if (kind === 'criterion_omitted') result.rubric!.criteria.pop();
  if (kind === 'criterion_duplicate') result.rubric!.criteria[1] = structuredClone(result.rubric!.criteria[0]);
  if (kind === 'criterion_unknown') result.rubric!.criteria[0].criterion_id = 'unknown';
  if (kind === 'threshold') result.rubric!.criteria[0].threshold_met = true;
  if (kind === 'factual_association') result.rubric!.factual_checks_passed = !result.checks.passed;
  if (kind === 'rubric_aggregate') result.rubric!.score = 2;
  if (kind === 'frozen_empty_criteria') evaluation.manifest.criteria = [];
  if (kind === 'reference_reasons') delete (result.reference as Partial<typeof result.reference>).reasons;
  if (kind === 'reference_ratio') result.reference.precision.value = 1;
  if (kind === 'reference_negative') result.reference.recall.denominator = -1;
  if (kind === 'reference_accounting') result.reference.unmatched_output_ids = ['unknown'];
  if (kind === 'config_temperature') delete (evaluation.manifest.config.sections.gap_extraction.route as Partial<NonNullable<typeof evaluation.manifest.route>['requested']>).temperature;
  if (kind === 'config_fallbacks') delete (evaluation.manifest.config.sections.gap_extraction.route as Partial<NonNullable<typeof evaluation.manifest.route>['requested']>).fallbacks;
  if (kind === 'frozen_requested_tokens') delete (evaluation.manifest.route!.requested as Partial<NonNullable<typeof evaluation.manifest.route>['requested']>).max_tokens;
  const comparison = compare(left, structuredClone(left));
  expect(comparison.compatibility.controlled).toBe(false);
  expect(comparison.sections[0].evaluation_pairs[0].quality_available).toBe(false);
  expect(comparison.left.evaluations[0]).toEqual(evaluation);
});
function referenceFixture() {
  const side = fixture(), evaluation = side.evaluations[0], output = evaluation.manifest.output;
  const candidate = { id: 'gap', document_id: 'source', source_id: 'source', name: 'Need', statement: 'input', domain: 'comparative_effectiveness', source_quote: 'input', score: 80, verdict: 'accept', critic_note: '', duplicate_of: null, match: 'new', match_gap_id: null, same_as_candidate: null };
  output.candidates = [candidate];
  (output.output as { accepted: unknown[] }).accepted = [candidate];
  output.output_id = developmentOutputIdentity(output); evaluation.manifest.output_id = output.output_id;
  evaluation.manifest.config.sections.gap_extraction.method = 'reference'; evaluation.manifest.reference_requested = true;
  evaluation.manifest.reference_items = [{ id: 'gold:one', answer: { statement: 'input' } }, { id: 'gold:two', answer: { statement: 'other' } }];
  evaluation.result = scoreEvaluation(evaluation.manifest, { criteria: [], matches: [{ output_id: 'candidate:0', reference_id: 'gold:one', reason: 'Same supplied question.' }], unmatched_output_ids: [], unmatched_reference_ids: ['gold:two'] });
  return side;
}
it('accepts complete scored reference accounting produced by scoreEvaluation', () => {
  const left = referenceFixture();
  expect(left.evaluations[0].result!.reference.recall.value).toBe(0.5);
  expect(compare(left, structuredClone(left)).sections[0].evaluation_pairs[0].quality_available).toBe(true);
});
it.each(['denominator_missing', 'denominator_wrong', 'fractional_count', 'numerator_wrong', 'ratio_wrong', 'reason_missing', 'unmatched_missing', 'duplicate_accounting', 'unknown_accounting'])('rejects malformed scored reference %s', kind => {
  const left = referenceFixture(), reference = left.evaluations[0].result!.reference;
  if (kind === 'denominator_missing') delete (reference.precision as Partial<typeof reference.precision>).denominator;
  if (kind === 'denominator_wrong') reference.precision.denominator = 0;
  if (kind === 'fractional_count') reference.recall.denominator = 1.5;
  if (kind === 'numerator_wrong') reference.recall.numerator = 0;
  if (kind === 'ratio_wrong') reference.recall.value = 1;
  if (kind === 'reason_missing') delete (reference.matches[0] as Partial<typeof reference.matches[number]>).reason;
  if (kind === 'unmatched_missing') reference.unmatched_reference_ids = [];
  if (kind === 'duplicate_accounting') reference.unmatched_reference_ids.push('gold:one');
  if (kind === 'unknown_accounting') reference.matches[0].output_id = 'unknown';
  expect(compare(left, structuredClone(left)).sections[0].evaluation_pairs[0].quality_available).toBe(false);
});
it('keeps complete observed failed factual checks available as evidence', () => {
  const left = fixture(), evaluation = left.evaluations[0]; evaluation.manifest.sources[0].parsed_sha256 = 'bad-saved-hash';
  evaluation.result = scoreEvaluation(evaluation.manifest, { criteria: evaluation.manifest.criteria.map(c => ({ criterion_id: c.id, score: 2, reason: 'Observed failure remains evidence.' })), matches: [], unmatched_output_ids: [], unmatched_reference_ids: [] });
  expect(evaluation.result.checks.passed).toBe(false);
  expect(compare(left, structuredClone(left)).sections[0].evaluation_pairs[0].quality_available).toBe(true);
});
it.each(['criterion', 'candidate'])('keeps null frozen %s elements unavailable without throwing', kind => {
  const left = kind === 'criterion' ? fixture() : referenceFixture(), manifest = left.evaluations[0].manifest;
  if (kind === 'criterion') manifest.criteria = [null] as never;
  if (kind === 'candidate') {
    manifest.section = 'matching_coverage';
    left.execution.sections[0].section = 'matching_coverage';
    manifest.output.section = 'matching_coverage';
    manifest.config.sections.matching_coverage = manifest.config.sections.gap_extraction;
    manifest.output.candidates = [null] as never;
  }
  expect(() => compare(left, structuredClone(left))).not.toThrow();
  expect(compare(left, structuredClone(left)).compatibility.controlled).toBe(false);
});
