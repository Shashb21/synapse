/** Strict editable rubrics and the immutable balanced starting profile; factual checks are separate. */
import { z } from 'zod';
import { sectionSchema, type DevelopmentSection } from './schema';
const label = z.string().trim().min(1).max(200);
const instruction = z.string().trim().min(1).max(4000);
export const criterionSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,79}$/), name: label, definition: instruction, instructions: instruction,
  anchors: z.object({ '0': instruction, '1': instruction, '2': instruction, '3': instruction, '4': instruction }).strict(),
  weight: z.number().finite().min(0).max(1000), threshold: z.number().finite().min(0).max(4).optional(),
}).strict();
export type Criterion = z.infer<typeof criterionSchema>;
const criteriaSchema = z.array(criterionSchema).min(1).max(30).superRefine((criteria, ctx) => {
  if (new Set(criteria.map(c => c.id)).size !== criteria.length || new Set(criteria.map(c => c.name.toLowerCase())).size !== criteria.length) ctx.addIssue({ code: 'custom', message: 'Criterion IDs and names must be unique.' });
  if (criteria.reduce((sum, c) => sum + c.weight, 0) <= 0) ctx.addIssue({ code: 'custom', message: 'Criteria need a positive total weight.' });
});
export const profileInputSchema = z.object({
  name: label, defaults: criteriaSchema, sections: z.partialRecord(sectionSchema, criteriaSchema).default({}),
  profile_id: label.optional(), base_version: z.number().int().positive().optional(),
}).strict().superRefine((value, ctx) => {
  if (Boolean(value.profile_id) !== Boolean(value.base_version)) ctx.addIssue({ code: 'custom', message: 'Editing requires the exact profile ID and base version; omit both for Save As.' });
});
export type ProfileInput = z.infer<typeof profileInputSchema>;
export type EvaluationProfile = Pick<ProfileInput, 'name' | 'defaults' | 'sections'> & { id: string; version: number; builtin: boolean; created_at: string };
function criterion(id: string, name: string, definition: string, anchors: [string, string, string, string, string]): Criterion {
  return { id, name, definition, instructions: `Assess ${name.toLowerCase()} against the frozen source and section output. Explain the score using concrete supplied records. Do not assert human review or override factual checks.`, anchors: { '0': anchors[0], '1': anchors[1], '2': anchors[2], '3': anchors[3], '4': anchors[4] }, weight: 1 };
}
const extraction = [
  criterion('recovery', 'Finding recovery', 'Recovery of distinct source-supported findings appropriate to this extraction section.', ['No appropriate findings recovered.', 'Only a small minority of obvious findings recovered.', 'Some major findings recovered; substantial omissions.', 'Most findings recovered with minor omissions.', 'All material distinct source-supported findings recovered.']),
  criterion('unsupported', 'Unsupported findings', 'Avoid statements absent from or contradicted by supplied evidence.', ['Most findings are invented or contradicted.', 'Several major unsupported findings.', 'A mixture of supported and unsupported details.', 'Findings supported except minor overstatement.', 'Every finding is supported without overclaiming.']),
  criterion('citations', 'Citation quality', 'Quoted evidence supports the actual finding, beyond verbatim validity.', ['Citations support none of the findings.', 'Citations are mostly unrelated to the finding.', 'Some citations support only part of the claim.', 'Citations support almost all findings precisely.', 'Every citation directly supports its whole finding.']),
  criterion('specificity', 'Specificity', 'Retain meaningful population, intervention, comparator, outcome and context without inventing details.', ['Findings have no usable specific scope.', 'Most meaningful scope is missing.', 'Some scope retained but important qualifiers missing.', 'Material scope retained with small ambiguity.', 'All relevant supplied scope and qualifiers retained clearly.']),
  criterion('evidence', 'Evidence fidelity', 'Preserve evidence status, uncertainty and distinguish questions from delivered findings.', ['Evidence status and uncertainty are reversed.', 'Major evidence-status errors.', 'Some uncertainty or status is distorted.', 'Evidence status and uncertainty mostly faithful.', 'Evidence status and uncertainty faithfully preserved throughout.']),
];
const mapping = [
  criterion('relevance', 'Relevance', 'Distinguish topical similarity from answering the gap question.', ['No relevance judgments are defensible.', 'Most relevance judgments rely on topic alone.', 'Some links answer the gap; several are weak.', 'Nearly all links have direct decision relevance.', 'Every relevant and irrelevant judgment follows the actual question.']),
  criterion('design_fit', 'Study design fit', 'Assess whether supplied study design can answer the gap.', ['Design fit is entirely misrepresented.', 'Most design limitations ignored.', 'Some design limitations recognized.', 'Material design limitations recognized with minor gaps.', 'Study design capabilities and limitations accurately assessed throughout.']),
  criterion('delivered', 'Evidence delivered', 'Distinguish planned or ongoing work from evidence already available.', ['All proposed work is treated as delivered evidence.', 'Major lifecycle and availability errors.', 'Mixed lifecycle handling.', 'Lifecycle and evidence availability mostly respected.', 'Every assessment respects lifecycle and actual available evidence.']),
  criterion('coverage', 'Justified coverage', 'Coverage categories and dimensions follow the source-supported scope.', ['No coverage claims justified.', 'Most coverage claims overstate scope.', 'Some categories or dimensions unsupported.', 'Coverage justified with minor dimension gaps.', 'Every category and dimension is explicitly justified by scope.']),
  criterion('records', 'Valid record reasoning', 'Explain judgments using the correct supplied gap, tactic and supporting records.', ['Reasoning refers to unrelated records.', 'Most record reasoning is missing or unrelated.', 'Some correct records support the reasoning.', 'Correct records support almost all judgments.', 'All judgments explain the relevant supplied records accurately.']),
];
const splitting = [
  criterion('addressed', 'Addressed scope', 'Addressed child contains only scope actually covered by mapped tactics.', ['Addressed child wholly unsupported.', 'Addressed child mostly overclaims.', 'Addressed scope partly supported.', 'Addressed scope supported with minor ambiguity.', 'Addressed child exactly captures supported scope.']),
  criterion('residual', 'Residual completeness', 'Residual child preserves every material unanswered part of the parent.', ['No unanswered parent scope preserved.', 'Most unanswered scope lost.', 'Some unanswered scope lost.', 'Almost all unanswered scope preserved.', 'All unanswered parent scope preserved explicitly.']),
  criterion('overlap', 'Non-overlap', 'Children separate covered and unanswered questions without duplication.', ['Children duplicate or contradict each other entirely.', 'Major overlapping scope.', 'Some material overlap.', 'Only minor ambiguity at scope boundary.', 'Children have clear complementary non-overlapping scope.']),
  criterion('meaning', 'Parent meaning', 'Children together preserve original parent question and qualifiers.', ['Parent meaning changed entirely.', 'Major qualifiers or question changed.', 'Parent meaning partly preserved.', 'Parent meaning mostly preserved.', 'Children together preserve the complete original meaning.']),
  criterion('tactics', 'Tactic validity', 'Addressed child relies only on counting mapped tactics and their actual scope.', ['All addressed support is invalid.', 'Mostly unsupported tactic assignments.', 'Mixed support from valid mapped tactics.', 'Valid support with minor scope ambiguity.', 'Every assigned tactic supports the addressed scope and counts legitimately.']),
];
export const balancedProfile: EvaluationProfile = { id: 'balanced', version: 1, builtin: true, name: 'Balanced', created_at: '2026-10-30T00:00:00.000Z', defaults: extraction, sections: { matching_coverage: mapping, partial_splitting: splitting } };
/** Resolve a complete section override, falling back to shared criteria. */
export function effectiveCriteria(profile: Pick<EvaluationProfile, 'defaults' | 'sections'>, section: DevelopmentSection): Criterion[] { return structuredClone(profile.sections[section] ?? profile.defaults); }
