import { AsyncLocalStorage } from "node:async_hooks";
import { DrizzleQueryError, eq, sql } from "drizzle-orm";
import * as tables from "./schema";
import { db, withWorkspaceTransaction } from "./db";
import { gapResolutionVersion, relationshipSnapshot, relationshipVersion } from "./relationship-version";
import { matchesSuppliedJudgementRecords, inspectJudgementReferences, suppliedJudgementRecords, type JudgementReference } from "./judgement-references";
import { recordEdit, requireRationale } from "@/modules/kernel/edit-records";
import { tacticEditVersion } from "./tactic-edit-version";
import type { ActorFunction } from "./enums";
import type { IegpState } from "./types";

const active = new AsyncLocalStorage<ChangeActor>();
type ChangeActor = { actor_name: string; actor_function: ActorFunction; rationale?: string; note?: string; references?: JudgementReference[]; model?: boolean; supplied_records?: ReturnType<typeof suppliedJudgementRecords>; expected_tactic_version?: string; tactic_id?: string };

/** All relationship owners join this transaction. Serialises set edits and sibling review
 * transitions too; no second audit store or duplicate event for nested owner calls. */
export async function withRelationshipChange<T>(args: ChangeActor, change: () => Promise<T>, onRecorded?: (id: string) => void): Promise<T> {
  if (active.getStore()) return change();
  return withWorkspaceTransaction(async () => {
    await lockRelationships();
    const { loadState } = await import("./store");
    if (args.model && args.supplied_records) {
      // Hold the supplied scientific records through the comparison and save.
      if (args.tactic_id) await db().select({ id: tables.tactics.id }).from(tables.tactics).where(eq(tables.tactics.id, args.tactic_id)).for("update");
      for (const [kind, table] of [["objective", tables.objectives], ["source", tables.sources], ["gap", tables.gaps]] as const) {
        const ids = [...new Set(args.supplied_records.filter(row => row.entity_type === kind).map(row => row.entity_id))].sort();
        for (const id of ids) await db().select({ id: table.id }).from(table).where(eq(table.id, id)).for("update");
      }
    }
    const before = await loadState();
    if (args.model && args.supplied_records) {
      const gapIds = args.supplied_records.filter(record => record.entity_type === "gap").map(record => record.entity_id);
      const tactic = before.tactics.find(row => row.id === args.tactic_id);
      if (!matchesSuppliedJudgementRecords(before, gapIds, args.supplied_records) ||
          !tactic || args.expected_tactic_version !== tacticEditVersion(tactic)) {
        throw new Error("Model judgement context changed. Regenerate it or make a manual judgement with a reason.");
      }
    }
    const result = await active.run(args, change);
    const after = await loadState();
    const pairs = new Map<string, [string, string]>();
    for (const state of [before, after]) {
      for (const row of [...state.coverages, ...state.mapping_suggestions]) {
        if (!row.tactic_id.startsWith("__row__:")) pairs.set(`${row.gap_id}::${row.tactic_id}`, [row.gap_id, row.tactic_id]);
      }
    }
    for (const [id, [gapId, tacticId]] of pairs) {
      const previous = relationshipVersion(relationshipSnapshot(before, gapId, tacticId));
      const next = relationshipVersion(relationshipSnapshot(after, gapId, tacticId));
      if (previous === next) continue;
      const reason = requireRationale(args.rationale || args.note);
      if (args.model && !inspectJudgementReferences(before, [gapId], args.references).length) {
        throw new Error("Supporting references are missing, inaccessible or unrelated to this judgement. Make a manual judgement with a reason instead.");
      }
      const edit = await recordEdit({ stage: "S5", entity_type: "gap_tactic", entity_id: id,
        field: args.model ? "model_relationship" : "relationship", action: "edit",
        before: previous, after: next, rationale: reason,
        references: args.references, reference_gap_ids: [gapId],
        actor: { name: args.actor_name, function: args.actor_function },
      });
      onRecorded?.(edit.id);
    }
    return result;
  }).catch(error => {
    if (error instanceof DrizzleQueryError) throw new Error("Could not save the relationship and its history. Your input and reason have not been saved. Try again.", { cause: error.cause ?? error });
    throw error;
  });
}

/** Used by routes before reading opening snapshots; nested owners take the same lock. */
export async function lockRelationships() {
  await db().execute(sql`SELECT pg_advisory_xact_lock(hashtext(current_schema()), hashtext('gap-tactic relationships'))`);
}

/** Route input is compared after taking the write lock, never trusted as current state. */
export function requireRelationshipSnapshot(state: IegpState, body: Record<string, string>) {
  const coverage = state.coverages.find(row => row.id === body.coverage_id);
  const gapId = coverage?.gap_id ?? body.gap_id;
  const tacticId = coverage?.tactic_id ?? body.tactic_id;
  let expected: unknown;
  try { expected = JSON.parse(body.expected_relationship ?? ""); } catch { /* Missing input is stale too. */ }
  const current = body.action === "save_mapping_row"
    ? { coverages: state.coverages.filter(row => row.gap_id === gapId), decisions: state.mapping_suggestions.filter(row => row.gap_id === gapId) }
    : relationshipSnapshot(state, gapId, tacticId);
  if (relationshipVersion(expected) !== relationshipVersion(current)) {
    throw new Error("Relationship changed or its opening snapshot is missing. Your input and reason have not been saved. Reload the latest record and retry.");
  }
}

export function relationshipReason(): string | undefined {
  const actor = active.getStore();
  return actor?.rationale || actor?.note;
}

/** Nested source owners share the outer owner’s one relationship event. */
export function inRelationshipChange(): boolean {
  return Boolean(active.getStore());
}

/** Invoked by the resolving owner after its locks and before any mutation. */
export function requireGapResolutionSnapshot(state: IegpState, gapId: string, expected?: string) {
  if (!expected || expected !== gapResolutionVersion(state, gapId)) {
    throw new Error("Gap relationships or evidence scope changed, or the opening snapshot is missing. Your fields and reason have not been saved. Reload the latest record or regenerate the proposal and retry.");
  }
}
