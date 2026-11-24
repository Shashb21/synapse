/** Verify deterministic, saved-evidence-only release summary accounting. */
import { expect, it } from 'vitest';
import { buildBlankWorkspace } from '@/lib/iegp/blank';
import { buildComparison, type ComparisonSide } from '@/modules/development/comparison';
import { canonicalParsedJson, sha256 } from '@/modules/development/documents';
import { evaluationConfigSchema } from '@/modules/development/evaluation-schema';
import { scoreEvaluation } from '@/modules/development/evaluation-scoring';
import type { Evaluation, EvaluationManifest } from '@/modules/development/evaluation-store';
import { EXECUTION_ROLES, executionConfigSchema, executionRouteSchema, type ExecutionMode } from '@/modules/development/execution-schema';
import type { Execution, ExecutionManifest, SectionAttempt } from '@/modules/development/execution-store';
import { balancedProfile, effectiveCriteria } from '@/modules/development/profile-schema';
import { summarizePairedReleaseEvidence, type PairedReleaseEvidence } from '@/modules/development/release-summary';
import type { FrozenRoute } from '@/modules/development/routes';
import { type DevelopmentDocument, sectionSchema, structuredReferenceSchema } from '@/modules/development/schema';
import { developmentModuleIdentity, developmentOutputIdentity, type DevelopmentSectionResult } from '@/modules/development/stage-execution';

const section = 'gap_extraction';
const experimentId = 'synthetic-experiment';
const startedAt = '2026-01-01T00:00:00Z';
const sourceText = 'Synthetic evidence questions A, B and C.';

/** Create a synthetic saved source or evaluator-only reference with its parsed hash. */
function savedDocument(id: string, parsed: unknown, reference = false): DevelopmentDocument {
  const json = canonicalParsedJson(parsed);
  return {
    id, experiment_id: experimentId, role: reference ? 'reference' : 'source',
    origin: 'private', filename: `${id}.json`, mime: 'application/json', bytes: Buffer.byteLength(json),
    sha256: sha256(json), parsed_sha256: sha256(json), parsed,
    parser: { name: 'fixture', version: '1', model: null, prompt: null },
    created_by: 'synthetic-author', created_at: startedAt, original_owner: 'synthetic-author',
    original_created_at: startedAt, parsed_at: startedAt, source_workspace_id: null, source_file_id: null,
    section: reference ? section : null, source_document_ids: reference ? ['source'] : [],
    review_status: reference ? 'provisional' : 'not_applicable', compatibility: 'compatible',
  };
}

/** Represent a saved route without consulting provider credentials or resolving a live route. */
function savedRoute(temperature = 0.2): FrozenRoute {
  const requested = executionRouteSchema.parse({ temperature });
  return {
    requested,
    actual: {
      stage: 'S2', provider_id: requested.provider_id, provider_label: 'Fixture provider',
      model: requested.model, auth: 'api_key', connected: true,
      params: { temperature, max_tokens: requested.max_tokens }, fallbacks: requested.fallbacks,
      degraded: false, reason: null,
    },
    actual_temperature: temperature,
  };
}

type SideOptions = {
  finishedAt?: string;
  costs?: (number | null)[];
  sourceText?: string;
  adjustRoutes?: (routes: ExecutionManifest['routes'][typeof section]) => void;
};

/** Build one synthetic saved execution and a scored evaluation bound to its exact output. */
function savedSide(id: string, mode: ExecutionMode, options: SideOptions = {}): ComparisonSide {
  const single = mode === 'single_pass';
  const attemptId = `${id}-attempt`;
  const finishedAt = options.finishedAt ?? (single ? '2026-01-01T00:00:02Z' : '2026-01-01T00:00:05Z');
  const sources = [savedDocument('source', { blocks: [{ id: 'block-1', text: options.sourceText ?? sourceText }] })];
  const route = savedRoute();
  const roles = single ? ['proposer'] as const : EXECUTION_ROLES;
  const roleRoutes = Object.fromEntries(roles.map(role => [role, savedRoute()]));
  options.adjustRoutes?.(roleRoutes);
  const modules = Object.fromEntries(sectionSchema.options.map(name => [name, developmentModuleIdentity(name)])) as ExecutionManifest['modules'];
  const prompt = { id: 'development-baseline-v1', instruction: '' };
  const prompts = Object.fromEntries(sectionSchema.options.map(name => [name, prompt])) as ExecutionManifest['prompts'];
  const manifest: ExecutionManifest = {
    revision: 1, target: section, sources, config: executionConfigSchema.parse({ mode }),
    routes: { [section]: roleRoutes } as ExecutionManifest['routes'], modules, prompts,
    prerequisites: {}, code_identity: 'fixture-generation-v1',
    retry_policy: { http_max_attempts: 1, uncertain_resend: false, user_rerun: 'fresh_attempt_may_charge' },
  };

  const candidateNames = single ? ['A', 'C'] : ['A', 'B'];
  const candidates = candidateNames.map(name => ({
    id: `candidate-${name}`, document_id: 'source', source_id: 'source', name,
    statement: `Evidence question ${name}`, domain: 'comparative_effectiveness',
    source_quote: options.sourceText ?? sourceText, score: 80, verdict: 'accept',
    critic_note: '', duplicate_of: null, match: 'new', match_gap_id: null, same_as_candidate: null,
  }));
  const output = {
    mode: 'llm', proposed: candidates.length, accepted: candidates, rejected: [],
    committed_gap_ids: [], committed_need_ids: [], joined_gap_ids: [], suggestion_ids: [],
  };
  const payload: Omit<DevelopmentSectionResult, 'output_id'> = {
    section, mode, generation_status: 'succeeded', review_status: 'unreviewed', reason: null,
    output, candidates, raw_result: { output, summary: 'Synthetic extraction' },
    model_outputs: [], local_state: buildBlankWorkspace(),
    source_identity: sha256(canonicalParsedJson(sources)), prerequisite_ids: {},
    trace_id: `${id}-trace`, module_identity: modules[section], prompt_identity: prompt,
    omitted_roles: single ? EXECUTION_ROLES.slice(1) : [],
  };
  const result = { ...payload, output_id: developmentOutputIdentity(payload) };
  const attempt: SectionAttempt = {
    id: attemptId, execution_id: id, experiment_id: experimentId, section, ordinal: 0,
    status: 'succeeded', result, error: null, prerequisites: {}, created_at: startedAt,
    started_at: startedAt, finished_at: finishedAt,
  };
  const request = {
    system: 'Synthetic instructions', user: 'Synthetic input',
    model: route.actual.model, temperature: route.actual.params.temperature, max_tokens: route.actual.params.max_tokens,
  };
  const execution: Execution = {
    id, experiment_id: experimentId, manifest, generation_status: 'succeeded', evaluation_status: 'not_requested',
    created_at: startedAt, updated_at: finishedAt, error: null, sections: [attempt],
    calls: (options.costs ?? [single ? 0 : null]).map((cost, ordinal) => ({
      id: `${id}-call-${ordinal}`, execution_id: id, section_id: attemptId, ordinal,
      identity: `${id}-request-${ordinal}`, request: { request, purpose: 'Synthetic generation', attempt: 1, role: roles[ordinal] ?? 'proposer' },
      route, status: 'succeeded', receipt: { text: 'Synthetic receipt', usage: null, cost_usd: cost, price_source: null, llm_call_id: null },
      error: null, failure_accounting: null, created_at: startedAt, sending_at: startedAt, settled_at: finishedAt,
    })),
  };

  const answers = structuredReferenceSchema.parse({
    version: 1, section, source_document_ids: ['source'], expected_answers: ['A', 'B'].map(name => ({
      id: name, source_document_id: 'source', statement: `Evidence question ${name}`, quote: sourceText,
    })),
  });
  const reference = savedDocument('reference', answers, true);
  const evaluationManifest: EvaluationManifest = {
    version: 1, execution_id: id, attempt_id: attemptId, output_id: result.output_id, section,
    profile: balancedProfile, criteria: effectiveCriteria(balancedProfile, section),
    config: evaluationConfigSchema.parse({ sections: { [section]: { method: 'reference', route: route.requested } } }),
    route, output: result, generation: manifest, sources, references: [reference],
    reference_items: answers.expected_answers.map(answer => ({ id: `reference:${answer.id}`, answer })),
    reference_issues: [], reference_requested: true, code_identity: 'fixture-evaluator-v1',
    request, retry_policy: { http_max_attempts: 1, uncertain_resend: false },
  };
  const evaluation: Evaluation = {
    id: `${id}-evaluation`, experiment_id: experimentId, manifest: evaluationManifest,
    status: 'succeeded', created_at: finishedAt, updated_at: finishedAt, sending_at: finishedAt,
    settled_at: finishedAt, receipt: null, failure_accounting: null, error: null,
    result: scoreEvaluation(evaluationManifest, {
      criteria: [],
      matches: [
        { output_id: 'candidate:0', reference_id: 'reference:A', reason: 'Matches question A.' },
        ...(!single ? [{ output_id: 'candidate:1', reference_id: 'reference:B', reason: 'Matches question B.' }] : []),
      ],
      unmatched_output_ids: single ? ['candidate:1'] : [],
      unmatched_reference_ids: single ? ['reference:B'] : [],
    }),
  };
  return { execution, evaluations: [evaluation] };
}

/** Compare distinct saved arms through the production evidence validator. */
function pair(id: string, single?: SideOptions, standard?: SideOptions): PairedReleaseEvidence {
  return {
    trial_id: id,
    comparison: buildComparison(savedSide(`single-${id}`, 'single_pass', single), savedSide(`standard-${id}`, 'standard', standard)),
  };
}

it('reports provisional per-repeat variation, known zero and unknown costs, misses, and false positives', () => {
  const trials = [pair('repeat-1'), pair('repeat-2', {}, { finishedAt: '2026-01-01T00:00:07Z' })];
  expect(trials.map(trial => trial.comparison.sections[0].evaluation_pairs[0])).toMatchObject([
    { left_evaluation_id: 'single-repeat-1-evaluation', right_evaluation_id: 'standard-repeat-1-evaluation', quality_available: true },
    { left_evaluation_id: 'single-repeat-2-evaluation', right_evaluation_id: 'standard-repeat-2-evaluation', quality_available: true },
  ]);
  const summary = summarizePairedReleaseEvidence(trials);
  expect(summary).toMatchObject({
    controlled: true,
    refusal_reasons: [],
    trials_total: 2,
    modes: {
      single_pass: { gap_extraction: { trials: 2, latency_ms: { min: 2000, max: 2000, range: 0, observed_trial_count: 2 }, cost_usd: { known_total: 0, known_call_count: 2, zero_cost_call_count: 2, unknown_call_count: 0, observed_trial_count: 2, missing_call_history_count: 0 }, provisional_reference: { matches: 2, false_positives: 2, misses: 2 } } },
      standard: { gap_extraction: { trials: 2, latency_ms: { min: 5000, max: 7000, range: 2000, observed_trial_count: 2 }, cost_usd: { known_total: null, known_call_count: 0, zero_cost_call_count: 0, unknown_call_count: 2, observed_trial_count: 2, missing_call_history_count: 0 }, provisional_reference: { matches: 4, false_positives: 0, misses: 0 } } },
    },
  });
  expect(summary.modes.standard?.gap_extraction?.observations).toEqual([
    expect.objectContaining({ trial_id: 'repeat-1', latency_ms: 5000, generation_cost_usd: expect.objectContaining({ known_total: null, missing_call_history: false }) }),
    expect.objectContaining({ trial_id: 'repeat-2', latency_ms: 7000, generation_cost_usd: expect.objectContaining({ known_total: null, missing_call_history: false }) }),
  ]);
});

it('refuses incomplete or incomparable saved pairs rather than averaging them', () => {
  expect(summarizePairedReleaseEvidence([pair('repeat-1', {}, { sourceText: 'Different synthetic sources.' }), pair('repeat-2')])).toMatchObject({
    controlled: false,
    refusal_reasons: expect.arrayContaining(['repeat-1: sources']),
    trials_total: 2,
    modes: {},
  });
});

it('refuses pairs with different stage coverage rather than reporting a partial repeat as complete', () => {
  const incomplete = pair('repeat-2');
  incomplete.comparison.sections = [];
  expect(summarizePairedReleaseEvidence([pair('repeat-1'), incomplete])).toMatchObject({
    controlled: false,
    refusal_reasons: ['repeat-2: section set differs from the other controlled pairs'],
    modes: {},
  });
});

it('refuses a repeat that reuses immutable execution evidence under a new trial label', () => {
  const reused = { ...pair('repeat-1'), trial_id: 'repeat-2' };

  expect(summarizePairedReleaseEvidence([pair('repeat-1'), reused])).toMatchObject({
    controlled: false,
    refusal_reasons: ['repeat-2: execution evidence was already used by another trial'],
    modes: {},
  });
});

it('refuses repeats whose frozen cohort identity drifts', () => {
  const newCohort = { sourceText: 'New synthetic evidence questions A, B and C.' };
  const drifted = pair('repeat-2', newCohort, newCohort);
  expect(drifted.comparison.compatibility.controlled).toBe(true);

  expect(summarizePairedReleaseEvidence([pair('repeat-1'), drifted])).toMatchObject({
    controlled: false,
    refusal_reasons: ['repeat-2: frozen cohort, reference, evaluator, or proposer route differs from the other controlled pairs'],
    modes: {},
  });
});

it('refuses an absent or single-pair release study', () => {
  expect(summarizePairedReleaseEvidence([])).toMatchObject({
    controlled: false,
    refusal_reasons: ['At least two distinct complete pairs are required.'],
  });
  expect(summarizePairedReleaseEvidence([pair('repeat-1')])).toMatchObject({
    controlled: false,
    refusal_reasons: ['At least two distinct complete pairs are required.'],
  });
});

it('refuses a pair whose proposer snapshots differ between modes', () => {
  const mismatched = pair('repeat-1', {}, { adjustRoutes: routes => { routes.proposer = savedRoute(0.5); } });
  expect(mismatched.comparison.compatibility.controlled).toBe(true);

  expect(summarizePairedReleaseEvidence([mismatched, pair('repeat-2')])).toMatchObject({
    controlled: false,
    refusal_reasons: ['repeat-1: proposer route differs between modes'],
  });
});

it('marks absent call history as missing rather than zero cost', () => {
  const missing = pair('repeat-2', { costs: [] });
  const summary = summarizePairedReleaseEvidence([pair('repeat-1'), missing]);

  expect(summary.modes.single_pass?.gap_extraction?.cost_usd).toMatchObject({
    known_total: null,
    missing_call_history_count: 1,
    observed_trial_count: 1,
  });
});

it.each([
  ['missing', () => undefined],
  ['empty', () => ({})],
  ['incomplete', (route: FrozenRoute) => ({ ...route, actual_temperature: undefined })],
] as const)('refuses two arms with %s proposer snapshots', (_case, invalidSnapshot) => {
  const options: SideOptions = { adjustRoutes: routes => {
    Object.assign(routes, { proposer: invalidSnapshot(routes.proposer!) });
  } };
  const trials = [pair('repeat-1', options, options), pair('repeat-2', options, options)];
  expect(trials.every(trial => trial.comparison.compatibility.controlled)).toBe(true);

  expect(summarizePairedReleaseEvidence(trials)).toMatchObject({
    controlled: false,
    refusal_reasons: [
      'repeat-1: gap_extraction: missing or incomplete proposer route snapshot',
      'repeat-2: gap_extraction: missing or incomplete proposer route snapshot',
    ],
    modes: {},
  });
});

it.each([
  { scenario: 'two zero-dollar calls', costs: [0, 0], total: 1, known: 3, zeros: 2, unknown: 0 },
  { scenario: 'a zero-dollar call and a paid call', costs: [0, 0.5], total: 1.5, known: 3, zeros: 1, unknown: 0 },
  { scenario: 'a zero-dollar call and an unknown call', costs: [0, null], total: null, known: 2, zeros: 1, unknown: 1 },
])('counts known zero calls in a repeat with $scenario', ({ costs, total, known, zeros, unknown }) => {
  const summary = summarizePairedReleaseEvidence([
    pair('repeat-1', {}, { costs }),
    pair('repeat-2', {}, { costs: [1] }),
  ]);

  expect(summary.controlled).toBe(true);
  expect(summary.modes.standard?.gap_extraction?.cost_usd).toMatchObject({
    known_total: total, known_call_count: known, zero_cost_call_count: zeros, unknown_call_count: unknown,
  });
  expect(summary.modes.standard?.gap_extraction?.observations.map(
    observation => observation.generation_cost_usd.zero_cost_call_count,
  )).toEqual([zeros, 0]);
});
