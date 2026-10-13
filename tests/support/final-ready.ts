import { displayedGapStatus, isLiveGap } from "@/lib/iegp/engine";
import { loadState, lockGapStatus, rewritePartialGap, validateGap } from "@/lib/iegp/store";
import type { ActorFunction } from "@/lib/iegp/enums";
import { listPlacements, validatePlacement } from "@/modules/stages/s8-prioritization/module";

/**
 * Brings a seeded plan to where a complete final may be saved (KAN-86): every
 * Partially Addressed gap rewritten (Addressed with its mapped tactics, else
 * Open), every live gap confirmed, and every Open gap given a validated band.
 * Tests that exercise the roadmap call this before saving as final.
 */
export async function makeFinalReady(actor: { name: string; function: ActorFunction }) {
  let state = await loadState();
  for (const gap of state.gaps.filter(isLiveGap)) {
    if (displayedGapStatus(gap) !== "validated_partial") continue;
    const tacticIds = [...new Set(state.coverages.filter((c) => c.gap_id === gap.id).map((c) => c.expansion_id ?? c.tactic_id))];
    await rewritePartialGap({
      gap_id: gap.id,
      name: gap.name,
      status: tacticIds.length > 0 ? "validated_addressed" : "validated_open",
      tactic_ids: tacticIds.length > 0 ? tacticIds : undefined,
      actor_name: actor.name,
      actor_function: actor.function,
      note: "Resolved before the final plan",
    });
  }
  state = await loadState();
  for (const gap of state.gaps.filter(isLiveGap)) {
    if (gap.status === "candidate") {
      // A candidate is decided first: here it is kept, as an Open gap.
      await lockGapStatus({ gap_id: gap.id, status: "validated_open", actor_name: actor.name, actor_function: actor.function, note: "Kept as Open for the final plan" });
      await validateGap({ gap_id: gap.id, actor_name: actor.name, actor_function: actor.function, note: "Confirmed for the final plan" });
    } else if (!gap.human_validated) {
      await validateGap({ gap_id: gap.id, actor_name: actor.name, actor_function: actor.function, note: "Confirmed for the final plan" });
    }
  }
  state = await loadState();
  const banded = new Set((await listPlacements()).filter((p) => p.validated && p.band).map((p) => p.gap_id));
  for (const gap of state.gaps.filter(isLiveGap)) {
    if (displayedGapStatus(gap) !== "validated_open" || banded.has(gap.id)) continue;
    await validatePlacement({ gap_id: gap.id, band: "low", rationale: "Banded for the final plan", actor });
  }
}
