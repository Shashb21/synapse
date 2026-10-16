import { z } from "zod";
import type { IegpState } from "./types";

/** Stored model citations contain identifiers and the claim they support, never model-authored URLs. */
export const judgementReferenceSchema = z.object({
  entity_type: z.enum(["gap", "objective", "source"]),
  entity_id: z.string().trim().min(1),
  reason: z.string().trim().min(3),
}).strict();
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
    ...state.sources.filter(row => sourceIds.has(row.id)).map(row => ({ entity_type: "source" as const, entity_id: row.id, title: row.title, excerpt: state.needs.filter(need => needIds.has(need.id) && need.source_id === row.id).map(need => need.source_quote).join("\n") || row.full_text, href: `/sources/${encodeURIComponent(row.id)}` })),
  ];
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
