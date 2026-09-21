import { desc, eq } from "drizzle-orm";
import { db, ensurePlatformSchema } from "./db";
import * as t from "./schema";
import { newId, nowIso } from "./ids";
import { recordSignal } from "./hillclimb";
import type { Actor, StageId } from "./contracts";

export type EditAction = "edit" | "accept" | "reject" | "add" | "split" | "validate" | "override";

export type EditRecord = {
  id: string;
  at: string;
  workspace_id: string;
  stage: StageId;
  entity_type: string;
  entity_id: string;
  field: string;
  action: EditAction;
  before: string | null;
  after: string | null;
  rationale: string;
  actor: Actor;
};

export const RATIONALE_REQUIRED = "A short rationale is required for every edit.";

export function requireRationale(rationale: string | null | undefined): string {
  const trimmed = (rationale ?? "").trim();
  if (trimmed.length < 3) throw new Error(RATIONALE_REQUIRED);
  return trimmed;
}

/**
 * Persists a user edit with its rationale and feeds the same edit into the
 * hillclimb store. Every user-facing module calls this on every edit.
 */
export async function recordEdit(args: {
  workspace_id?: string;
  stage: StageId;
  entity_type: string;
  entity_id: string;
  field: string;
  action: EditAction;
  before?: string | null;
  after?: string | null;
  rationale: string;
  actor: Actor;
  signal_kind?: "user_edit" | "user_rejected_proposal" | "user_accepted_proposal";
}): Promise<EditRecord> {
  await ensurePlatformSchema();
  const rationale = requireRationale(args.rationale);
  const record: EditRecord = {
    id: newId("edit"),
    at: nowIso(),
    workspace_id: args.workspace_id ?? "default",
    stage: args.stage,
    entity_type: args.entity_type,
    entity_id: args.entity_id,
    field: args.field,
    action: args.action,
    before: args.before ?? null,
    after: args.after ?? null,
    rationale,
    actor: args.actor,
  };
  await db().insert(t.editRecords).values({
    id: record.id,
    at: record.at,
    workspace_id: record.workspace_id,
    stage: record.stage,
    entity_type: record.entity_type,
    entity_id: record.entity_id,
    field: record.field,
    action: record.action,
    before: record.before,
    after: record.after,
    rationale: record.rationale,
    actor_name: record.actor.name,
    actor_function: record.actor.function,
  });
  await recordSignal({
    stage: args.stage,
    kind:
      args.signal_kind ??
      (args.action === "reject"
        ? "user_rejected_proposal"
        : args.action === "accept"
          ? "user_accepted_proposal"
          : "user_edit"),
    subject: `${record.entity_type}:${record.entity_id}`,
    rationale,
    payload: {
      field: record.field,
      action: record.action,
      before: record.before,
      after: record.after,
      actor_function: record.actor.function,
    },
  });
  return record;
}

function toRecord(row: typeof t.editRecords.$inferSelect): EditRecord {
  return {
    id: row.id,
    at: row.at,
    workspace_id: row.workspace_id,
    stage: row.stage as StageId,
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    field: row.field,
    action: row.action as EditAction,
    before: row.before,
    after: row.after,
    rationale: row.rationale,
    actor: { name: row.actor_name, function: row.actor_function as Actor["function"] },
  };
}

export async function listEdits(args?: {
  stage?: StageId;
  entity_id?: string;
  limit?: number;
}): Promise<EditRecord[]> {
  await ensurePlatformSchema();
  const limit = args?.limit ?? 100;
  const base = db().select().from(t.editRecords);
  if (args?.entity_id) {
    const rows = await base
      .where(eq(t.editRecords.entity_id, args.entity_id))
      .orderBy(desc(t.editRecords.at))
      .limit(limit);
    return rows.map(toRecord);
  }
  if (args?.stage) {
    const rows = await base
      .where(eq(t.editRecords.stage, args.stage))
      .orderBy(desc(t.editRecords.at))
      .limit(limit);
    return rows.map(toRecord);
  }
  const rows = await base.orderBy(desc(t.editRecords.at)).limit(limit);
  return rows.map(toRecord);
}
