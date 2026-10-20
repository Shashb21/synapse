/** Current opening tokens for fixtures using the public action boundary. */
import { loadState } from "@/lib/iegp/store";
import { gapEditSnapshot } from "@/lib/iegp/gap-edit";
import { gapResolutionVersion, relationshipSnapshot, relationshipVersion } from "@/lib/iegp/relationship-version";
import { tacticEditVersion } from "@/lib/iegp/tactic-edit-version";

/** Capture fixture opening state; explicit test tokens override these defaults. */
export async function openingActionTokens(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  // Source review owns its own citation/target versions; no relationship snapshot is consumed.
  if (["link_source_support", "create_source_discrepancy", "resolve_source_discrepancy", "retry_source_comparison"].includes(String(body.action))) return {};
  const state = await loadState();
  const coverage = state.coverages.find(row => row.id === body.coverage_id);
  const gapId = coverage?.gap_id ?? String(body.gap_id ?? "");
  const tacticId = coverage?.tactic_id ?? String(body.tactic_id ?? "");
  const gap = state.gaps.find(row => row.id === gapId);
  const tactic = state.tactics.find(row => row.id === tacticId);
  return {
    expected_relationship: relationshipVersion(relationshipSnapshot(state, gapId, tacticId)),
    expected_resolution: gap ? gapResolutionVersion(state, gap.id) : "",
    ...(gap ? { expected_gap: gapEditSnapshot(gap), expected_objective_id: gap.objective_id, expected_settings: gap.settings, expected_metadata: gap.metadata } : {}),
    ...(tactic ? { expected_tactic: tacticEditVersion(tactic) } : {}),
  };
}
