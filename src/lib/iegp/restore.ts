import { and, eq } from "drizzle-orm";
import { db } from "./db";
import * as t from "./schema";
import { recordEdit, requireRationale } from "@/modules/kernel/edit-records";
import type { ActorFunction } from "./enums";
import { appendAudit, ensureGapHasConstituentNeed, isMappingRowKey, loadState, makeLock, syncComputedGapStatuses } from "./store";

/**
 * Undo for every "set aside" decision (KAN-16): an excluded gap, a rejected
 * need, a rejected tactic and a rejected gap ↔ tactic mapping each come back
 * by a person's hand, with a rationale that is audited and filed as an edit
 * record. Nothing is restored silently, and a restore never re-decides the
 * item: it returns to the state a person decides from again.
 */

type RestoreActor = { actor_name: string; actor_function: ActorFunction; rationale: string };

async function fileRestore(args: {
  stage: "S2" | "S3" | "S4" | "S5";
  entity_type: string;
  entity_id: string;
  field: string;
  before: string;
  after: string;
  rationale: string;
  actor_name: string;
  actor_function: ActorFunction;
  audit_entity: string;
  audit_entity_id?: string;
  audit_action: string;
}) {
  await appendAudit(
    args.actor_name,
    args.actor_function,
    args.audit_entity,
    args.audit_entity_id ?? args.entity_id,
    args.audit_action,
    `${args.before} → ${args.after}: ${args.rationale}`,
  );
  await recordEdit({
    stage: args.stage,
    entity_type: args.entity_type,
    entity_id: args.entity_id,
    field: args.field,
    action: "edit",
    before: args.before,
    after: args.after,
    rationale: args.rationale,
    actor: { name: args.actor_name, function: args.actor_function },
  });
}

/**
 * Brings an excluded gap back. Its status is recomputed from its coverage and
 * it is unconfirmed again, so a person validates it on Gaps like any other.
 */
export async function restoreExcludedGap(args: RestoreActor & { gap_id: string }) {
  const rationale = requireRationale(args.rationale);
  const state = await loadState();
  const gap = state.gaps.find((g) => g.id === args.gap_id);
  if (!gap) throw new Error("Gap not found");
  if (gap.retired) throw new Error("A retired gap cannot be restored; its successor is the live gap.");
  if (gap.status !== "excluded") throw new Error("This gap is not excluded.");
  const reason = gap.exclusion_reason ?? "no reason";
  await db()
    .update(t.gaps)
    .set({
      status: "validated_open",
      computed_status: "validated_open",
      status_override: null,
      exclusion_reason: null,
      exclusion_note: null,
      human_validated: false,
      lock: makeLock(args.actor_name, args.actor_function, rationale),
    })
    .where(eq(t.gaps.id, args.gap_id));
  // A person's restore: the computation from coverage applies (Open, Partial or Addressed).
  await syncComputedGapStatuses(args.gap_id, { human: true });
  await ensureGapHasConstituentNeed(args.gap_id);
  const after = (await loadState()).gaps.find((g) => g.id === args.gap_id)?.status ?? "validated_open";
  await fileRestore({
    stage: "S5",
    entity_type: "gap",
    entity_id: args.gap_id,
    field: "status",
    before: `excluded (${reason})`,
    after: `${after}, unconfirmed`,
    rationale,
    actor_name: args.actor_name,
    actor_function: args.actor_function,
    audit_entity: "gap",
    audit_action: "restore",
  });
}

/** A rejected need goes back to a candidate for a person to accept or reject again. */
export async function restoreRejectedNeed(args: RestoreActor & { need_id: string }) {
  const rationale = requireRationale(args.rationale);
  const state = await loadState();
  const need = state.needs.find((n) => n.id === args.need_id);
  if (!need) throw new Error("Need not found");
  if (need.status !== "rejected") throw new Error("This need is not rejected.");
  await db()
    .update(t.needs)
    .set({ status: "candidate", lock: makeLock(args.actor_name, args.actor_function, rationale) })
    .where(eq(t.needs.id, args.need_id));
  await fileRestore({
    stage: "S2",
    entity_type: "need",
    entity_id: args.need_id,
    field: "status",
    before: "rejected",
    after: "candidate",
    rationale,
    actor_name: args.actor_name,
    actor_function: args.actor_function,
    audit_entity: "need",
    audit_action: "restore",
  });
}

/** A tactic a person rejected goes back into the library (accepted), ready to map. */
export async function restoreRejectedTactic(args: RestoreActor & { tactic_id: string }) {
  const rationale = requireRationale(args.rationale);
  const state = await loadState();
  const tactic = state.tactics.find((x) => x.id === args.tactic_id);
  if (!tactic) throw new Error("Tactic not found");
  if (tactic.review_status !== "rejected") throw new Error("This tactic is not rejected.");
  await db()
    .update(t.tactics)
    .set({ review_status: "accepted", lock: makeLock(args.actor_name, args.actor_function, rationale) })
    .where(eq(t.tactics.id, args.tactic_id));
  await fileRestore({
    stage: "S3",
    entity_type: "tactic",
    entity_id: args.tactic_id,
    field: "review_status",
    before: "rejected",
    after: "accepted",
    rationale,
    actor_name: args.actor_name,
    actor_function: args.actor_function,
    audit_entity: "tactic",
    audit_action: "restore",
  });
}

/** Every gap ↔ tactic pair a person rejected or removed, with who and why. */
export async function listRejectedMappings() {
  const state = await loadState();
  return state.mapping_suggestions
    .filter((m) => m.status === "rejected" && !isMappingRowKey(m.tactic_id))
    .map((m) => ({
      gap_id: m.gap_id,
      tactic_id: m.tactic_id,
      gap_name: state.gaps.find((g) => g.id === m.gap_id)?.name ?? m.gap_id,
      tactic_name: state.tactics.find((x) => x.id === m.tactic_id)?.name ?? m.tactic_id,
      note: m.lock.note ?? null,
      actor_name: m.lock.actor_name ?? null,
      at: m.lock.locked_at ?? null,
    }));
}

/**
 * Lifts a person's rejection of a gap ↔ tactic pair. The pair is not mapped:
 * it is simply no longer blocked, so it can be mapped by hand or proposed by
 * a later mapping run for a person to decide again.
 */
export async function restoreRejectedMapping(args: RestoreActor & { gap_id: string; tactic_id: string }) {
  const rationale = requireRationale(args.rationale);
  const state = await loadState();
  const row = state.mapping_suggestions.find(
    (m) => m.gap_id === args.gap_id && m.tactic_id === args.tactic_id && m.status === "rejected",
  );
  if (!row || isMappingRowKey(args.tactic_id)) throw new Error("This mapping is not rejected.");
  await db()
    .delete(t.mappingSuggestions)
    .where(and(eq(t.mappingSuggestions.gap_id, args.gap_id), eq(t.mappingSuggestions.tactic_id, args.tactic_id)));
  await fileRestore({
    stage: "S4",
    entity_type: "gap",
    entity_id: args.gap_id,
    field: "mapping",
    before: `rejected ${args.tactic_id}`,
    after: `not decided ${args.tactic_id}`,
    rationale,
    actor_name: args.actor_name,
    actor_function: args.actor_function,
    audit_entity: "mapping",
    audit_entity_id: `${args.gap_id}::${args.tactic_id}`,
    audit_action: "restore_mapping",
  });
}
