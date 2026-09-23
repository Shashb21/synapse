import { and, desc, eq } from "drizzle-orm";
import { accuracyDb, ensureAccuracySchema } from "./db";
import * as t from "./schema";
import { newId, nowIso } from "@/modules/kernel/ids";
import type { Actor } from "@/accuracy/kernel/contracts";
import type { GanttActivity } from "@/accuracy/modules/gantt-project/engine";
import { requireValidationRationale } from "./claim-store";

export type AccuracyPlanStatus = "draft" | "final";

export type AccuracyPlanSnapshot = {
  activities: GanttActivity[];
  tactic_ids: string[];
  counts: { activities: number; validated_tactics: number };
};

export type AccuracyPlanRecord = {
  id: string;
  workspace_id: string;
  version: number;
  status: AccuracyPlanStatus;
  note: string | null;
  saved_by: string;
  saved_function: string;
  saved_at: string;
  snapshot: AccuracyPlanSnapshot;
};

export async function latestAccuracyPlan(
  workspace_id: string,
): Promise<AccuracyPlanRecord | null> {
  await ensureAccuracySchema();
  const rows = await accuracyDb()
    .select()
    .from(t.accuracyPlans)
    .where(eq(t.accuracyPlans.workspace_id, workspace_id))
    .orderBy(desc(t.accuracyPlans.version))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return toPlanRecord(row);
}

export async function listAccuracyPlans(
  workspace_id: string,
  limit = 20,
): Promise<AccuracyPlanRecord[]> {
  await ensureAccuracySchema();
  const rows = await accuracyDb()
    .select()
    .from(t.accuracyPlans)
    .where(eq(t.accuracyPlans.workspace_id, workspace_id))
    .orderBy(desc(t.accuracyPlans.version))
    .limit(limit);
  return rows.map(toPlanRecord);
}

export async function saveAccuracyPlan(args: {
  workspace_id: string;
  status: AccuracyPlanStatus;
  note: string;
  actor: Actor;
  snapshot: AccuracyPlanSnapshot;
}): Promise<AccuracyPlanRecord> {
  const note = requireValidationRationale(args.note);
  await ensureAccuracySchema();
  const previous = await latestAccuracyPlan(args.workspace_id);
  const version = (previous?.version ?? 0) + 1;
  const record = {
    id: newId("plan"),
    workspace_id: args.workspace_id,
    version,
    status: args.status,
    snapshot: args.snapshot,
    note,
    saved_by: args.actor.name,
    saved_function: args.actor.function,
    saved_at: nowIso(),
  };
  await accuracyDb().insert(t.accuracyPlans).values(record);
  return {
    id: record.id,
    workspace_id: record.workspace_id,
    version: record.version,
    status: record.status,
    note: record.note,
    saved_by: record.saved_by,
    saved_function: record.saved_function,
    saved_at: record.saved_at,
    snapshot: record.snapshot,
  };
}

function toPlanRecord(row: typeof t.accuracyPlans.$inferSelect): AccuracyPlanRecord {
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    version: row.version,
    status: row.status as AccuracyPlanStatus,
    note: row.note,
    saved_by: row.saved_by,
    saved_function: row.saved_function,
    saved_at: row.saved_at,
    snapshot: row.snapshot as AccuracyPlanSnapshot,
  };
}

/** Used by tests / callers that need a workspace-scoped existence check. */
export async function getAccuracyPlanById(
  workspace_id: string,
  plan_id: string,
): Promise<AccuracyPlanRecord | null> {
  await ensureAccuracySchema();
  const rows = await accuracyDb()
    .select()
    .from(t.accuracyPlans)
    .where(
      and(eq(t.accuracyPlans.workspace_id, workspace_id), eq(t.accuracyPlans.id, plan_id)),
    )
    .limit(1);
  const row = rows[0];
  return row ? toPlanRecord(row) : null;
}
