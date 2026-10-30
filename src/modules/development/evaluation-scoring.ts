/** Deterministic validity and provisional semantic scoring, independent of reviewed benchmark scoring. */
import { z } from 'zod';
import { validateQuoteAgainstBlock } from '@/accuracy/store/quote-validator';
import { EVIDENCE_DOMAINS, TACTIC_STATUSES, TACTIC_TYPES, COVERAGE_DIMENSIONS } from '@/lib/iegp/enums';
import { countingCoverages } from '@/lib/iegp/engine';
import { developmentMappingCoverages, mappingTableRowSchema } from '@/modules/stages/s4-kg-mapping/module';
import { DevelopmentError } from './schema';
import { canonicalParsedJson, sha256 } from './documents';
import { developmentOutputIdentity } from './stage-execution';
import { evaluatorReplySchema } from './evaluation-schema';
import type { EvaluationManifest, EvaluationResult, FactualChecks, RatioMeasure } from './evaluation-store';
/** Stable semantic units explicitly identify the exact frozen row (or gap/tactic pair) being judged. */
export function evaluationOutputItems(manifest: Pick<EvaluationManifest, 'section' | 'output'>): { id: string; answer: unknown }[] {
  return manifest.output.candidates.flatMap((answer, index) => {
    if (manifest.section !== 'matching_coverage' || !Array.isArray(answer.mappings) || !answer.mappings.length) return [{ id: `candidate:${index}`, answer }];
    return answer.mappings.map((mapping, mappingIndex) => ({ id: `candidate:${index}:mapping:${mappingIndex}`, answer: { ...answer, mappings: [mapping] } }));
  });
}
/** Reuse source citation and domain validity gates; custom weights never control these checks. */
export function factualChecks(manifest: EvaluationManifest): FactualChecks {
  const items: FactualChecks['items'] = [];
  const check = (id: string, action: () => void, detail: string) => {
    try { action(); items.push({ id, passed: true, detail }); }
    catch (error) { items.push({ id, passed: false, detail: error instanceof Error ? error.message.slice(0, 600) : 'Validity check failed.' }); }
  };
  check('immutable_identity', () => {
    if (manifest.output.output_id !== manifest.output_id || developmentOutputIdentity(manifest.output) !== manifest.output_id || manifest.output.section !== manifest.section) throw new Error('Frozen output identity does not match.');
    if (manifest.sources.some(source => sha256(canonicalParsedJson(source.parsed)) !== source.parsed_sha256)) throw new Error('Frozen source parse identity does not match.');
  }, 'Output and source hashes match their immutable snapshots.');
  check('domain_records', () => {
    const state = manifest.output.local_state;
    const seen = new Set<string>();
    for (const raw of manifest.output.candidates) {
      if (manifest.section === 'gap_extraction' || manifest.section === 'tactic_extraction') {
        const common = z.object({ id: z.string().min(1), name: z.string().min(1), document_id: z.string().min(1), source_id: z.string().min(1), source_quote: z.string().min(1) });
        const row = (manifest.section === 'gap_extraction' ? common.extend({ statement: z.string().min(1), domain: z.enum(EVIDENCE_DOMAINS) }) : common.extend({ type: z.enum(TACTIC_TYPES), status: z.enum(TACTIC_STATUSES), evidence_question: z.string().min(1) })).parse(raw);
        if (seen.has(row.id)) throw new Error('Duplicate extracted record identity.'); seen.add(row.id);
        const source = manifest.sources.find(source => source.id === row.document_id && source.id === row.source_id);
        const parsed = z.object({ blocks: z.array(z.object({ text: z.string() })) }).parse(source?.parsed);
        if (!validateQuoteAgainstBlock({ block: { text: parsed.blocks.map(block => block.text).join(' ') }, quote: row.source_quote }).ok) throw new Error('Finding quotation is not present in the supplied source.');
      } else if (manifest.section === 'matching_coverage') {
        const row = mappingTableRowSchema.parse(raw);
        if (seen.has(row.gap_id) || new Set(row.mappings.map(m => m.tactic_id)).size !== row.mappings.length) throw new Error('Duplicate mapping identities.'); seen.add(row.gap_id);
        developmentMappingCoverages(structuredClone(state), [row], manifest.output.trace_id);
      } else {
        const row = z.object({ parent_gap_id: z.string().min(1), addressed_statement: z.string().min(1), open_statement: z.string().min(1), addressed_tactic_ids: z.array(z.string().min(1)).min(1), uncovered_dimensions: z.array(z.enum(COVERAGE_DIMENSIONS)).min(1), confidence: z.number().finite().min(0).max(100) }).parse(raw);
        if (seen.has(row.parent_gap_id) || !state.gaps.some(gap => gap.id === row.parent_gap_id)) throw new Error('Invalid split parent identity.'); seen.add(row.parent_gap_id);
        const allowed = countingCoverages(state.coverages.filter(c => c.gap_id === row.parent_gap_id && c.overall !== 'not_relevant' && c.overall !== 'unassessed'), state.tactics, state.expansions).map(c => c.tactic_id);
        if (new Set(row.addressed_tactic_ids).size !== row.addressed_tactic_ids.length || row.addressed_tactic_ids.some(id => !allowed.includes(id))) throw new Error('Split uses a tactic outside the counting mapped scope.');
      }
    }
  }, 'Required fields, domain values, citations and related record identities are valid.');
  return { passed: items.every(item => item.passed), items };
}
function ratio(numerator: number, denominator: number): RatioMeasure { return { numerator, denominator, value: denominator ? numerator / denominator : null }; }
function exactUnique(actual: string[], expected: string[], label: string): void {
  if (actual.length !== expected.length || new Set(actual).size !== actual.length || actual.some(id => !expected.includes(id))) throw new DevelopmentError(422, 'invalid_evaluator_reply', `${label} must cover every exact supplied identity once, without unknown IDs, duplicates or omissions.`);
}
/** Parse bounded judgments, reject missing identities and keep independent measures explicitly provisional. */
export function scoreEvaluation(manifest: EvaluationManifest, raw?: unknown): EvaluationResult {
  const method = manifest.config.sections[manifest.section].method;
  const rubricRequested = method === 'rubric' || method === 'rubric_and_reference';
  const referenceRequested = method === 'reference' || method === 'rubric_and_reference';
  const outputIds = evaluationOutputItems(manifest).map(item => item.id), referenceIds = manifest.reference_items.map(item => item.id);
  const referenceEnabled = referenceRequested && !manifest.reference_issues.length && referenceIds.length > 0 && outputIds.length > 0;
  const reply = raw === undefined ? { criteria: [], matches: [], unmatched_output_ids: [], unmatched_reference_ids: [] } : evaluatorReplySchema.parse(raw);
  exactUnique(reply.criteria.map(c => c.criterion_id), rubricRequested ? manifest.criteria.map(c => c.id) : [], 'Criterion judgments');
  if (referenceEnabled) {
    exactUnique([...reply.matches.map(m => m.output_id), ...reply.unmatched_output_ids], outputIds, 'Output judgments');
    exactUnique([...reply.matches.map(m => m.reference_id), ...reply.unmatched_reference_ids], referenceIds, 'Reference judgments');
  } else if (reply.matches.length || reply.unmatched_output_ids.length || reply.unmatched_reference_ids.length) throw new DevelopmentError(422, 'invalid_evaluator_reply', 'Reference judgments were supplied for an unscored reference assessment.');
  const checks = factualChecks(manifest);
  let rubric: EvaluationResult['rubric'] = null;
  if (rubricRequested) {
    const criteriaById = new Map(manifest.criteria.map(criterion => [criterion.id, criterion]));
    const totalWeight = manifest.criteria.reduce((sum, criterion) => sum + criterion.weight, 0);
    let weightedScore = 0;
    const criteria = reply.criteria.map(judgment => {
      // Exact identity validation above guarantees this criterion exists.
      const criterion = criteriaById.get(judgment.criterion_id)!;
      weightedScore += judgment.score * criterion.weight;
      const thresholdMet = criterion.threshold === undefined ? null : judgment.score >= criterion.threshold;
      return { ...judgment, threshold_met: thresholdMet };
    });
    rubric = {
      label: 'provisional_ai_assessment',
      score: weightedScore / totalWeight,
      criteria,
      factual_checks_passed: checks.passed,
    };
  }
  const reasons: string[] = [];
  if (!referenceRequested) {
    reasons.push('Reference method not selected.');
  } else {
    reasons.push(...manifest.reference_issues);
    if (!referenceIds.length) reasons.push('No compatible expected answers.');
    if (!outputIds.length) reasons.push('No output records; precision denominator is empty.');
  }
  const matches = referenceEnabled ? reply.matches : [];
  let precision: RatioMeasure = { numerator: 0, denominator: outputIds.length, value: null };
  let recall: RatioMeasure = { numerator: 0, denominator: referenceIds.length, value: null };
  if (referenceEnabled) {
    precision = ratio(matches.length, outputIds.length);
    recall = ratio(matches.length, referenceIds.length);
  } else if (!outputIds.length && referenceRequested && referenceIds.length > 0 && !manifest.reference_issues.length) {
    // No generated records means no precision denominator, but every expected answer was missed.
    recall = ratio(0, referenceIds.length);
  }
  return {
    checks,
    rubric,
    reference: {
      label: 'provisional_semantic_reference',
      status: referenceEnabled ? 'scored' : 'unscored',
      reasons,
      precision,
      recall,
      matches,
      unmatched_output_ids: referenceEnabled ? reply.unmatched_output_ids : outputIds,
      unmatched_reference_ids: referenceEnabled ? reply.unmatched_reference_ids : referenceIds,
    },
  };
}
