/** Persistence-only priority integration for factual/configuration invalidation and split safety. */
import { and, eq, inArray } from "drizzle-orm";
import { accuracyDb } from "./db";
import { accuracyPriorityPlacements } from "./schema";
import type { AccuracyPlacement } from "./priority-store";

export async function invalidateAccuracyPriorityValidation(workspace_id: string, gap_ids: string[] | null, at: string, reason: string, database = accuracyDb()) {
  if (gap_ids && !gap_ids.length) return;
  const rows = await database.select().from(accuracyPriorityPlacements).where(gap_ids
    ? and(eq(accuracyPriorityPlacements.workspace_id, workspace_id), inArray(accuracyPriorityPlacements.gap_id, gap_ids))
    : eq(accuracyPriorityPlacements.workspace_id, workspace_id));
  for (const row of rows) {
    const data = row.data as AccuracyPlacement;
    if (!data.validation || data.validation.freshness === "stale") continue;
    await database.update(accuracyPriorityPlacements).set({ data: { ...data, validated: false,
      validation: { ...data.validation, freshness: "stale" },
      history: [...data.history, { action: "invalidate", reason, at, before: { validation: data.validation } }],
    } }).where(and(eq(accuracyPriorityPlacements.workspace_id, workspace_id), eq(accuracyPriorityPlacements.gap_id, row.gap_id)));
  }
}
/** Model suggestions do not change this guard. Any later human placement/validation does. */
export async function accuracyPriorityHumanRevisions(workspace_id: string, gap_ids: string[]) {
  const rows = await accuracyDb().select().from(accuracyPriorityPlacements).where(and(eq(accuracyPriorityPlacements.workspace_id, workspace_id), inArray(accuracyPriorityPlacements.gap_id, gap_ids)));
  return rows.flatMap(row => {
    const data = row.data as AccuracyPlacement;
    return data.human_revision ? [{ gap_id: row.gap_id, human_revision: data.human_revision }] : [];
  }).sort((a, b) => a.gap_id.localeCompare(b.gap_id));
}

export async function invalidateAccuracyPriorityForSource(workspace_id: string, source_file_id: string, at: string) {
  const rows = await accuracyDb().select().from(accuracyPriorityPlacements).where(eq(accuracyPriorityPlacements.workspace_id, workspace_id));
  const ids = rows.filter(row => (row.data as AccuracyPlacement).references.some(ref => ref.source_file_id === source_file_id)).map(row => row.gap_id);
  await invalidateAccuracyPriorityValidation(workspace_id, ids, at, "source_evidence_changed");
}
