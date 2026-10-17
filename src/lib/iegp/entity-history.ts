import { recordedJudgementReferences } from "./judgement-references";
import { and, desc, gte, inArray, or, sql } from "drizzle-orm";
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
  /** A linked objective event, rather than a direct edit to this gap. */
  shared_context?: boolean;
  /** The other endpoint of a supplied tactic relationship event. */
  counterpart_gaps?: { id: string; name: string }[];
  counterpart_tactics?: { id: string; name: string }[];
  supporting_references?: ReturnType<typeof recordedJudgementReferences>;
};

const LIMIT = 200;

/**
 * Edit records and plan audit rows for these entities, newest first. An audit
 * row from the same request as an edit record of the same entity says less than
 * the edit (no before/after), so it is folded into it; rows from before
 * request ids were kept are all shown.
 */
export async function entityHistory(entityIds: string[], options: { since?: string | null } = {}): Promise<HistoryEntry[]> {
  const ids = [...new Set(entityIds.filter(Boolean))];
  if (ids.length === 0) return [];
  await ensurePlatformSchema();
  // Only this instance of the record (KAN-97): history from before the workspace's
  // last reset belongs to a plan that no longer exists.
  const since = options.since ?? null;
  const relatedOptions = db().select({ id: kernel.ideationProposals.id }).from(kernel.ideationProposals).where(or(
    inArray(kernel.ideationProposals.gap_id, ids), inArray(kernel.ideationProposals.tactic_id, ids), inArray(kernel.ideationProposals.target_tactic_id, ids),
  ));
  const editMatch = or(inArray(kernel.editRecords.entity_id, ids), inArray(kernel.editRecords.entity_id, relatedOptions), and(
    sql`${kernel.editRecords.entity_type} = 'gap_tactic'`,
    or(inArray(sql`split_part(${kernel.editRecords.entity_id}, '::', 1)`, ids), inArray(sql`split_part(${kernel.editRecords.entity_id}, '::', 2)`, ids)),
  ));
  const [edits, actions] = await Promise.all([
    db().select().from(kernel.editRecords)
      .where(since ? and(editMatch, gte(kernel.editRecords.at, since)) : editMatch)
      .orderBy(desc(kernel.editRecords.at)).limit(LIMIT),
    db().select().from(t.audit)
      .where(since ? and(inArray(t.audit.entity_id, ids), gte(t.audit.at, since)) : inArray(t.audit.entity_id, ids))
      .orderBy(desc(t.audit.at)).limit(LIMIT),
  ]);
  // A new unlink event retains the removed coverage IDs in its before snapshot.
  // Reuse those IDs to keep existing legacy history reachable, without inventing events.
  const retainedCoverages = new Map<string, { gap_id: string; tactic_id: string }>();
  for (const edit of edits.filter(row => row.entity_type === "gap_tactic")) {
    for (const value of [edit.before, edit.after]) {
      try {
        for (const row of JSON.parse(value ?? "null")?.coverages ?? []) {
          if (typeof row.id === "string" && typeof row.gap_id === "string" && typeof row.tactic_id === "string") retainedCoverages.set(row.id, row);
        }
      } catch { /* Incomplete older values remain honest and unchanged. */ }
    }
  }
  const removedIds = [...retainedCoverages.keys()].filter(id => !ids.includes(id));
  if (removedIds.length) {
    const [retainedEdits, retainedActions] = await Promise.all([
      db().select().from(kernel.editRecords).where(since ? and(inArray(kernel.editRecords.entity_id, removedIds), gte(kernel.editRecords.at, since)) : inArray(kernel.editRecords.entity_id, removedIds)).orderBy(desc(kernel.editRecords.at)).limit(LIMIT),
      db().select().from(t.audit).where(since ? and(inArray(t.audit.entity_id, removedIds), gte(t.audit.at, since)) : inArray(t.audit.entity_id, removedIds)).orderBy(desc(t.audit.at)).limit(LIMIT),
    ]);
    edits.push(...retainedEdits.filter(row => !edits.some(edit => edit.id === row.id)));
    actions.push(...retainedActions.filter(row => !actions.some(action => action.id === row.id)));
  }
  const referenceState = edits.some(row => row.supporting_references?.length || row.entity_type === "gap_tactic" || row.entity_type === "ideation_proposal") ? await (await import("./store")).loadState() : null;
  const optionIds = edits.filter(row => row.entity_type === "ideation_proposal").map(row => row.entity_id);
  const optionsById = new Map((optionIds.length ? await db().select().from(kernel.ideationProposals).where(inArray(kernel.ideationProposals.id, optionIds)) : []).map(row => [row.id, row]));
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
      ...(row.entity_type === "gap_tactic" && referenceState ? {
        counterpart_gaps: referenceState.gaps.filter(gap => gap.id === row.entity_id.split("::")[0]).map(gap => ({ id: gap.id, name: gap.name })),
        counterpart_tactics: referenceState.tactics.filter(tactic => tactic.id === row.entity_id.split("::")[1]).map(tactic => ({ id: tactic.id, name: tactic.name })),
      } : {}),
      supporting_references: referenceState ? recordedJudgementReferences(referenceState, row.supporting_references) : [],
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
  for (const entry of entries) {
    const option = entry.entity_type === "ideation_proposal" ? optionsById.get(entry.entity_id) : null;
    if (option && referenceState) {
      entry.counterpart_gaps = referenceState.gaps.filter(gap => gap.id === option.gap_id).map(gap => ({ id: gap.id, name: gap.name }));
      entry.counterpart_tactics = referenceState.tactics.filter(tactic => tactic.id === option.tactic_id || tactic.id === option.target_tactic_id).map(tactic => ({ id: tactic.id, name: tactic.name }));
    }
    const pair = retainedCoverages.get(entry.entity_id);
    if (!pair || !referenceState) continue;
    entry.counterpart_gaps = referenceState.gaps.filter(gap => gap.id === pair.gap_id).map(gap => ({ id: gap.id, name: gap.name }));
    entry.counterpart_tactics = referenceState.tactics.filter(tactic => tactic.id === pair.tactic_id).map(tactic => ({ id: tactic.id, name: tactic.name }));
  }
  return entries.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : b.id.localeCompare(a.id))).slice(0, LIMIT);
}
