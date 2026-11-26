/** Identifies the canonical result of an S3 candidate promotion. */
import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";
import { db } from "@/modules/kernel/db";
import { editRecords } from "@/modules/kernel/schema";

export const tacticPromotionEdit = and(
  eq(editRecords.stage, "S3"),
  eq(editRecords.entity_type, "tactic_candidate"),
  eq(editRecords.field, "verdict"),
  eq(editRecords.action, "accept"),
  eq(editRecords.before, "reject"),
  isNotNull(editRecords.after),
);

/** Use the original recorded result if older code promoted a candidate more than once. */
export async function tacticPromotionsForCandidates(candidateIds: string[]): Promise<Map<string, string>> {
  if (candidateIds.length === 0) return new Map();
  const rows = await db().select({ candidateId: editRecords.entity_id, tacticId: editRecords.after })
    .from(editRecords)
    .where(and(tacticPromotionEdit, inArray(editRecords.entity_id, candidateIds)))
    .orderBy(asc(editRecords.at), asc(editRecords.id));
  const results = new Map<string, string>();
  for (const { candidateId, tacticId } of rows) {
    if (tacticId && !results.has(candidateId)) results.set(candidateId, tacticId);
  }
  return results;
}
