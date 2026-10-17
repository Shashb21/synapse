import { loadState } from "@/lib/iegp/store";
import { suppliedJudgementRecords } from "@/lib/iegp/judgement-references";
import { tacticEditVersion } from "@/lib/iegp/tactic-edit-version";

/** Opening scientific records for a scripted model mapping, before any mutation. */
export async function modelMappingSupport(gapId: string, tacticId: string) {
  const state = await loadState();
  const supplied_records = suppliedJudgementRecords(state, [gapId]);
  const gap = supplied_records.find(row => row.entity_type === "gap" && row.entity_id === gapId)!;
  return {
    references: [{ entity_type: gap.entity_type, entity_id: gap.entity_id, reason: "The supplied gap states the evidence this study assesses" }],
    supplied_records,
    expected_tactic_version: tacticEditVersion(state.tactics.find(row => row.id === tacticId)!),
  };
}
