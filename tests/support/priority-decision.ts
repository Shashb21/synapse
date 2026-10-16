import { loadState } from "@/lib/iegp/store";
import { listPlacements } from "@/modules/stages/s8-prioritization/module";

/** Existing journeys review the current judgement before making their next decision. */
export async function priorityDecision(gapId: string, reason: string) {
  const current = (await listPlacements()).find((row) => row.gap_id === gapId);
  const gap = (await loadState()).gaps.find(row => row.id === gapId);
  return { reason, expected_version: current?.version ?? null, expected_context_version: gap?.priority_context_version ?? null };
}
