import { eq } from "drizzle-orm";
import { db, ensurePlatformSchema } from "@/modules/kernel/db";
import { acceptGapMerge, acceptGapSplit, rejectGapSuggestion } from "@/lib/iegp/store";
import type { ActorFunction } from "@/lib/iegp/enums";
import { resetPlacementValidation } from "@/modules/stages/s8-prioritization/module";
import { GAP_CANDIDATES_DDL, gapCandidates } from "./schema";

/**
 * A person's decision on an overlap suggestion (KAN-75). The store owns the gaps
 * and needs; these wrappers add the parts other stages own: S8's validated band,
 * and S2's own candidate record.
 */
type Decision = {
  suggestion_id: string;
  rationale: string;
  actor_name: string;
  actor_function: ActorFunction;
};

/**
 * Merge: the gap is reworded, the source joins it, its mappings are flagged for
 * review, and its validated priority goes back to draft, because the band was set
 * for the old question.
 */
export async function acceptGapMergeSuggestion(
  args: Decision & { name?: string; statement?: string },
): Promise<{ gap_id: string; priority_reset: boolean }> {
  const { gap_id } = await acceptGapMerge(args);
  const priority_reset = await resetPlacementValidation(gap_id);
  return { gap_id, priority_reset };
}

/** Split: a new, related gap with only the new part; the shared part joins the existing gap. */
export function acceptGapSplitSuggestion(args: Decision & { name?: string; statement?: string }) {
  return acceptGapSplit(args);
}

/**
 * Reject: nothing changes in the plan. The candidate is marked rejected on its S2
 * record, so it appears with the other rejected candidates and can still be
 * promoted to a gap by hand.
 */
export async function rejectGapSuggestionKeepingCandidate(args: Decision): Promise<void> {
  const suggestion = await rejectGapSuggestion(args);
  if (!suggestion.candidate_row_id) return;
  await ensurePlatformSchema([GAP_CANDIDATES_DDL]);
  await db()
    .update(gapCandidates)
    .set({ verdict: "reject", critic_note: `Overlap with ${suggestion.gap_id} rejected by a person: ${args.rationale.trim()}` })
    .where(eq(gapCandidates.id, suggestion.candidate_row_id));
}
