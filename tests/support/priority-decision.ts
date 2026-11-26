import { displayedGapStatus, isLiveGap } from "@/lib/iegp/engine";
import type { ActorFunction } from "@/lib/iegp/enums";
import { loadState, parkGap, validateGap } from "@/lib/iegp/store";
import { listPlacements } from "@/modules/stages/s8-prioritization/module";

/** Existing journeys review the current judgement before making their next decision. */
export async function priorityDecision(gapId: string, reason: string) {
  const current = (await listPlacements()).find((row) => row.gap_id === gapId);
  const gap = (await loadState()).gaps.find(row => row.id === gapId);
  return { reason, expected_version: current?.version ?? null, expected_context_version: gap?.priority_context_version ?? null };
}

/** Reviews fixture gaps that belong in prioritization and parks unrelated provisional evidence. */
export async function reviewInventoryForPriorities(actor: { name: string; function: ActorFunction }) {
  const identity = { actor_name: actor.name, actor_function: actor.function };
  for (const gap of (await loadState()).gaps.filter(isLiveGap)) {
    const status = displayedGapStatus(gap);
    if (status === "candidate" || status === "validated_partial") {
      await parkGap({ ...identity, gap_id: gap.id, reason: "Outside this prioritization fixture" });
    } else if (!gap.human_validated) {
      await validateGap({ ...identity, gap_id: gap.id, note: "Confirmed for this prioritization fixture" });
    }
  }
}
