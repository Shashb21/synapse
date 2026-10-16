/** Cited source links and possible discrepancies; human corrections use canonical edit owners. */
import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db, ensureSchema, withWorkspaceTransaction } from "./db";
import * as t from "./schema";
import { appendAudit, loadState, lockAssessmentOwners, modifyGap, modifyTactic, type TacticEditField } from "./store";
import { recordEdit, requireRationale } from "@/modules/kernel/edit-records";
import { newId, nowIso } from "@/modules/kernel/ids";
import type { ActorFunction } from "./enums";
import type { IegpState, SourceReview } from "./types";

/** Substantive fields already supported by the canonical gap and tactic editors. */
export const SOURCE_CORRECTION_FIELDS = {
  gap: ["statement", "domain"],
  tactic: ["type", "evidence_question", "population", "intervention", "comparator", "outcomes", "study_design", "data_source", "geography", "start_date", "evidence_available"],
} as const;
type Target = keyof typeof SOURCE_CORRECTION_FIELDS;
type ActorArgs = { actor_name: string; actor_function: ActorFunction };
export type SourceReviewInput = ActorArgs & {
  source_id: string; block_id: string; passage: string; gap_id?: string | null;
  tactic_id?: string | null; coverage_id?: string | null; rationale: string; origin: "human" | "ai";
};
function normalize(value: string): string { return value.replace(/\s+/g, " ").trim(); }
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex"); }

/** Whether the saved, immutable passage still occurs in its cited retained block. */
export function sourceReviewCitationCurrent(state: IegpState, review: Pick<SourceReview, "source_id" | "block_id" | "passage">): boolean {
  const block = state.blocks.find(b => b.id === review.block_id && b.source_id === review.source_id);
  return Boolean(state.sources.some(s => s.id === review.source_id) && block && normalize(review.passage) && normalize(block.text).includes(normalize(review.passage)));
}

/** Optimistic target token includes the actual record and affected relationship judgements. */
export function sourceReviewTargetVersion(state: IegpState, review: Pick<SourceReview, "gap_id" | "tactic_id">, target: Target): string {
  const record = target === "gap" ? state.gaps.find(g => g.id === review.gap_id) : state.tactics.find(tactic => tactic.id === review.tactic_id);
  if (!record) throw new Error("Correction target not found in this plan.");
  const coverages = state.coverages.filter(c => target === "gap" ? c.gap_id === review.gap_id : c.tactic_id === review.tactic_id).sort((a, b) => a.id.localeCompare(b.id));
  const needs = target === "gap" ? state.need_gap_links.filter(l => l.gap_id === review.gap_id).map(l => state.needs.find(n => n.id === l.need_id)).sort((a, b) => (a?.id ?? "").localeCompare(b?.id ?? "")) : [];
  return hash({ record, coverages, needs });
}
function validateTargets(state: IegpState, args: Pick<SourceReviewInput, "gap_id" | "tactic_id" | "coverage_id">): void {
  if (!args.gap_id && !args.tactic_id) throw new Error("Choose an affected gap or tactic in this plan.");
  if (args.gap_id && !state.gaps.some(g => g.id === args.gap_id)) throw new Error("Affected gap not found in this plan.");
  if (args.tactic_id && !state.tactics.some(tactic => tactic.id === args.tactic_id)) throw new Error("Affected tactic not found in this plan.");
  if (args.coverage_id) {
    const coverage = state.coverages.find(c => c.id === args.coverage_id);
    if (!coverage || !args.gap_id || !args.tactic_id || coverage.gap_id !== args.gap_id || coverage.tactic_id !== args.tactic_id) throw new Error("The affected relationship must match its gap and tactic in this plan.");
  } else if (args.gap_id && args.tactic_id && !state.coverages.some(c => c.gap_id === args.gap_id && c.tactic_id === args.tactic_id)) {
    throw new Error("Gap and tactic must have an affected relationship in this plan.");
  }
}
async function lockTargets(args: Pick<SourceReviewInput, "source_id" | "gap_id" | "tactic_id">): Promise<void> {
  // Source edits take this source row first too; then the shared tactic/need/gap ordering.
  await db().execute(sql`select id from sources where id = ${args.source_id} for update`);
  await lockAssessmentOwners({ source_ids: [args.source_id], gap_ids: args.gap_id ? [args.gap_id] : [], tactic_ids: args.tactic_id ? [args.tactic_id] : [] });
}
async function recordDecision(row: SourceReview, args: ActorArgs, action: "add" | "accept" | "reject", before: string | null, rationale: string): Promise<void> {
  await appendAudit(args.actor_name, args.actor_function, "source_review", row.id, action, rationale);
  await recordEdit({ stage: "S5", entity_type: "source_review", entity_id: row.id, field: "review", action, before, after: JSON.stringify(row), rationale, actor: { name: args.actor_name, function: args.actor_function } });
}
async function createReview(kind: SourceReview["kind"], args: SourceReviewInput): Promise<string> {
  await ensureSchema();
  return withWorkspaceTransaction(async () => {
    const rationale = requireRationale(args.rationale);
    if (args.origin !== "human" && args.origin !== "ai") throw new Error("Source review origin is required.");
    const selected = await loadState();
    const coverage = args.coverage_id ? selected.coverages.find(c => c.id === args.coverage_id) : undefined;
    const block = selected.blocks.find(b => b.id === args.block_id);
    args = { ...args, source_id: args.source_id || block?.source_id || "",
      gap_id: args.gap_id || coverage?.gap_id, tactic_id: args.tactic_id || coverage?.tactic_id };
    await lockTargets(args);
    const state = await loadState();
    validateTargets(state, args);
    if (!args.passage || !sourceReviewCitationCurrent(state, args)) throw new Error("Cite an actual passage in the retained source block in this plan.");
    const passage = args.passage.trim();
    const id = `SRCREVIEW-${hash({ kind, source: args.source_id, block: args.block_id, passage: normalize(passage), gap: args.gap_id || null, tactic: args.tactic_id || null, coverage: args.coverage_id || null, claim: kind === "discrepancy" ? normalize(rationale) : null })}`;
    const row: SourceReview = { id, version: newId("review"), kind, origin: args.origin, source_id: args.source_id,
      block_id: args.block_id, passage, source_title: state.sources.find(s => s.id === args.source_id)!.title,
      source_location: state.blocks.find(b => b.id === args.block_id)!.location,
      gap_id: args.gap_id || null, tactic_id: args.tactic_id || null, coverage_id: args.coverage_id || null,
      rationale, status: kind === "support" ? "linked" : "pending", created_at: nowIso(),
      created_by: { name: args.actor_name, function: args.actor_function }, history: [] };
    const inserted = await db().insert(t.sourceReviews).values({ id, version: row.version, record: row }).onConflictDoNothing().returning();
    if (inserted.length) await recordDecision(row, args, "add", null, rationale);
    return id;
  });
}
/** Attach support without changing coverage, confirmations, or existing review decisions. */
export function linkSourceSupport(args: SourceReviewInput): Promise<string> { return createReview("support", args); }
/** Record a possible source discrepancy, including AI proposals, without applying it. */
export function createSourceDiscrepancy(args: SourceReviewInput): Promise<string> { return createReview("discrepancy", args); }

/** Resolve one pending finding; acceptance requires an explicit reviewed canonical correction. */
export async function resolveSourceDiscrepancy(args: ActorArgs & {
  review_id: string; expected_version: string; decision: string; rationale: string;
  reviewed_change?: boolean; correction_target?: string; correction_field?: string; correction_value?: string; expected_target_version?: string;
}): Promise<void> {
  await ensureSchema();
  await withWorkspaceTransaction(async () => {
    const rationale = requireRationale(args.rationale);
    const initial = (await db().select().from(t.sourceReviews).where(eq(t.sourceReviews.id, args.review_id)))[0]?.record;
    if (!initial) throw new Error("Source review not found in this plan.");
    await lockTargets(initial);
    const current = (await db().select().from(t.sourceReviews).where(eq(t.sourceReviews.id, args.review_id)).for("update"))[0];
    if (!current || !args.expected_version || current.version !== args.expected_version || current.record.status !== "pending") throw new Error("Source review changed; refresh before deciding.");
    const row = current.record;
    const state = await loadState();
    validateTargets(state, row);
    if (args.decision !== "accept" && args.decision !== "dismiss") throw new Error("Choose accept or dismiss.");
    let correction: SourceReview["history"][number]["correction"];
    if (args.decision === "accept") {
      if (!args.reviewed_change) throw new Error("Explicitly review the underlying correction before accepting.");
      if (!sourceReviewCitationCurrent(state, row)) throw new Error("The cited source passage changed; inspect the saved citation and create a current finding before accepting.");
      const target = args.correction_target;
      if (target !== "gap" && target !== "tactic") throw new Error("Choose a gap or tactic correction.");
      if (!args.expected_target_version || sourceReviewTargetVersion(state, row, target) !== args.expected_target_version) throw new Error("Correction target changed; refresh before reviewing.");
      const field = args.correction_field;
      if (!field || !(SOURCE_CORRECTION_FIELDS[target] as readonly string[]).includes(field) || typeof args.correction_value !== "string" || !args.correction_value.trim()) throw new Error("Choose a supported substantive correction field and value.");
      const record = target === "gap" ? state.gaps.find(g => g.id === row.gap_id)! : state.tactics.find(tactic => tactic.id === row.tactic_id)!;
      correction = { target, field, before: String((record as unknown as Record<string, unknown>)[field] ?? ""), value: args.correction_value.trim() };
      if (correction.before === correction.value) throw new Error("Review an actual underlying change before accepting.");
      if (target === "gap") await modifyGap({ gap_id: row.gap_id!, [field]: correction.value, rationale, actor_name: args.actor_name, actor_function: args.actor_function });
      else await modifyTactic({ tactic_id: row.tactic_id!, fields: { [field as TacticEditField]: correction.value }, rationale, actor_name: args.actor_name, actor_function: args.actor_function });
    }
    const updated: SourceReview = { ...row, version: newId("review"), status: args.decision === "accept" ? "accepted" : "dismissed",
      history: [...row.history, { decision: args.decision, rationale, at: nowIso(), actor: { name: args.actor_name, function: args.actor_function }, ...(correction ? { correction } : {}) }] };
    const written = await db().update(t.sourceReviews).set({ version: updated.version, record: updated }).where(and(eq(t.sourceReviews.id, row.id), eq(t.sourceReviews.version, args.expected_version))).returning();
    if (!written.length) throw new Error("Source review changed; refresh before deciding.");
    await recordDecision(updated, args, args.decision === "accept" ? "accept" : "reject", JSON.stringify(row), rationale);
  });
}
