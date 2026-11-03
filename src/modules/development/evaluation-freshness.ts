/** Compare a retained evaluation with an explicitly selected current evaluation. */
import type { Evaluation } from './evaluation-store';
import type { EvaluationConfig } from './evaluation-schema';
import type { DevelopmentDocument } from './schema';
import type { EvaluationProfile } from './profile-schema';
export type EvaluationComparison = { attempt_id: string; output_id: string; profile: EvaluationProfile; config: EvaluationConfig; references: DevelopmentDocument[] };
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
/** Compare the explicit editor selection, leaving frozen evidence untouched. */
export function compareEvaluation(evaluation: Evaluation, selection: EvaluationComparison | null): { freshness: 'current' | 'outdated' | 'unavailable'; reasons: string[] } {
  if (!selection) return { freshness: 'unavailable', reasons: [] };
  const { manifest } = evaluation;
  const reasons: string[] = [];
  if (manifest.attempt_id !== selection.attempt_id || manifest.output_id !== selection.output_id) reasons.push('output_changed');
  if (manifest.profile.id !== selection.profile.id || manifest.profile.version !== selection.profile.version) reasons.push('profile_changed');
  if (canonical(manifest.config.sections[manifest.section]) !== canonical(selection.config.sections[manifest.section])) reasons.push('evaluator_changed');
  const sorted = (documents: DevelopmentDocument[]) => documents.map(({ id, section, sha256, parsed_sha256, source_document_ids, compatibility, review_status }) => ({ id, section, sha256, parsed_sha256, source_document_ids, compatibility, review_status })).sort((a, b) => a.id.localeCompare(b.id));
  if (canonical(sorted(manifest.references)) !== canonical(sorted(selection.references))) reasons.push('references_changed');
  return { freshness: reasons.length ? 'outdated' : 'current', reasons };
}
