/** Deterministically summarize repeated, already-saved paired Development evidence. */
import type { ComparisonResult } from './comparison';
import type { DevelopmentSection } from './schema';

type Mode = 'single_pass' | 'standard';
type CostSummary = { known_total: number | null; known_call_count: number; zero_cost_call_count: number; unknown_call_count: number };
type SectionSummary = {
  trials: number;
  latency_ms: { min: number | null; max: number | null; range: number | null };
  cost_usd: CostSummary;
  reference: { matches: number; false_positives: number; misses: number };
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
  const left = comparison.left;
  return canonical({
    sources: left.execution.manifest.sources,
    target: left.execution.manifest.target,
    generation_code: left.execution.manifest.code_identity,
    proposer_routes: Object.fromEntries(comparison.sections.map(({ section }) => [section, left.execution.manifest.routes?.[section]?.proposer])),
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
  const seen = new Set<string>();
  const usedExecutionIds = new Set<string>();
  let expectedControls: string | undefined;
  let expectedSections: string | undefined;
  const grouped = new Map<string, { latencies: number[]; costs: (number | null)[]; matches: number; falsePositives: number; misses: number }>();
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
        const current = grouped.get(key) ?? { latencies: [], costs: [], matches: 0, falsePositives: 0, misses: 0 };
        const duration = elapsed(attempt.started_at, attempt.finished_at);
        if (duration !== null) current.latencies.push(duration);
        current.costs.push(...side.execution.calls.filter(call => call.section_id === attempt.id).map(callCost));
        current.matches += reference.matches.length;
        current.falsePositives += reference.unmatched_output_ids.length;
        current.misses += reference.unmatched_reference_ids.length;
        grouped.set(key, current);
      }
    }
  }
  if (refusalReasons.length) return { controlled: false, refusal_reasons: [...new Set(refusalReasons)], trials_total: trials.length, modes: {} };
  const modes: PairedReleaseSummary['modes'] = {};
  for (const [key, value] of grouped) {
    const [mode, section] = key.split(':') as [Mode, DevelopmentSection];
    const known = value.costs.filter((cost): cost is number => cost !== null);
    const min = value.latencies.length ? Math.min(...value.latencies) : null;
    const max = value.latencies.length ? Math.max(...value.latencies) : null;
    modes[mode] ??= {};
    modes[mode]![section] = {
      trials: trials.length,
      latency_ms: { min, max, range: min === null || max === null ? null : max - min },
      cost_usd: { known_total: known.length === value.costs.length ? known.reduce((sum, cost) => sum + cost, 0) : null, known_call_count: known.length, zero_cost_call_count: known.filter(cost => cost === 0).length, unknown_call_count: value.costs.length - known.length },
      reference: { matches: value.matches, false_positives: value.falsePositives, misses: value.misses },
    };
  }
  return { controlled: true, refusal_reasons: [], trials_total: trials.length, modes };
}
