import { desc, inArray } from "drizzle-orm";
import { db, ensurePlatformSchema } from "@/modules/kernel/db";
import * as kernel from "@/modules/kernel/schema";
import * as t from "./schema";

/**
 * One change to a gap or tactic as its History section shows it (KAN-90): who
 * (name, principal, role), when, what changed from what to what, and why.
 */
export type HistoryEntry = {
  id: string;
  at: string;
  /** "edit": a field change with before/after; "action": a plan action's audit row. */
  kind: "edit" | "action";
  entity_type: string;
  entity_id: string;
  action: string;
  field: string | null;
  before: string | null;
  after: string | null;
  rationale: string | null;
  actor_name: string;
  actor_function: string;
  actor_principal: string | null;
  actor_role: string | null;
  request_id: string | null;
};

const LIMIT = 200;

/**
 * Edit records and plan audit rows for these entities, newest first. An audit
 * row from the same request as an edit record of the same entity says less than
 * the edit (no before/after), so it is folded into it; rows from before
 * request ids were kept are all shown.
 */
export async function entityHistory(entityIds: string[]): Promise<HistoryEntry[]> {
  const ids = [...new Set(entityIds.filter(Boolean))];
  if (ids.length === 0) return [];
  await ensurePlatformSchema();
  const [edits, actions] = await Promise.all([
    db().select().from(kernel.editRecords).where(inArray(kernel.editRecords.entity_id, ids)).orderBy(desc(kernel.editRecords.at)).limit(LIMIT),
    db().select().from(t.audit).where(inArray(t.audit.entity_id, ids)).orderBy(desc(t.audit.at)).limit(LIMIT),
  ]);
  const editKeys = new Set(edits.filter((row) => row.request_id).map((row) => `${row.request_id}|${row.entity_id}`));
  const entries: HistoryEntry[] = [
    ...edits.map((row) => ({
      id: row.id,
      at: row.at,
      kind: "edit" as const,
      entity_type: row.entity_type,
      entity_id: row.entity_id,
      action: row.action,
      field: row.field,
      before: row.before,
      after: row.after,
      rationale: row.rationale,
      actor_name: row.actor_name,
      actor_function: row.actor_function,
      actor_principal: row.actor_principal ?? null,
      actor_role: row.actor_role ?? null,
      request_id: row.request_id ?? null,
    })),
    ...actions
      .filter((row) => !(row.request_id && editKeys.has(`${row.request_id}|${row.entity_id}`)))
      .map((row) => ({
        id: row.id,
        at: row.at,
        kind: "action" as const,
        entity_type: row.entity_type,
        entity_id: row.entity_id,
        action: row.action,
        field: null,
        before: null,
        after: null,
        rationale: row.detail || null,
        actor_name: row.actor_name,
        actor_function: row.actor_function,
        actor_principal: row.actor_principal ?? null,
        actor_role: row.actor_role ?? null,
        request_id: row.request_id ?? null,
      })),
  ];
  return entries.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : b.id.localeCompare(a.id))).slice(0, LIMIT);
}
