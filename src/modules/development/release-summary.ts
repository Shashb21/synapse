/** Deterministically summarize repeated, already-saved paired Development evidence. */
import { validFrozenRoute, type ComparisonResult } from './comparison';
import type { DevelopmentSection } from './schema';

type Mode = 'single_pass' | 'standard';
type CostSummary = { known_total: number | null; known_call_count: number; zero_cost_call_count: number; unknown_call_count: number; observed_trial_count: number; missing_call_history_count: number };
type RepeatObservation = {
  trial_id: string;
  latency_ms: number | null;
  generation_cost_usd: {
    known_total: number | null;
    known_call_count: number;
    zero_cost_call_count: number;
    unknown_call_count: number;
    missing_call_history: boolean;
  };
  provisional_reference: { matches: number; false_positives: number; misses: number };
};
type SectionSummary = {
  trials: number;
  latency_ms: { min: number | null; max: number | null; range: number | null; observed_trial_count: number };
  cost_usd: CostSummary;
  provisional_reference: { matches: number; false_positives: number; misses: number };
  observations: RepeatObservation[];
};
export type PairedReleaseEvidence = { trial_id: string; comparison: ComparisonResult };
export type PairedReleaseSummary = {
  controlled: boolean;
  refusal_reasons: string[];
  trials_total: number;
  modes: Partial<Record<Mode, Partial<Record<DevelopmentSection, SectionSummary>>>>;
};
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

function callCost(call: { receipt?: { cost_usd?: number | null } | null; failure_accounting?: { cost_usd?: number | null } | null }): number | null {
  return call.receipt?.cost_usd ?? call.failure_accounting?.cost_usd ?? null;
}
function elapsed(startedAt: string | null | undefined, finishedAt: string | null | undefined): number | null {
  if (!startedAt || !finishedAt) return null;
  const start = Date.parse(startedAt), finish = Date.parse(finishedAt);
  return Number.isFinite(start) && Number.isFinite(finish) && finish >= start ? finish - start : null;
}
/** Stable study controls that must remain fixed across independently saved repeats. */
function repeatControlIdentity(comparison: ComparisonResult): string {
  const controls = (side: ComparisonResult['left']) => ({
    mode: side.execution.manifest.config.mode,
    generation_config: side.execution.manifest.config,
    generation_code: side.execution.manifest.code_identity,
    modules: side.execution.manifest.modules,
    prompts: side.execution.manifest.prompts,
    routes: side.execution.manifest.routes,
    prerequisites: side.execution.manifest.prerequisites,
  });
  const left = comparison.left;
  return canonical({
    sources: left.execution.manifest.sources,
    target: left.execution.manifest.target,
    modes: { single_pass: controls(comparison.left), standard: controls(comparison.right) },
    evaluations: left.evaluations.map(evaluation => ({
      section: evaluation.manifest?.section,
      profile: evaluation.manifest?.profile,
      configuration: evaluation.manifest?.config?.sections?.[evaluation.manifest?.section],
      route: evaluation.manifest?.route,
      references: evaluation.manifest?.references,
      reference_items: evaluation.manifest?.reference_items,
      code_identity: evaluation.manifest?.code_identity,
    })).sort((a, b) => canonical(a).localeCompare(canonical(b))),
  });
}
function reasons(trial: PairedReleaseEvidence): string[] {
  const { comparison } = trial;
  const all = [...comparison.compatibility.blockers, ...comparison.compatibility.missing_evidence];
  for (const section of comparison.sections) {
    all.push(...section.compatibility.blockers.map(reason => `${section.section}: ${reason}`));
    all.push(...section.compatibility.missing_evidence.map(reason => `${section.section}: ${reason}`));
  }
  return [...new Set(all)].map(reason => `${trial.trial_id}: ${reason}`);
}

/**
 * Aggregate only controlled saved comparisons; never infer a missing cost as zero.
 *
 * Parameters
 * ----------
 * trials:
 *     Saved pair comparisons produced by `buildComparison`. Each pair must contain exactly
 *     one `single_pass` execution and one `standard` execution.
 *
 * Returns
 * -------
 * PairedReleaseSummary
 *     Deterministic per-mode/per-section descriptive accounting. A false `controlled` result
 *     is a refusal to aggregate incomplete or incomparable evidence, not a quality result.
 */
export function summarizePairedReleaseEvidence(trials: PairedReleaseEvidence[]): PairedReleaseSummary {
  const refusalReasons: string[] = [];
  if (trials.length < 2) return { controlled: false, refusal_reasons: ['At least two distinct complete pairs are required.'], trials_total: trials.length, modes: {} };
  const seen = new Set<string>();
  const usedExecutionIds = new Set<string>();
  let expectedControls: string | undefined;
  let expectedSections: string | undefined;
  const grouped = new Map<string, RepeatObservation[]>();
  for (const trial of trials) {
    if (!trial.trial_id.trim() || seen.has(trial.trial_id)) {
      refusalReasons.push(`${trial.trial_id || '(missing trial id)'}: duplicate or missing trial id`);
      continue;
    }
    seen.add(trial.trial_id);
    const comparison = trial.comparison;
    const executionIds = [comparison.left.execution.id, comparison.right.execution.id];
    if (executionIds.some(id => !id || usedExecutionIds.has(id))) {
      refusalReasons.push(`${trial.trial_id}: execution evidence was already used by another trial`);
      continue;
    }
    executionIds.forEach(id => usedExecutionIds.add(id));
    const leftMode = comparison.left.execution.manifest.config.mode;
    const rightMode = comparison.right.execution.manifest.config.mode;
    if (leftMode !== 'single_pass' || rightMode !== 'standard') {
      refusalReasons.push(`${trial.trial_id}: expected single_pass left and standard right`);
      continue;
    }
    if (!comparison.compatibility.controlled || comparison.sections.some(section => !section.compatibility.controlled)) {
      refusalReasons.push(...reasons(trial));
      continue;
    }
    const leftRoutes = comparison.left.execution.manifest.routes;
    const rightRoutes = comparison.right.execution.manifest.routes;
    const incompleteProposer = comparison.sections.find(({ section }) =>
      !validFrozenRoute(leftRoutes?.[section]?.proposer) || !validFrozenRoute(rightRoutes?.[section]?.proposer));
    if (incompleteProposer) {
      refusalReasons.push(`${trial.trial_id}: ${incompleteProposer.section}: missing or incomplete proposer route snapshot`);
      continue;
    }
    if (comparison.sections.some(({ section }) =>
      canonical(leftRoutes[section].proposer) !== canonical(rightRoutes[section].proposer))) {
      refusalReasons.push(`${trial.trial_id}: proposer route differs between modes`);
      continue;
    }
    const sectionIdentity = comparison.sections.map(section => section.section).sort().join(',');
    if (!sectionIdentity || (expectedSections !== undefined && sectionIdentity !== expectedSections)) {
      refusalReasons.push(`${trial.trial_id}: section set differs from the other controlled pairs`);
      continue;
    }
    expectedSections ??= sectionIdentity;
    const controls = repeatControlIdentity(comparison);
    if (expectedControls !== undefined && controls !== expectedControls) {
      refusalReasons.push(`${trial.trial_id}: frozen cohort, reference, evaluator, or proposer route differs from the other controlled pairs`);
      continue;
    }
    expectedControls ??= controls;
    for (const [mode, side] of [['single_pass', comparison.left], ['standard', comparison.right]] as const) {
      for (const section of comparison.sections) {
        const attempt = side.execution.sections.find(item => item.section === section.section);
        const pair = [...section.evaluation_pairs].sort((a, b) => `${a.left_evaluation_id}:${a.right_evaluation_id}`.localeCompare(`${b.left_evaluation_id}:${b.right_evaluation_id}`)).find(item => item.quality_available);
        const evaluationId = mode === 'single_pass' ? pair?.left_evaluation_id : pair?.right_evaluation_id;
        const evaluation = side.evaluations.find(item => item.id === evaluationId);
        const reference = evaluation?.result?.reference;
        if (!attempt || !pair || reference?.status !== 'scored') {
          refusalReasons.push(`${trial.trial_id}: ${section.section}: missing controlled reference evidence`);
          continue;
        }
        const key = `${mode}:${section.section}`;
        const duration = elapsed(attempt.started_at, attempt.finished_at);
        const calls = side.execution.calls.filter(call => call.section_id === attempt.id);
        const costs = calls.map(callCost);
        const known = costs.filter((cost): cost is number => cost !== null);
        grouped.set(key, [...(grouped.get(key) ?? []), {
          trial_id: trial.trial_id,
          latency_ms: duration,
          generation_cost_usd: {
            known_total: calls.length && known.length === costs.length ? known.reduce((sum, cost) => sum + cost, 0) : null,
            known_call_count: known.length,
            zero_cost_call_count: known.filter(cost => cost === 0).length,
            unknown_call_count: costs.length - known.length,
            missing_call_history: calls.length === 0,
          },
          provisional_reference: { matches: reference.matches.length, false_positives: reference.unmatched_output_ids.length, misses: reference.unmatched_reference_ids.length },
        }]);
      }
    }
  }
  if (refusalReasons.length) return { controlled: false, refusal_reasons: [...new Set(refusalReasons)], trials_total: trials.length, modes: {} };
  const modes: PairedReleaseSummary['modes'] = {};
  for (const [key, unsorted] of grouped) {
    const [mode, section] = key.split(':') as [Mode, DevelopmentSection];
    const observations = [...unsorted].sort((a, b) => a.trial_id.localeCompare(b.trial_id));
    const latencies = observations.flatMap(item => item.latency_ms === null ? [] : [item.latency_ms]);
    const min = latencies.length ? Math.min(...latencies) : null;
    const max = latencies.length ? Math.max(...latencies) : null;
    const costs = observations.flatMap(item => item.generation_cost_usd.known_total === null ? [] : [item.generation_cost_usd.known_total]);
    const knownCalls = observations.reduce((sum, item) => sum + item.generation_cost_usd.known_call_count, 0);
    const zeroCostCalls = observations.reduce((sum, item) => sum + item.generation_cost_usd.zero_cost_call_count, 0);
    const unknownCalls = observations.reduce((sum, item) => sum + item.generation_cost_usd.unknown_call_count, 0);
    const missingHistory = observations.filter(item => item.generation_cost_usd.missing_call_history).length;
    const provisional = observations.reduce((sum, item) => ({ matches: sum.matches + item.provisional_reference.matches, false_positives: sum.false_positives + item.provisional_reference.false_positives, misses: sum.misses + item.provisional_reference.misses }), { matches: 0, false_positives: 0, misses: 0 });
    modes[mode] ??= {};
    modes[mode]![section] = {
      trials: trials.length,
      latency_ms: { min, max, range: min === null || max === null ? null : max - min, observed_trial_count: latencies.length },
      cost_usd: { known_total: costs.length === observations.length ? costs.reduce((sum, cost) => sum + cost, 0) : null, known_call_count: knownCalls, zero_cost_call_count: zeroCostCalls, unknown_call_count: unknownCalls, observed_trial_count: observations.length - missingHistory, missing_call_history_count: missingHistory },
      provisional_reference: provisional,
      observations,
    };
  }
  return { controlled: true, refusal_reasons: [], trials_total: trials.length, modes };
}
