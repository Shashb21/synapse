/** Canonical child-scope lifecycle. Source owners validate proposals before composing acceptance. */
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, ensureCurrentSchemaTables } from "./db";
import * as t from "./schema";
import { ACTOR_FUNCTIONS, TACTIC_STATUSES, type TacticStatus } from "./enums";
import { emptyDimensions, unlocked } from "./engine";
import { readState, syncComputedGapStatuses } from "./store";
import { tacticDatesError } from "./tactic-dates";
import { requireRationale } from "@/modules/kernel/edit-records";
import { newId, nowIso } from "@/modules/kernel/ids";
import type { Actor, ExpansionScope, Tactic, TacticExpansion } from "./types";

export type ExpansionTransaction = Parameters<Parameters<ReturnType<typeof db>["transaction"]>[0]>[0];
const text = z.string().trim();
const requiredText = text.min(1);
/** Shared strict payload contract for S3/S9 proposals and canonical acceptance. */
export const expansionScopeSchema = z.object({
  name: requiredText, evidence_question: requiredText, population: text, outcomes: text,
  geography: text, data_cut: text, analysis: text, instrument: text,
  study_design: requiredText, gap_coverage: requiredText, cost_effort: requiredText,
  timing: requiredText, feasibility_risks: requiredText,
  post_hoc: z.boolean(), prospective_enrolment: z.boolean(), protocol_amendment: z.boolean(),
  start_date: text.nullable(), evidence_available: text.nullable(),
}).strict().superRefine((scope, ctx) => {
  if (![scope.population, scope.outcomes, scope.geography, scope.data_cut, scope.analysis, scope.instrument].some(Boolean)) {
    ctx.addIssue({code: "custom", message: "Expansion scope must specify added population, endpoints, geography, data cut, analysis or instrument."});
  }
  const dates = tacticDatesError(scope.start_date, scope.evidence_available);
  if (dates) ctx.addIssue({code: "custom", message: dates});
});

function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") return Object.fromEntries(
      Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]),
    );
    return value;
}

/** Stable optimistic version: a stale proposal cannot amend a changed parent. */
export function tacticVersion(tactic: Tactic): string {
  // Persisted optional fields have canonical defaults so seed/import and loaded rows agree.
  const value = { ...tactic, source_quote: tactic.source_quote ?? "", custom_type: tactic.custom_type ?? null };
  const sorted = Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));

  return createHash("sha256").update(JSON.stringify(canonical(sorted))).digest("hex");
}

function validateActor(actor: Actor) {
  if (!actor?.name?.trim() || !(ACTOR_FUNCTIONS as readonly string[]).includes(actor.function)) {
    throw new Error("A named actor with a known function is required.");
  }
}

export type AcceptExpansionArgs = {
  proposal_id: string; tactic_id: string; gap_id: string; scope: ExpansionScope;
  rationale: string; actor: Actor; expected_tactic_version: string;
};

/**
 * Creates a proposed child, scoped assessment and acceptance history atomically.
 * Pass the source owner's transaction after locking and validating its pending proposal.
 * Exact retries return the original child; changed retries are refused.
 */
export async function acceptTacticExpansion(args: AcceptExpansionArgs, transaction?: ExpansionTransaction): Promise<TacticExpansion> {
  const rationale = requireRationale(args.rationale);
  validateActor(args.actor);
  if (!args.proposal_id?.trim()) throw new Error("An expansion proposal origin is required.");
  const scope = expansionScopeSchema.parse(args.scope);
  const run = async (tx: ExpansionTransaction) => {
    // All operations use this transaction, including state/status reads (max=1 safe).
    const [parent] = await tx.select().from(t.tactics).where(eq(t.tactics.id, args.tactic_id)).for("update");
    if (!parent) throw new Error("Tactic not found in this workspace.");
    // Parent then gap is the acceptance lock order; serialise computation for this gap.
    await tx.select().from(t.gaps).where(eq(t.gaps.id, args.gap_id)).for("update");
    const state = await readState(tx);
    const tactic = state.tactics.find((p) => p.id === args.tactic_id)!;
    const gap = state.gaps.find((g) => g.id === args.gap_id);
    if (!gap || gap.retired || gap.status === "excluded") throw new Error("Live gap not found in this workspace.");
    if (tactic.review_status !== "accepted" || tactic.status === "cancelled") throw new Error("Expansion requires an accepted, active tactic.");
    if (tacticVersion(tactic) !== args.expected_tactic_version) throw new Error("Tactic changed; refresh the stale proposal before accepting.");
    const existing = state.expansions.find((e) => e.proposal_id === args.proposal_id);
    if (existing) {
      if (existing.tactic_id !== args.tactic_id || !existing.gap_ids.includes(args.gap_id) || JSON.stringify(canonical(existing.scope)) !== JSON.stringify(canonical(scope))) {
        throw new Error("Proposal already accepted with different scope or parent.");
      }
      return existing;
    }
    if (tactic.status === "completed" && scope.prospective_enrolment) throw new Error("Completed studies cannot add prospective enrolment.");
    if (/post[- ]?hoc/i.test(scope.analysis) && !scope.post_hoc) throw new Error("Post-hoc analysis must be identified as post_hoc.");
    const at = nowIso(), version = newId("EXV");
    const child: TacticExpansion = {
      id: newId("EXP"), tactic_id: args.tactic_id, gap_ids: [args.gap_id], scope,
      status: "proposed", proposal_id: args.proposal_id, version,
      history: [{action: "accept", at, actor: args.actor, rationale, status: "proposed", version}],
      created_at: at, updated_at: at, actor: args.actor,
    };
    await tx.insert(t.tacticExpansions).values(child);
    await tx.insert(t.coverages).values({id: newId("COV"), tactic_id: args.tactic_id, gap_id: args.gap_id,
      expansion_id: child.id, dimensions: emptyDimensions(), overall: "unassessed", overall_rationale: rationale,
      overall_lock: unlocked(), stale: false, needs_review: false});
    // The explicit acceptance history is the permission for this child scope only.
    // Preserve the parent's mapping decision and every sibling's rejection memory.
    await tx.insert(t.audit).values({id: newId("AUD"), at, actor_name: args.actor.name, actor_function: args.actor.function,
      entity_type: "tactic_expansion", entity_id: child.id, action: "accept", detail: `${args.proposal_id}: ${rationale}`});
    await syncComputedGapStatuses(args.gap_id, undefined, tx);
    return child;
  };
  if (transaction) return run(transaction);
  await ensureCurrentSchemaTables();
  return db().transaction(run);
}

/** Records a human lifecycle change without editing scope, parent design or coverage locks. */
export async function setExpansionStatus(args: {
  expansion_id: string; status: TacticStatus; rationale: string; actor: Actor; expected_version: string;
}): Promise<TacticExpansion> {
  const rationale = requireRationale(args.rationale);
  validateActor(args.actor);
  if (!(TACTIC_STATUSES as readonly string[]).includes(args.status)) throw new Error("Unknown expansion status.");
  await ensureCurrentSchemaTables();
  return db().transaction(async (tx) => {
    const [row] = await tx.select().from(t.tacticExpansions).where(eq(t.tacticExpansions.id, args.expansion_id)).for("update");
    if (!row) throw new Error("Expansion not found in this workspace.");
    const child = row as TacticExpansion;
    if (child.version !== args.expected_version) throw new Error("Expansion changed; refresh the stale version.");
    for (const gapId of [...child.gap_ids].sort()) await tx.select().from(t.gaps).where(eq(t.gaps.id, gapId)).for("update");
    const at = nowIso(), version = newId("EXV");
    const updated: TacticExpansion = {...child, status: args.status, updated_at: at, version,
      history: [...child.history, {action: "status", at, actor: args.actor, rationale, status: args.status, version}]};
    await tx.update(t.tacticExpansions).set(updated).where(eq(t.tacticExpansions.id, child.id));
    await tx.insert(t.audit).values({id: newId("AUD"), at, actor_name: args.actor.name, actor_function: args.actor.function,
      entity_type: "tactic_expansion", entity_id: child.id, action: "status", detail: `${child.status} → ${args.status}: ${rationale}`});
    for (const gapId of child.gap_ids) await syncComputedGapStatuses(gapId, undefined, tx);
    return updated;
  });
}
