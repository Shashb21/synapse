import { listPlacements } from "@/modules/stages/s8-prioritization/module";

/** Existing journeys review the current judgement before making their next decision. */
export async function priorityDecision(gapId: string, reason: string) {
  const current = (await listPlacements()).find((row) => row.gap_id === gapId);
  return { reason, expected_version: current?.version ?? null };
}
