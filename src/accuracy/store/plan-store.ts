/** Stores immutable plan snapshots and serializes version allocation per workspace. */
import { and, desc, eq, sql } from "drizzle-orm";
import { accuracyDb, ensureAccuracySchema } from "./db";
import * as t from "./schema";
import { newId, nowIso } from "@/modules/kernel/ids";
import type { Actor } from "@/accuracy/kernel/contracts";
import type { GanttActivity } from "@/accuracy/modules/gantt-project/engine";
import type { GanttCatalogEntry } from "@/accuracy/modules/gantt-project/snapshot-hash";
import { requireValidationRationale } from "./claim-store";

export type AccuracyPlanStatus = "draft" | "final";

export type AccuracyPlanSnapshot = {
  activities: GanttActivity[];
  tactic_ids: string[];
  counts: { activities: number; validated_tactics: number };
  /** Gap/tactic statements frozen with the bars. */
  labels?: GanttCatalogEntry[];
  /** SHA-256 of the canonical snapshot payload (excludes this field). */
  snapshot_hash?: string;
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

/** Return the highest committed version, or null for an empty workspace. */
export async function latestAccuracyPlan(
  workspace_id: string,
): Promise<AccuracyPlanRecord | null> {
  await ensureAccuracySchema();
  const rows = await accuracyDb()
    .select()
    .from(t.accuracyPlans)
    .where(eq(t.accuracyPlans.workspace_id, workspace_id))
    .orderBy(desc(t.accuracyPlans.version), desc(t.accuracyPlans.saved_at), desc(t.accuracyPlans.id))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return toPlanRecord(row);
}

/** List committed versions newest first, with deterministic legacy tie-breakers. */
export async function listAccuracyPlans(
  workspace_id: string,
  limit = 20,
): Promise<AccuracyPlanRecord[]> {
  await ensureAccuracySchema();
  const rows = await accuracyDb()
    .select()
    .from(t.accuracyPlans)
    .where(eq(t.accuracyPlans.workspace_id, workspace_id))
    .orderBy(desc(t.accuracyPlans.version), desc(t.accuracyPlans.saved_at), desc(t.accuracyPlans.id))
    .limit(limit);
  return rows.map(toPlanRecord);
}

/**
 * Allocate and persist one version atomically on the shared Accuracy database.
 * A transaction-scoped advisory lock makes concurrent saves wait for this
 * workspace's previous commit. An insert error rolls back without consuming
 * a version; the transaction promise returns only after commit succeeds.
 */
export async function saveAccuracyPlan(args: {
  workspace_id: string;
  status: AccuracyPlanStatus;
  note: string;
  actor: Actor;
  snapshot: AccuracyPlanSnapshot;
}): Promise<AccuracyPlanRecord> {
  const note = requireValidationRationale(args.note);
  await ensureAccuracySchema();
  return accuracyDb().transaction(async (db) => {
    await db.execute(sql`select pg_advisory_xact_lock(hashtext('accuracy-plans'), hashtext(${args.workspace_id}))`);
    const [previous] = await db.select({ version: t.accuracyPlans.version })
      .from(t.accuracyPlans)
      .where(eq(t.accuracyPlans.workspace_id, args.workspace_id))
      .orderBy(desc(t.accuracyPlans.version))
      .limit(1);
    const record = {
      id: newId("plan"),
      workspace_id: args.workspace_id,
      version: (previous?.version ?? 0) + 1,
      status: args.status,
      snapshot: args.snapshot,
      note,
      saved_by: args.actor.name,
      saved_function: args.actor.function,
      saved_at: nowIso(),
    };
    // Let database errors escape: Drizzle rolls back and releases the lock.
    await db.insert(t.accuracyPlans).values(record);
    return record;
  });
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
