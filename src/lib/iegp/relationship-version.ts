import { tacticEditVersion } from "./tactic-edit-version";
import type { IegpState } from "./types";

/** Stable browser/server snapshot; object key ordering is not a domain change. */
export function relationshipVersion(value: unknown): string {
  const canonical = (row: unknown): unknown => {
    if (Array.isArray(row)) return row.map(canonical);
    if (row && typeof row === "object") return Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
    return row ?? null;
  };
  return JSON.stringify(canonical(value));
}

export function relationshipSnapshot(state: IegpState, gapId: string, tacticId: string) {
  return {
    coverages: state.coverages.filter(row => row.gap_id === gapId && row.tactic_id === tacticId).sort((a, b) => a.id.localeCompare(b.id)),
    decision: state.mapping_suggestions.find(row => row.gap_id === gapId && row.tactic_id === tacticId) ?? null,
  };
}

/** Opening snapshots for existing library choices on a workspace card. */
export function relationshipVersionsForGap(state: IegpState, gapId: string): Record<string, string> {
  return Object.fromEntries(state.tactics.map(tactic => [tactic.id, relationshipVersion(relationshipSnapshot(state, gapId, tactic.id))]));
}

/** Scientific scope and all parent relationships reviewed by a split/rewrite form.
 * Kept separate from pair snapshots because resolving a gap retires the parent.
 */
export function gapResolutionVersion(state: IegpState, gapId: string): string {
  const coverages = state.coverages.filter(row => row.gap_id === gapId).sort((a, b) => a.id.localeCompare(b.id));
  const decisions = state.mapping_suggestions.filter(row => row.gap_id === gapId).sort((a, b) => a.tactic_id.localeCompare(b.tactic_id));
  const expansions = state.expansions.filter(row => row.gap_ids.includes(gapId)).sort((a, b) => a.id.localeCompare(b.id));
  const links = state.need_gap_links.filter(row => row.gap_id === gapId).sort((a, b) => a.need_id.localeCompare(b.need_id));
  const needIds = new Set(links.map(row => row.need_id));
  const ids = new Set([...coverages, ...decisions, ...expansions].map(row => row.tactic_id));
  return relationshipVersion({
    gap: state.gaps.find(row => row.id === gapId) ?? null,
    coverages, decisions, expansions, links,
    needs: state.needs.filter(row => needIds.has(row.id)).sort((a, b) => a.id.localeCompare(b.id)),
    tactics: state.tactics.filter(row => ids.has(row.id)).sort((a, b) => a.id.localeCompare(b.id)).map(row => [row.id, tacticEditVersion(row)]),
  });
}
