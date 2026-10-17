import { sourceClaimReviewData } from "./source-review";
import { coverageReviewVersion, getRequirementBasisReview } from "./requirement-basis";
import { relationshipFit } from "./engine";
import { relationshipSnapshot, relationshipVersion } from "./relationship-version";
import { entityHistory } from "./entity-history";
import { lastResetAt } from "./gap-history";
import { loadState } from "./store";
import { tacticEditVersion } from "./tactic-edit-version";
import { listTacticSourceReferences } from "@/modules/stages/s3-tactic-extract/suggestions";
import type { IegpState } from "./types";

/** Shared full-record/panel read, scoped to the verified request workspace. */
export async function tacticRecord(id: string, preloaded?: IegpState) {
  const state = preloaded ?? await loadState();
  const tactic = state.tactics.find(row => row.id === id);
  if (!tactic) return null;
  const coverages = state.coverages.filter(row => row.tactic_id === id);
  const expansions = state.expansions.filter(row => row.tactic_id === id);
  const [history, references] = await Promise.all([
    entityHistory([id, ...coverages.map(row => row.id), ...expansions.map(row => row.id)], { since: lastResetAt(state) }),
    listTacticSourceReferences(id),
  ]);
  const gaps = (ids: string[]) => state.gaps.filter(gap => ids.includes(gap.id)).map(gap => ({ id: gap.id, name: gap.name }));
  return {
    tactic,
    source_review: sourceClaimReviewData(state, { tacticId: id }),
    version: tacticEditVersion(tactic),
    custom_types: state.tactics.flatMap(row => row.custom_type ? [row.custom_type] : []),
    coverages: coverages.map(row => ({ ...row, review_version: coverageReviewVersion(row), requirement_review: getRequirementBasisReview(state, row.gap_id, row), fit: relationshipFit(state, row.gap_id, row.tactic_id, row.expansion_id), relationship_version: relationshipVersion(relationshipSnapshot(state, row.gap_id, row.tactic_id)), gap: state.gaps.find(gap => gap.id === row.gap_id) ?? null })),
    expansions,
    source_references: references.flatMap(reference => {
      const source = state.sources.find(row => row.id === reference.source_id);
      return source ? [{ id: reference.id, source_id: source.id, title: source.title, quote: reference.source_quote }] : [];
    }),
    history: history.map(entry => {
      const coverage = coverages.find(row => row.id === entry.entity_id);
      const expansion = expansions.find(row => row.id === entry.entity_id);
      return { ...entry, counterpart_gaps: entry.counterpart_gaps ?? gaps(coverage ? [coverage.gap_id] : expansion?.gap_ids ?? []) };
    }),
  };
}

export type TacticRecord = NonNullable<Awaited<ReturnType<typeof tacticRecord>>> & {
  permissions: { edit: boolean; coverage: boolean };
};
