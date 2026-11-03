/** Compare immutable saved trials and evaluator histories without generating or scoring output. */
import { z } from 'zod';
import type { Execution } from './execution-store';
import type { Evaluation } from './evaluation-store';
import { SECTION_DEPENDENCIES, executionRouteSchema } from './execution-schema';
import { evaluatorReplySchema, sectionEvaluatorSchema } from './evaluation-schema';
import { profileInputSchema, criterionSchema, effectiveCriteria } from './profile-schema';
import { evaluationOutputItems } from './evaluation-scoring';
import type { FrozenRoute } from './routes';
import { gapExtractModule } from '@/modules/stages/s2-gap-extract/module';
import { tacticExtractModule } from '@/modules/stages/s3-tactic-extract/module';
import { kgMappingModule } from '@/modules/stages/s4-kg-mapping/module';
import { partialSplitModule } from '@/modules/stages/s6-partial-split/module';
import { sectionSchema, type DevelopmentSection } from './schema';
import { developmentOutputIdentity } from './stage-execution';
export type ComparisonSide = { execution: Execution; evaluations: Evaluation[] };
export type ComparisonCompatibility = {
  controlled: boolean;
  blockers: string[];
  missing_evidence: string[];
  varying_factors: string[];
};
export type ComparisonEvaluationPair = {
  left_evaluation_id: string; right_evaluation_id: string;
  compatibility: ComparisonCompatibility; quality_available: boolean;
};
export type ComparisonSection = {
  section: DevelopmentSection; compatibility: ComparisonCompatibility;
  evaluation_pairs: ComparisonEvaluationPair[];
};
export type ComparisonResult = {
  left: ComparisonSide; right: ComparisonSide;
  compatibility: ComparisonCompatibility; sections: ComparisonSection[]; trial_note: string;
};
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
function metadata(): ComparisonCompatibility {
  return { controlled: false, blockers: [], missing_evidence: [], varying_factors: [] };
}
function finish(value: ComparisonCompatibility): ComparisonCompatibility {
  value.blockers = [...new Set(value.blockers)]; value.missing_evidence = [...new Set(value.missing_evidence)]; value.varying_factors = [...new Set(value.varying_factors)];
  value.controlled = !value.blockers.length && !value.missing_evidence.length;
  return value;
}
function merge(target: ComparisonCompatibility, source: ComparisonCompatibility, prefix = '') {
  target.blockers.push(...source.blockers.map(reason => prefix + reason));
  target.missing_evidence.push(...source.missing_evidence.map(reason => prefix + reason));
  target.varying_factors.push(...source.varying_factors);
}
function compareField(value: ComparisonCompatibility, name: string, left: unknown, right: unknown, varying = false) {
  if (left == null || right == null) value.missing_evidence.push(name);
  else if (canonical(left) !== canonical(right)) (varying ? value.varying_factors : value.blockers).push(name);
}
function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
function validFrozenRoute(route: FrozenRoute | null | undefined): boolean {
  // Requested settings use the existing route schema; actual identity belongs to the saved resolution.
  return Boolean(route && nonempty(route.requested?.provider_id) && nonempty(route.requested?.model)
    && completeSnapshot(executionRouteSchema, route.requested) && nonempty(route.actual?.provider_id)
    && nonempty(route.actual?.model) && Number.isFinite(route.actual?.params?.temperature)
    && Number.isFinite(route.actual?.params?.max_tokens)
    && (route.actual_temperature === null || Number.isFinite(route.actual_temperature)));
}
/** Validate saved settings without allowing input-schema defaults to repair missing evidence. */
function completeSnapshot(schema: z.ZodType, raw: unknown): boolean {
  const parsed = schema.safeParse(raw);
  return parsed.success && canonical(parsed.data) === canonical(raw);
}
const savedText = z.string().trim().min(1);
const savedRatio = z.object({ numerator: z.number().int().nonnegative(), denominator: z.number().int().nonnegative(), value: z.number().finite().min(0).max(1).nullable() }).strict();
const savedResultSchema = z.object({
  checks: z.object({ passed: z.boolean(), items: z.array(z.object({ id: savedText, passed: z.boolean(), detail: savedText }).strict()) }).strict(),
  rubric: z.object({ label: z.literal('provisional_ai_assessment'), score: z.number().finite().min(0).max(4),
    criteria: z.array(evaluatorReplySchema.shape.criteria.element.extend({ threshold_met: z.boolean().nullable() })), factual_checks_passed: z.boolean() }).strict().nullable(),
  reference: z.object({ label: z.literal('provisional_semantic_reference'), status: z.enum(['scored', 'unscored']), reasons: z.array(savedText),
    precision: savedRatio, recall: savedRatio, matches: evaluatorReplySchema.shape.matches,
    unmatched_output_ids: evaluatorReplySchema.shape.unmatched_output_ids, unmatched_reference_ids: evaluatorReplySchema.shape.unmatched_reference_ids }).strict(),
}).strict();
/** Require complete one-to-one accounting; order is not part of an identity set. */
function exactIdentities(actual: string[], expected: string[]): boolean {
  return actual.length === expected.length && new Set(actual).size === actual.length && actual.every(id => expected.includes(id));
}
/** Check saved evidence against its frozen contract, retaining observed failed factual checks. */
function validSavedResult(evaluation: Evaluation): boolean {
  const parsed = savedResultSchema.safeParse(evaluation.result);
  if (!parsed.success) return false;
  const { checks, rubric, reference } = parsed.data, manifest = evaluation.manifest;
  const method = manifest.config?.sections?.[manifest.section]?.method;
  if (!Array.isArray(manifest.criteria) || !manifest.criteria.every(criterion => criterionSchema.safeParse(criterion).success)) return false;
  if (!exactIdentities(checks.items.map(item => item.id), ['immutable_identity', 'domain_records'])
    || checks.passed !== checks.items.every(item => item.passed)) return false;
  const rubricRequested = method === 'rubric' || method === 'rubric_and_reference';
  if (rubricRequested) {
    if (!rubric || !Array.isArray(manifest.criteria) || !manifest.criteria.length
      || !exactIdentities(rubric.criteria.map(item => item.criterion_id), manifest.criteria.map(item => item.id))
      || rubric.factual_checks_passed !== checks.passed) return false;
    let weightedScore = 0;
    for (const judgment of rubric.criteria) {
      const criterion = manifest.criteria.find(item => item.id === judgment.criterion_id)!;
      if (judgment.threshold_met !== (criterion.threshold === undefined ? null : judgment.score >= criterion.threshold)) return false;
      weightedScore += judgment.score * criterion.weight;
    }
    const totalWeight = manifest.criteria.reduce((total, criterion) => total + criterion.weight, 0);
    if (!(totalWeight > 0) || rubric.score !== weightedScore / totalWeight) return false;
  } else if (rubric !== null) return false;
  if (!Array.isArray(manifest.output?.candidates) || !manifest.output.candidates.every(candidate => candidate !== null && typeof candidate === 'object') || !Array.isArray(manifest.reference_items) || !Array.isArray(manifest.reference_issues)) return false;
  const outputIds = evaluationOutputItems(manifest).map(item => item.id), referenceIds = manifest.reference_items.map(item => item?.id);
  if (!referenceIds.every(nonempty) || new Set(referenceIds).size !== referenceIds.length) return false;
  const referenceRequested = method === 'reference' || method === 'rubric_and_reference';
  if (manifest.reference_requested !== referenceRequested) return false;
  const enabled = referenceRequested && !manifest.reference_issues.length && outputIds.length > 0 && referenceIds.length > 0;
  if (reference.status !== (enabled ? 'scored' : 'unscored')
    || !exactIdentities([...reference.matches.map(item => item.output_id), ...reference.unmatched_output_ids], outputIds)
    || !exactIdentities([...reference.matches.map(item => item.reference_id), ...reference.unmatched_reference_ids], referenceIds)) return false;
  const reasons = !referenceRequested ? ['Reference method not selected.'] : [
    ...manifest.reference_issues, ...(!referenceIds.length ? ['No compatible expected answers.'] : []),
    ...(!outputIds.length ? ['No output records; precision denominator is empty.'] : []),
  ];
  if (canonical(reference.reasons) !== canonical(reasons) || (!enabled && reference.matches.length)) return false;
  const count = reference.matches.length;
  const precisionValue = enabled ? count / outputIds.length : null;
  const recallValue = enabled ? count / referenceIds.length
    : !outputIds.length && referenceRequested && referenceIds.length > 0 && !manifest.reference_issues.length ? 0 : null;
  return reference.precision.numerator === count && reference.precision.denominator === outputIds.length && reference.precision.value === precisionValue
    && reference.recall.numerator === count && reference.recall.denominator === referenceIds.length && reference.recall.value === recallValue;
}
function documentIdentity(documents: Evaluation['manifest']['sources'] | undefined, references = false) {
  if (!Array.isArray(documents) || (!references && !documents.length)) return undefined;
  if (documents.some(document => !nonempty(document?.id) || !nonempty(document.sha256) || !nonempty(document.parsed_sha256) || document.parsed === undefined || !nonempty(document.parser?.name) || !nonempty(document.parser?.version) || document.parsed === null || (references && (!document.section || !document.source_document_ids || !document.compatibility || !document.review_status)))) return undefined;
  return documents.map(document => ({ id: document.id, sha256: document.sha256, parsed_sha256: document.parsed_sha256, parsed: document.parsed, parser: document.parser,
    ...(references ? { section: document.section, source_document_ids: document.source_document_ids, compatibility: document.compatibility, review_status: document.review_status } : {}),
  })).sort((a, b) => a.id.localeCompare(b.id));
}
function validOutput(attempt: Execution['sections'][number] | undefined) {
  const result = attempt?.result;
  if (!result || result.section !== attempt.section || typeof result.output_id !== 'string' || !nonempty(result.source_identity) || !result.prerequisite_ids || !Array.isArray(result.candidates) || result.output === undefined || result.output === null) return false;
  try {
    if (result.output_id !== developmentOutputIdentity(result)) return false;
    if (attempt.section === 'gap_extraction') return gapExtractModule.outputSchema.safeParse(result.output).success;
    if (attempt.section === 'tactic_extraction') return tacticExtractModule.outputSchema.safeParse(result.output).success;
    if (attempt.section === 'matching_coverage') return kgMappingModule.outputSchema.safeParse(result.output).success;
    // The development adapter aggregates per-gap proposals, unlike the stage's single proposal.
    const output = result.output as { proposals?: unknown[] };
    return Array.isArray(output.proposals) && output.proposals.every(proposal => proposal !== null
      && partialSplitModule.outputSchema.safeParse({ mode: 'llm', proposal, applied: false, edit_id: null }).success);
  } catch { return false; }
}
function bound(side: ComparisonSide): ComparisonSide {
  const attempts = side.execution.sections ?? [];
  return { execution: side.execution, evaluations: side.evaluations.filter(evaluation => {
    const manifest = evaluation.manifest;
    return evaluation.experiment_id === side.execution.experiment_id && manifest?.execution_id === side.execution.id && attempts.some(attempt => attempt.id === manifest.attempt_id && attempt.section === manifest.section && attempt.result?.output_id === manifest.output_id);
  }) };
}
function evaluationCompatibility(left: Evaluation, right: Evaluation): ComparisonCompatibility {
  const value = metadata(), a = left.manifest, b = right.manifest, section = a.section;
  compareField(value, 'evaluation_section', section, b.section);
  // Complete frozen profiles include criterion weights, thresholds, and section overrides.
  compareField(value, 'profile', a.profile, b.profile);
  compareField(value, 'criteria', a.criteria, b.criteria);
  compareField(value, 'evaluator_configuration', a.config?.sections?.[section], b.config?.sections?.[section]);
  if (a.route !== null || b.route !== null) compareField(value, 'evaluator_route', a.route, b.route);
  compareField(value, 'evaluator_version', { version: a.version, code_identity: a.code_identity }, { version: b.version, code_identity: b.code_identity });
  if (a.version !== 1 || b.version !== 1 || !nonempty(a.code_identity) || !nonempty(b.code_identity)) value.missing_evidence.push('evaluator_version');
  compareField(value, 'evaluation_sources', documentIdentity(a.sources), documentIdentity(b.sources));
  compareField(value, 'references', documentIdentity(a.references, true), documentIdentity(b.references, true));
  compareField(value, 'reference_configuration', { requested: a.reference_requested, items: a.reference_items, issues: a.reference_issues }, { requested: b.reference_requested, items: b.reference_items, issues: b.reference_issues });
  for (const [label, evaluation] of [['left', left], ['right', right]] as const) {
    const manifest = evaluation.manifest, method = manifest.config?.sections?.[manifest.section]?.method;
    if (!nonempty(manifest.profile?.id) || !Number.isInteger(manifest.profile?.version) || manifest.profile.version < 1 || !completeSnapshot(profileInputSchema, { name: manifest.profile?.name, defaults: manifest.profile?.defaults, sections: manifest.profile?.sections }) || !Array.isArray(manifest.criteria) || !manifest.criteria.length || !manifest.criteria.every(criterion => completeSnapshot(criterionSchema, criterion)) || canonical(manifest.criteria) !== canonical(effectiveCriteria(manifest.profile, manifest.section)) || !method || !completeSnapshot(sectionEvaluatorSchema, manifest.config?.sections?.[manifest.section]) || !Array.isArray(manifest.references) || !Array.isArray(manifest.reference_items) || !Array.isArray(manifest.reference_issues) || typeof manifest.reference_requested !== 'boolean') value.missing_evidence.push(`${label}_evaluation_metadata`);
    if (evaluation.status !== 'succeeded' || !evaluation.result) value.missing_evidence.push(`${label}_evaluation_${evaluation.status}`);
    else {
      if (!validSavedResult(evaluation)) value.missing_evidence.push(`${label}_evaluation_result`);
      if (['rubric', 'rubric_and_reference'].includes(method) && (!evaluation.result.rubric || !Number.isFinite(evaluation.result.rubric.score))) value.missing_evidence.push(`${label}_rubric_unscored`);
      if (['reference', 'rubric_and_reference'].includes(method) && evaluation.result.reference?.status !== 'scored') value.missing_evidence.push(`${label}_reference_unscored`);
    }
    if (manifest.reference_issues?.length) value.blockers.push(`${label}_reference_issues`);
    if (['rubric', 'reference', 'rubric_and_reference'].includes(method) && !validFrozenRoute(manifest.route)) value.missing_evidence.push(`${label}_evaluator_route`);
  }
  return finish(value);
}
/**
 * Build explicit compatibility for exact saved execution/attempt/output bindings.
 *
 * Parameters
 * ----------
 * left, right : ComparisonSide
 *     Immutable executions and their persisted evaluation histories. No draft settings are used.
 *
 * Returns
 * -------
 * ComparisonResult
 *     All bound history and all evaluation pairs; missing evidence prevents a controlled claim.
 */
export function buildComparison(left: ComparisonSide, right: ComparisonSide): ComparisonResult {
  left = bound(left); right = bound(right);
  const compatibility = metadata(), a = left.execution.manifest, b = right.execution.manifest;
  compareField(compatibility, 'sources', documentIdentity(a?.sources), documentIdentity(b?.sources));
  compareField(compatibility, 'target', a?.target, b?.target);
  compareField(compatibility, 'generation_mode', a?.config?.mode, b?.config?.mode, true);
  compareField(compatibility, 'generation_routes', a?.routes, b?.routes, true);
  compareField(compatibility, 'generation_code', a?.code_identity, b?.code_identity);
  if (!nonempty(a?.code_identity) || !nonempty(b?.code_identity)) compatibility.missing_evidence.push('generation_code');
  const trialCompatibility = structuredClone(compatibility);
  const sections: ComparisonSection[] = [];
  for (const section of sectionSchema.options) {
    const la = left.execution.sections?.find(attempt => attempt.section === section), ra = right.execution.sections?.find(attempt => attempt.section === section);
    if (!la && !ra) continue;
    const meta = metadata();
    if (!la || !ra) meta.blockers.push('section_missing');
    if (!validOutput(la) || !validOutput(ra)) meta.missing_evidence.push('valid_immutable_output');
    compareField(meta, 'source_lineage', la?.result?.source_identity, ra?.result?.source_identity);
    compareField(meta, 'prerequisite_outputs', la?.result?.prerequisite_ids, ra?.result?.prerequisite_ids);
    for (const attempt of [la, ra]) {
      if (SECTION_DEPENDENCIES[section].some(dependency => !attempt?.result?.prerequisite_ids?.[dependency])) meta.missing_evidence.push('prerequisite_outputs');
      if (attempt?.status !== 'succeeded' || attempt.result?.generation_status !== 'succeeded') meta.missing_evidence.push('successful_generation');
    }
    compareField(meta, 'module', a?.modules?.[section], b?.modules?.[section]);
    compareField(meta, 'prompt', a?.prompts?.[section], b?.prompts?.[section]);
    for (const manifest of [a, b]) {
      if (!nonempty(manifest?.modules?.[section]?.id) || !nonempty(manifest?.modules?.[section]?.version)) meta.missing_evidence.push('module');
      if (!nonempty(manifest?.prompts?.[section]?.id) || typeof manifest?.prompts?.[section]?.instruction !== 'string') meta.missing_evidence.push('prompt');
    }
    const le = left.evaluations.filter(e => e.manifest.attempt_id === la?.id), re = right.evaluations.filter(e => e.manifest.attempt_id === ra?.id);
    if (!le.length || !re.length) meta.missing_evidence.push('bound_evaluations');
    const evaluation_pairs = le.flatMap(l => re.map(r => {
      const pair = evaluationCompatibility(l, r);
      // Also check each evaluator snapshot against its own selected immutable output/lineage.
      for (const [evaluation, execution, attempt] of [[l, left.execution, la], [r, right.execution, ra]] as const) {
        compareField(pair, 'evaluation_output_binding', evaluation.manifest.output, attempt?.result);
        compareField(pair, 'evaluation_generation_binding', evaluation.manifest.generation, execution.manifest);
      }
      merge(pair, meta); merge(pair, trialCompatibility); finish(pair);
      return { left_evaluation_id: l.id, right_evaluation_id: r.id, compatibility: pair, quality_available: pair.controlled };
    }));
    for (const pair of evaluation_pairs) merge(meta, pair.compatibility);
    finish(meta); merge(compatibility, meta, `${section}:`);
    sections.push({ section, compatibility: meta, evaluation_pairs });
  }
  if (!sections.length) compatibility.missing_evidence.push('sections');
  return { left, right, compatibility: finish(compatibility), sections, trial_note: 'Each saved execution is one trial. These observations do not establish statistical superiority.' };
}
