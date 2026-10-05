import { eq } from "drizzle-orm";
import { db, ensurePlatformSchema } from "@/modules/kernel/db";
import { acceptGapMerge, acceptGapSplit, loadState, rejectGapSuggestion } from "@/lib/iegp/store";
import type { ActorFunction } from "@/lib/iegp/enums";
import type { GapSuggestion } from "@/lib/iegp/types";
import { captureGapSuggestionDecision } from "@/lib/iegp/learning-capture";
import { resetPlacementValidation } from "@/modules/stages/s8-prioritization/module";
import { GAP_CANDIDATES_DDL, gapCandidates } from "./schema";

/**
 * A person's decision on an overlap suggestion (KAN-75). The store owns the gaps
 * and needs; these wrappers add the parts other stages own: S8's validated band,
 * S2's own candidate record, and the learning example (KAN-78).
 */
type Decision = {
  suggestion_id: string;
  rationale: string;
  actor_name: string;
  actor_function: ActorFunction;
};

/** The suggestion and its gap's wording before a decision changes them, for the learning example. */
async function beforeDecision(
  suggestionId: string,
): Promise<{ suggestion: GapSuggestion; gap: { name: string; statement: string } | null } | null> {
  try {
    const state = await loadState();
    const suggestion = state.gap_suggestions.find((row) => row.id === suggestionId);
    if (!suggestion) return null;
    const gap = state.gaps.find((row) => row.id === suggestion.gap_id);
    return { suggestion, gap: gap ? { name: gap.name, statement: gap.statement } : null };
  } catch {
    return null;
  }
}

/**
 * Merge: the gap is reworded, the source joins it, its mappings are flagged for
 * review, and its validated priority goes back to draft, because the band was set
 * for the old question.
 */
export async function acceptGapMergeSuggestion(
  args: Decision & { name?: string; statement?: string },
): Promise<{ gap_id: string; priority_reset: boolean }> {
  const before = await beforeDecision(args.suggestion_id);
  const { gap_id } = await acceptGapMerge(args);
  const priority_reset = await resetPlacementValidation(gap_id);
  if (before) {
    await captureGapSuggestionDecision({
      ...before,
      decision: "merge",
      name: args.name,
      statement: args.statement,
      rationale: args.rationale,
    });
  }
  return { gap_id, priority_reset };
}

/** Split: a new, related gap with only the new part; the shared part joins the existing gap. */
export async function acceptGapSplitSuggestion(args: Decision & { name?: string; statement?: string }) {
  const before = await beforeDecision(args.suggestion_id);
  const result = await acceptGapSplit(args);
  if (before) {
    await captureGapSuggestionDecision({
      ...before,
      decision: "split",
      name: args.name,
      statement: args.statement,
      rationale: args.rationale,
    });
  }
  return result;
}

/**
 * Reject: nothing changes in the plan. The candidate is marked rejected on its S2
 * record, so it appears with the other rejected candidates and can still be
 * promoted to a gap by hand.
 */
export async function rejectGapSuggestionKeepingCandidate(args: Decision): Promise<void> {
  const before = await beforeDecision(args.suggestion_id);
  const suggestion = await rejectGapSuggestion(args);
  if (before) await captureGapSuggestionDecision({ ...before, decision: "reject", rationale: args.rationale });
  if (!suggestion.candidate_row_id) return;
  await ensurePlatformSchema([GAP_CANDIDATES_DDL]);
  await db()
    .update(gapCandidates)
    .set({ verdict: "reject", critic_note: `Overlap with ${suggestion.gap_id} rejected by a person: ${args.rationale.trim()}` })
    .where(eq(gapCandidates.id, suggestion.candidate_row_id));
}
