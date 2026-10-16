import { z } from "zod";
import type { IegpState } from "./types";

/** Stored model citations contain identifiers and the claim they support, never model-authored URLs. */
export const judgementReferenceSchema = z.object({
  entity_type: z.enum(["gap", "objective", "source"]),
  entity_id: z.string().trim().min(1),
  reason: z.string().trim().min(3),
}).strict();
export const suppliedJudgementRecordSchema = judgementReferenceSchema.omit({ reason: true }).extend({
  title: z.string(), excerpt: z.string(), href: z.string(),
});
export type JudgementReference = z.infer<typeof judgementReferenceSchema>;
export type InspectableReference = JudgementReference & { title: string; excerpt: string; href: string };

/** Caller supplies state from the authorised workspace. Only records related to these gaps qualify.
 * Shared by model generation and acceptance; later judgements can supply their own gap set.
 */
export function suppliedJudgementRecords(state: IegpState, gapIds: string[]) {
  const gaps = state.gaps.filter(gap => gapIds.includes(gap.id) && !gap.retired);
  const objectiveIds = new Set(gaps.map(gap => gap.objective_id));
  const needIds = new Set(state.need_gap_links.filter(link => gapIds.includes(link.gap_id)).map(link => link.need_id));
  const sourceIds = new Set(state.needs.filter(need => needIds.has(need.id)).map(need => need.source_id));
  return [
    ...gaps.map(gap => ({ entity_type: "gap" as const, entity_id: gap.id, title: gap.name, excerpt: gap.statement, href: `/gaps/${encodeURIComponent(gap.id)}` })),
    ...state.objectives.filter(row => objectiveIds.has(row.id)).map(row => ({ entity_type: "objective" as const, entity_id: row.id, title: row.name, excerpt: `${row.description}\nAffected decision: ${row.key_decision}\nEvidence needed by: ${row.evidence_needed_by || "Unknown"}\nDecision date: ${row.decision_date || "Unknown"}`, href: "/setup" })),
    ...state.sources.filter(row => sourceIds.has(row.id)).map(row => ({ entity_type: "source" as const, entity_id: row.id, title: row.title, excerpt: state.needs.filter(need => needIds.has(need.id) && need.source_id === row.id).sort((a, b) => a.id.localeCompare(b.id)).map(need => need.source_quote).join("\n") || row.full_text, href: `/sources/${encodeURIComponent(row.id)}` })),
  ].sort(compareSuppliedRecords);
}

function compareSuppliedRecords(a: { entity_type: string; entity_id: string }, b: { entity_type: string; entity_id: string }) {
  return a.entity_type.localeCompare(b.entity_type) || a.entity_id.localeCompare(b.entity_id);
}

/** Older snapshots joined complete quotations in database order. Match exactly those
 * quotations in any order, preserving duplicates, whitespace and lines within each quote.
 * Splitting and sorting excerpt lines would incorrectly accept changed multiline quotes.
 */
function matchesLegacyQuotationOrder(excerpt: string, quotations: string[]): boolean {
  if (!quotations.length || excerpt.length !== quotations.reduce((size, quote) => size + quote.length, quotations.length - 1)) return false;
  const counts = new Map<string, number>();
  for (const quote of quotations) counts.set(quote, (counts.get(quote) ?? 0) + 1);
  const choices = [...counts.keys()].sort((a, b) => b.length - a.length);
  const remaining = choices.map(quote => counts.get(quote)!);
  const failed = new Set<string>();
  function match(offset: number, left: number): boolean {
    if (!left) return offset === excerpt.length;
    const key = `${offset}:${remaining.join(",")}`;
    if (failed.has(key)) return false;
    for (let index = 0; index < choices.length; index++) {
      const quote = choices[index];
      if (!remaining[index] || !excerpt.startsWith(quote, offset)) continue;
      const end = offset + quote.length;
      if (left > 1 && excerpt[end] !== "\n") continue;
      remaining[index]--;
      const matched = match(end + (left > 1 ? 1 : 0), left - 1);
      remaining[index]++;
      if (matched) return true;
    }
    failed.add(key);
    return false;
  }
  return match(0, quotations.length);
}

/** Compare scientific content in the authorised workspace, independently of row order.
 * Already stored snapshots are read as recorded: only whole source quotation order may
 * differ. Missing records, changed metadata/text and malformed snapshots remain stale.
 */
export function matchesSuppliedJudgementRecords(state: IegpState, gapIds: string[], stored: unknown): boolean {
  const parsed = z.array(suppliedJudgementRecordSchema).min(1).safeParse(stored);
  if (!parsed.success) return false;
  const previous = parsed.data.sort(compareSuppliedRecords);
  const current = suppliedJudgementRecords(state, gapIds);
  if (previous.length !== current.length) return false;
  const needIds = new Set(state.need_gap_links.filter(link => gapIds.includes(link.gap_id)).map(link => link.need_id));
  return current.every((record, index) => {
    const saved = previous[index];
    if (saved.entity_type !== record.entity_type || saved.entity_id !== record.entity_id || saved.title !== record.title || saved.href !== record.href) return false;
    if (saved.excerpt === record.excerpt) return true;
    return record.entity_type === "source" && matchesLegacyQuotationOrder(saved.excerpt,
      state.needs.filter(need => needIds.has(need.id) && need.source_id === record.entity_id).map(need => need.source_quote));
  });
}

/** All-or-nothing: one malformed, missing or unrelated target invalidates the claimed support. */
export function inspectJudgementReferences(state: IegpState, gapIds: string[], value: unknown): InspectableReference[] {
  return inspectSuppliedJudgementReferences(suppliedJudgementRecords(state, gapIds), value);
}

export function inspectSuppliedJudgementReferences(supplied: ReturnType<typeof suppliedJudgementRecords>, value: unknown): InspectableReference[] {
  const parsed = z.array(judgementReferenceSchema).min(1).safeParse(value);
  if (!parsed.success) return [];
  const references: InspectableReference[] = [];
  for (const reference of parsed.data) {
    const target = supplied.find(row => row.entity_type === reference.entity_type && row.entity_id === reference.entity_id);
    if (!target || !target.excerpt.trim()) return [];
    references.push({ ...target, ...reference });
  }
  return references;
}

/** Historical references retain their recorded claim. Resolve only existing workspace records;
 * a relationship may have changed since the decision, so readback does not assert current support.
 */
export function recordedJudgementReferences(state: IegpState, value: unknown) {
  const parsed = z.array(judgementReferenceSchema).safeParse(value);
  if (!parsed.success) return [];
  return parsed.data.map(reference => {
    const gap = reference.entity_type === "gap" ? state.gaps.find(row => row.id === reference.entity_id) : undefined;
    const objective = reference.entity_type === "objective" ? state.objectives.find(row => row.id === reference.entity_id) : undefined;
    const source = reference.entity_type === "source" ? state.sources.find(row => row.id === reference.entity_id) : undefined;
    const target = gap ? { title: gap.name, href: `/gaps/${encodeURIComponent(gap.id)}` } : objective ? { title: objective.name, href: "/setup" } : source ? { title: source.title, href: `/sources/${encodeURIComponent(source.id)}` } : null;
    return { ...reference, target };
  });
}
