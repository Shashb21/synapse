/** Real-stage experiment proofs use Arrange / Act / Assert and scripted completions. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { executionConfigSchema } from '@/modules/development/execution-schema';
import { executeDevelopmentSection } from '@/modules/development/stage-execution';
import { canonicalParsedJson, sha256 } from '@/modules/development/documents';
import type { DevelopmentDocument } from '@/modules/development/schema';
import type { JsonCompletion, RunHandle } from '@/modules/kernel/contracts';
import * as customerStore from '@/lib/iegp/store';
import * as kernelDb from '@/modules/kernel/db';
import * as llm from '@/modules/kernel/llm';
const quote = 'Comparative effectiveness remains unknown. An ongoing observational study measures outcomes.';
const source = { id: 'snapshot-1', role: 'source', compatibility: 'compatible', filename: 'source.txt', sha256: 'abc', parsed_sha256: 'parsed', parsed_at: '2026-10-30T00:00:00Z', parser: { name: 'parser', version: '1', model: null, prompt: null }, parsed: { blocks: [{ id: 'block-1', text: quote, heading: 'Evidence', location: '1' }] } } as DevelopmentDocument;
source.parsed_sha256 = sha256(canonicalParsedJson(source.parsed));
const recorder: RunHandle = { id: 'stable-trace', step: async (_name, fn) => fn(), note: () => {}, steps: () => [] };
const gap = { name: 'Comparative evidence', statement: 'Comparative effectiveness remains unknown.', domain: 'comparative_effectiveness', source_quote: quote };
beforeEach(() => vi.spyOn(llm, 'isTestStub').mockReturnValue(false));
describe('KAN-202 real computation', () => {
  it('defaults to Standard, bounds settings and refuses unused single-pass overrides', () => {
    expect(executionConfigSchema.parse({}).mode).toBe('standard');
    expect(executionConfigSchema.safeParse({ stages: { gap_extraction: { route: { provider_id: 'openai', model: 'x', temperature: 9 } } } }).success).toBe(false);
    expect(executionConfigSchema.safeParse({ mode: 'single_pass', stages: { gap_extraction: { overrides: { critic: { provider_id: 'openai', model: 'x' } } } } }).success).toBe(false);
  });
  it('runs the real initial proposer only and preserves unreviewed source-grounded proposals', async () => {
    const complete = vi.fn<JsonCompletion>().mockResolvedValue({ gaps: [gap] });
    const result = await executeDevelopmentSection({ section: 'gap_extraction', sources: [source], prerequisites: {}, mode: 'single_pass', recorder, complete });
    expect(result.generation_status).toBe('succeeded');
    expect(result.review_status).toBe('unreviewed');
    expect(result.candidates).toHaveLength(1);
    expect(result.raw_result.output).toMatchObject({ accepted: [], rejected: [] });
    expect(complete.mock.calls.map(([request]) => request.role)).toEqual(['proposer']);
    expect(result.candidates[0]).not.toHaveProperty('score');
    expect(result.local_state.gaps[0].human_validated).toBe(false);
  });
  it('propagates an intentional continuation yield without catching or repairing it', async () => {
    const sentinel = { yield: true };
    const complete: JsonCompletion = async () => { throw sentinel; };
    await expect(executeDevelopmentSection({ section: 'gap_extraction', sources: [source], prerequisites: {}, mode: 'single_pass', recorder, complete })).rejects.toBe(sentinel);
  });
});

const tactic = { name: 'Observational outcomes study', type: 'rwe_study', status: 'ongoing', evidence_question: 'What are patient outcomes?', source_quote: quote };
const dimensions = { relevance: 'yes', population: 'partial', geography: 'unknown', timing: 'yes', intervention: 'yes', comparator: 'no', outcomes: 'partial', setting: 'unknown', methodology: 'partial', decision_utility: 'no' };
type Section = Parameters<typeof executeDevelopmentSection>[0]['section'];
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
      if (request.role === 'proposer' || request.role === 'reviser') return { rows: body.gaps.map((row: { id: string }) => ({ gap_id: row.id, mapping_status: options.coverage === 'full' ? 'addressed' : options.coverage === 'not_relevant' ? 'open' : 'partially_addressed', confidence: 78, rationale: 'Study answers only the outcomes slice.', mappings: [{ tactic_id: options.badTactic ? 'unknown-tactic' : body.tactics[0].id, coverage: options.coverage ?? 'partial', confidence: 78, rationale: 'Comparative outcome evidence remains unavailable.', dimensions: options.coverage === 'not_relevant' ? null : dimensions, references: [{ entity_type: 'source', entity_id: options.badReference ? 'unseen-source' : source.id, reason: 'Source records the ongoing study.' }] }] })) };
      if (request.role === 'critic') return { reviews: body.rows.map((row: { gap: { id: string }; mappings: { tactic_id: string }[] }) => ({ gap_id: row.gap.id, verdict: review, confidence: 80, note: 'Source supports the coverage.', mappings: row.mappings.map(mapping => ({ tactic_id: mapping.tactic_id, verdict: review, note: 'Assess the comparative slice.' })) })) };
      return { verdicts: body.rows.map((row: { gap: { id: string } }) => ({ gap_id: row.gap.id, verdict, confidence: 80, reason: 'Coverage checked.' })) };
    }
    if (request.role === 'proposer' || request.role === 'reviser') return { addressed_name: 'Observed outcomes', addressed_statement: 'Patient outcomes are measured in the observational population.', addressed_tactic_ids: [options.badTactic ? 'unknown-tactic' : body.mapped_tactics[0].id], open_name: 'Comparative outcomes', open_statement: 'Comparative outcomes against standard care remain unknown.', uncovered_dimensions: ['population'], confidence: 78, rationale: 'The supplied study observes outcomes without a comparator.' };
    if (request.role === 'critic') return { verdict: review, confidence: 80, note: 'Children preserve distinct scope.', issues: [] };
    return { verdict, confidence: 80, note: 'Split follows supplied coverage.' };
  });
}
/** Execute the independent source extractions for an exact local dependency set. */
async function extracted(options: Options = {}) {
  const gapResult = await executeDevelopmentSection({ section: 'gap_extraction', sources: [source], prerequisites: {}, mode: 'single_pass', recorder, complete: scripted('gap_extraction') });
  const tacticResult = await executeDevelopmentSection({ section: 'tactic_extraction', sources: [source], prerequisites: {}, mode: 'single_pass', recorder, complete: scripted('tactic_extraction', options) });
  return { gap_extraction: gapResult, tactic_extraction: tacticResult };
}
/** Execute actual S4 computation for the partial-split prerequisite. */
async function mapped(options: Options = {}) {
  return executeDevelopmentSection({ section: 'matching_coverage', sources: [source], prerequisites: await extracted(options), mode: 'single_pass', recorder, complete: scripted('matching_coverage', options) });
}

describe('KAN-202 source-only stage lineage', () => {
  it('uses actual S3 fields without inventing a matching or human decision', async () => {
    const complete = scripted('tactic_extraction');
    const result = await executeDevelopmentSection({ section: 'tactic_extraction', sources: [source], prerequisites: {}, mode: 'single_pass', recorder, complete });
    expect(result.candidates[0]).toMatchObject(tactic);
    expect(result.candidates[0]).not.toHaveProperty('match');
    expect(result.local_state.tactics[0]).toMatchObject({ review_status: 'candidate', status: 'ongoing', lock: { locked: false } });
    expect(complete.mock.calls.map(([call]) => call.role)).toEqual(['proposer']);
  });
  it.each(['full', 'partial', 'limited', 'not_relevant'] as const)('preserves S4 %s category, dimensions and supplied citations', async coverage => {
    const result = await mapped({ coverage });
    expect(result.generation_status).toBe('succeeded');
    expect(result.local_state.coverages[0]).toMatchObject({ overall: coverage, human_adopted: false, assessment_origin: 'ai', overall_lock: { locked: false } });
    expect(result.candidates[0]).toMatchObject({ mappings: [{ coverage, references: [{ entity_type: 'source', entity_id: source.id }] }] });
    if (coverage !== 'not_relevant') expect(result.local_state.coverages[0].dimensions.population.value).toBe('partial');
  });
  it('uses S6 real mapped scope and returns a proposal without applying or accepting it', async () => {
    const prerequisite = await mapped();
    const before = structuredClone(prerequisite);
    const complete = scripted('partial_splitting');
    const result = await executeDevelopmentSection({ section: 'partial_splitting', sources: [source], prerequisites: { matching_coverage: prerequisite }, mode: 'single_pass', recorder, complete });
    expect(result.generation_status).toBe('succeeded');
    expect(result.candidates[0]).toMatchObject({ parent_gap_id: prerequisite.local_state.gaps[0].id, addressed_tactic_ids: [prerequisite.local_state.tactics[0].id], uncovered_dimensions: ['population'] });
    expect(result.raw_result.agentic?.judged).toEqual([]);
    expect(result.local_state.gaps).toHaveLength(1);
    expect(prerequisite).toEqual(before);
    expect(complete.mock.calls.map(([call]) => call.role)).toEqual(['proposer']);
    const facts = JSON.parse(complete.mock.calls[0][0].user);
    expect(facts.mapped_tactics[0].coverage.dimensions.population.value).toBe('partial');
    expect(facts.mapped_tactics[0].coverage.human_locked).toBe(false);
  });
  it('returns not applicable with no call when no partial mapping exists', async () => {
    const complete = scripted('partial_splitting');
    const result = await executeDevelopmentSection({ section: 'partial_splitting', sources: [source], prerequisites: { matching_coverage: await mapped({ coverage: 'full' }) }, recorder, complete });
    expect(result.generation_status).toBe('not_applicable');
    expect(result.reason).toMatch(/No partially addressed gap/);
    expect(complete).not.toHaveBeenCalled();
  });
  it('rejects source references, changed parsed hashes and unrelated extra dependencies before calling', async () => {
    const complete = scripted('gap_extraction');
    for (const invalid of [{ ...source, role: 'reference' }, { ...source, parsed_sha256: 'changed' }]) await expect(executeDevelopmentSection({ section: 'gap_extraction', sources: [invalid as DevelopmentDocument], prerequisites: {}, recorder, complete })).rejects.toMatchObject({ code: 'invalid_sources' });
    const prerequisites = await extracted();
    await expect(executeDevelopmentSection({ section: 'gap_extraction', sources: [source], prerequisites, recorder, complete })).rejects.toMatchObject({ code: 'invalid_prerequisite' });
    expect(complete).not.toHaveBeenCalled();
  });
  it('refuses missing, rejected, changed and cross-source prerequisites', async () => {
    const prerequisites = await extracted();
    const complete = scripted('matching_coverage');
    for (const prior of [undefined, { ...prerequisites.gap_extraction, generation_status: 'rejected' }, { ...prerequisites.gap_extraction, candidates: [] }, { ...prerequisites.gap_extraction, source_identity: 'other-source' }]) {
      await expect(executeDevelopmentSection({ section: 'matching_coverage', sources: [source], prerequisites: { ...prerequisites, gap_extraction: prior } as typeof prerequisites, recorder, complete })).rejects.toMatchObject({ code: 'invalid_prerequisite' });
    }
    expect(complete).not.toHaveBeenCalled();
  });
  it('refuses invalid extraction quotes, S4 supplied-record citations and S6 scope IDs', async () => {
    await expect(executeDevelopmentSection({ section: 'gap_extraction', sources: [source], prerequisites: {}, mode: 'single_pass', recorder, complete: async () => ({ gaps: [{ ...gap, source_quote: 'An invented source sentence.' }] }) })).rejects.toMatchObject({ code: 'invalid_citation' });
    await expect(mapped({ badReference: true })).rejects.toThrow(/references/);
    await expect(mapped({ badTactic: true })).rejects.toThrow(/complete/);
    await expect(executeDevelopmentSection({ section: 'partial_splitting', sources: [source], prerequisites: { matching_coverage: await mapped() }, mode: 'single_pass', recorder, complete: scripted('partial_splitting', { badTactic: true }) })).rejects.toThrow(/complete/);
  });
  it('refuses fabricated supplied-record citations for not_relevant S4 mappings', async () => {
    await expect(mapped({ coverage: 'not_relevant', badReference: true })).rejects.toThrow(/references/);
  });
  it.each([
    { label: 'null entry', references: [null] },
    { label: 'mixed valid and malformed entries', references: [{ entity_type: 'source', entity_id: source.id, reason: 'Source evidence.' }, null] },
    { label: 'null array', references: null },
    { label: 'non-array object', references: {} },
    { label: 'missing required fields', references: [{}] },
    { label: 'unsupported entity type', references: [{ entity_type: 'tactic', entity_id: source.id, reason: 'Source evidence.' }] },
    { label: 'blank entity ID', references: [{ entity_type: 'source', entity_id: ' ', reason: 'Source evidence.' }] },
    { label: 'non-string entity ID', references: [{ entity_type: 'source', entity_id: 42, reason: 'Source evidence.' }] },
    { label: 'too-short reason', references: [{ entity_type: 'source', entity_id: source.id, reason: 'a' }] },
    { label: 'unexpected reference field', references: [{ entity_type: 'source', entity_id: source.id, reason: 'Source evidence.', url: 'https://invented.invalid' }] },
  ])('refuses malformed supplied S4 references ($label) before normalization', async ({ references }) => {
    const complete = scripted('matching_coverage', { coverage: 'not_relevant' });
    await expect(executeDevelopmentSection({ section: 'matching_coverage', sources: [source], prerequisites: await extracted(), mode: 'single_pass', recorder, complete: async request => {
      const response = await complete(request) as { rows: { mappings: { references: unknown }[] }[] };
      response.rows[0].mappings[0].references = references;
      return response;
    } })).rejects.toThrow();
  });
  it.each(['empty', 'absent'] as const)('allows not_relevant S4 mappings with %s references', async kind => {
    const complete = scripted('matching_coverage', { coverage: 'not_relevant' });
    const result = await executeDevelopmentSection({ section: 'matching_coverage', sources: [source], prerequisites: await extracted(), mode: 'single_pass', recorder, complete: async request => {
      const response = await complete(request) as { rows: { mappings: { references?: unknown[] }[] }[] };
      if (kind === 'empty') response.rows[0].mappings[0].references = [];
      else delete response.rows[0].mappings[0].references;
      return response;
    } });
    expect(result.generation_status).toBe('succeeded');
    expect(result.candidates[0]).toMatchObject({ mappings: [{ coverage: 'not_relevant', references: [] }] });
  });
  it('replays deterministically with frozen source, saved replies and recorder identity', async () => {
    const first = await mapped();
    const second = await mapped();
    expect(second.output_id).toBe(first.output_id);
    expect(second).toEqual(first);
  });
});

describe('KAN-202 Standard production dialogue', () => {
  it.each(['gap_extraction', 'tactic_extraction', 'matching_coverage', 'partial_splitting'] as const)('preserves three exchanges, explicit revision role and final judge for %s', async section => {
    const prerequisites = section === 'matching_coverage' ? await extracted() : section === 'partial_splitting' ? { matching_coverage: await mapped() } : {};
    const complete = scripted(section, { revise: true });
    const result = await executeDevelopmentSection({ section, sources: [source], prerequisites, mode: 'standard', recorder, complete });
    expect(result.generation_status).toBe('succeeded');
    expect(result.review_status).toBe('unreviewed');
    expect(complete.mock.calls.map(([call]) => call.role)).toEqual(['proposer', 'critic', 'reviser', 'critic', 'critic', 'internal_judge']);
    expect(result.omitted_roles).toEqual([]);
  });
  it.each(['gap_extraction', 'tactic_extraction', 'matching_coverage', 'partial_splitting'] as const)('retains actual judge rejection for %s without a successful dependency', async section => {
    const prerequisites = section === 'matching_coverage' ? await extracted() : section === 'partial_splitting' ? { matching_coverage: await mapped() } : {};
    const result = await executeDevelopmentSection({ section, sources: [source], prerequisites, recorder, complete: scripted(section, { reject: true }) });
    expect(result.generation_status).toBe('rejected');
    expect(result.candidates).toEqual([]);
    expect(result.model_outputs.at(-1)?.request.role).toBe('internal_judge');
    expect(JSON.stringify(result.model_outputs.at(-1)?.response)).toContain('reject');
  });
  it('preserves proposer role for initial validation repairs and never invokes a dialogue reviser in Single pass', async () => {
    const complete = vi.fn<JsonCompletion>().mockImplementation(async request => request.purpose.startsWith('gap-proposer:') ? { gaps: [{ ...gap, domain: 'bad-domain' }] } : { gaps: [{ ...gap, id: 'snapshot-1-L001' }] });
    const result = await executeDevelopmentSection({ section: 'gap_extraction', sources: [source], prerequisites: {}, mode: 'single_pass', recorder, complete });
    expect(result.candidates).toHaveLength(1);
    expect(complete.mock.calls.map(([call]) => call.role)).toEqual(['proposer', 'proposer']);
  });
});


describe('KAN-202 frozen boundary', () => {
  it('reads and writes no customer state and supplies only frozen text/local proposals to every role', async () => {
    const names = ['loadState', 'commitExtractedRecords', 'assignTacticToGap', 'splitPartialGap'] as const;
    const operations = names.map(name => vi.spyOn(customerStore, name).mockImplementation(async () => { throw new Error('Customer persistence is forbidden.'); }));
    const database = vi.spyOn(kernelDb, 'db').mockImplementation(() => { throw new Error('Database access is forbidden.'); });
    try {
      const prerequisites = await extracted();
      const mapping = await executeDevelopmentSection({ section: 'matching_coverage', sources: [source], prerequisites, recorder, complete: scripted('matching_coverage') });
      const split = await executeDevelopmentSection({ section: 'partial_splitting', sources: [source], prerequisites: { matching_coverage: mapping }, recorder, complete: scripted('partial_splitting') });
      for (const result of [...Object.values(prerequisites), mapping, split]) {
        for (const { request } of result.model_outputs) {
          expect(request.user).not.toContain('GOLD_REFERENCE_SECRET');
          expect(request.user).not.toContain('worked_examples');
          expect(request.role).toBeTruthy();
        }
      }
      expect(operations.every(operation => operation.mock.calls.length === 0)).toBe(true);
      expect(database).not.toHaveBeenCalled();
      expect(mapping.local_state.gold_needs).toEqual([]);
      expect(mapping.local_state.gold_coverages).toEqual([]);
    } finally {
      operations.forEach(operation => operation.mockRestore());
      database.mockRestore();
    }
  });
  it('fails malformed extraction structure instead of declaring an empty successful dependency', async () => {
    await expect(executeDevelopmentSection({ section: 'gap_extraction', sources: [source], prerequisites: {}, mode: 'single_pass', recorder, complete: async () => ({ wrong: [] }) })).rejects.toThrow();
  });
  it.each([
    { label: 'empty object', gaps: [{}] },
    { label: 'null row', gaps: [null] },
    { label: 'mixed valid and invalid rows', gaps: [gap, {}] },
  ])('refuses $label before S2 can produce a successful downstream dependency', async ({ gaps }) => {
    await expect(executeDevelopmentSection({ section: 'gap_extraction', sources: [source], prerequisites: {}, mode: 'single_pass', recorder, complete: async () => ({ gaps }) })).rejects.toThrow();
  });
  it('retains a successful explicitly empty S2 extraction', async () => {
    const result = await executeDevelopmentSection({ section: 'gap_extraction', sources: [source], prerequisites: {}, mode: 'single_pass', recorder, complete: async () => ({ gaps: [] }) });
    expect(result.generation_status).toBe('succeeded');
    expect(result.candidates).toEqual([]);
    expect(result.local_state.gaps).toEqual([]);
  });
  it('rejects a changed frozen module identity before invoking the model', async () => {
    const complete = scripted('gap_extraction');
    await expect(executeDevelopmentSection({ section: 'gap_extraction', sources: [source], prerequisites: {}, recorder, complete, module_identity: { id: 'different-module', version: '1' } })).rejects.toMatchObject({ code: 'module_changed' });
    expect(complete).not.toHaveBeenCalled();
  });
});


it('does not offer S6 when partial coverage has only a proposed, non-counting tactic', async () => {
  const complete = scripted('partial_splitting');
  const result = await executeDevelopmentSection({ section: 'partial_splitting', sources: [source], prerequisites: { matching_coverage: await mapped({ tacticStatus: 'proposed' }) }, mode: 'single_pass', recorder, complete });
  expect(result.generation_status).toBe('not_applicable');
  expect(complete).not.toHaveBeenCalled();
});

it('omits non-relevant S4 assessments from actual S6 mapped-scope facts while preserving original output', async () => {
  const prerequisites = await extracted();
  const complete = scripted('matching_coverage');
  const extraTactic = { ...prerequisites.tactic_extraction.local_state.tactics[0], id: 'unrelated-tactic', name: 'Unrelated study' };
  // Construct a second genuine extracted tactic rather than modifying the hashed prerequisite.
  prerequisites.tactic_extraction = await executeDevelopmentSection({ section: 'tactic_extraction', sources: [source], prerequisites: {}, mode: 'single_pass', recorder, complete: async () => ({ tactics: [tactic, { ...tactic, name: extraTactic.name }] }) });
  const mapping = await executeDevelopmentSection({ section: 'matching_coverage', sources: [source], prerequisites, mode: 'single_pass', recorder, complete: async request => {
    const response = await complete(request) as { rows: { mappings: unknown[] }[] };
    const body = JSON.parse(request.user);
    response.rows[0].mappings.push({ tactic_id: body.tactics[1].id, coverage: 'not_relevant', confidence: 80, rationale: 'Does not answer the gap.', dimensions: null, references: [] });
    return response;
  } });
  const splitComplete = scripted('partial_splitting');
  const result = await executeDevelopmentSection({ section: 'partial_splitting', sources: [source], prerequisites: { matching_coverage: mapping }, mode: 'single_pass', recorder, complete: splitComplete });
  expect(JSON.parse(splitComplete.mock.calls[0][0].user).mapped_tactics).toHaveLength(1);
  expect(result.local_state.coverages).toHaveLength(2);
  expect(mapping.candidates[0]).toMatchObject({ mappings: [{ coverage: 'partial' }, { coverage: 'not_relevant' }] });
});
