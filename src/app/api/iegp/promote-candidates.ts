import { and, desc, eq } from "drizzle-orm";
import { db, ensurePlatformSchema } from "@/modules/kernel/db";
import { recordEdit, requireRationale } from "@/modules/kernel/edit-records";
import { GAP_CANDIDATES_DDL, gapCandidates } from "@/modules/stages/s2-gap-extract/schema";
import {
  TACTIC_CANDIDATES_DDL,
  TACTIC_CANDIDATES_DUPLICATE_DDL,
  tacticCandidates,
} from "@/modules/stages/s3-tactic-extract/schema";
import { createGap, loadState, recordMissedTactic } from "@/lib/iegp/store";
import {
  EVIDENCE_DOMAINS,
  TACTIC_TYPES,
  type ActorFunction,
  type EvidenceDomain,
  type TacticType,
} from "@/lib/iegp/enums";

/**
 * Candidates the S2/S3 judge rejected stay on record. A person can promote one
 * into the plan by hand: the gap or tactic is created as a human record (with the
 * candidate's source quote as provenance) and the override is filed as an edit.
 */

export type RejectedGapCandidate = typeof gapCandidates.$inferSelect;
export type RejectedTacticCandidate = typeof tacticCandidates.$inferSelect & {
  promoted_tactic_id: string | null;
};

export async function listRejectedGapCandidates(limit = 200): Promise<RejectedGapCandidate[]> {
  await ensurePlatformSchema([GAP_CANDIDATES_DDL]);
  return db()
    .select()
    .from(gapCandidates)
    .where(eq(gapCandidates.verdict, "reject"))
    .orderBy(desc(gapCandidates.created_at))
    .limit(limit);
}

export async function listRejectedTacticCandidates(limit = 200): Promise<RejectedTacticCandidate[]> {
  await ensurePlatformSchema([TACTIC_CANDIDATES_DDL, TACTIC_CANDIDATES_DUPLICATE_DDL]);
  const [rows, state] = await Promise.all([
    db()
      .select()
      .from(tacticCandidates)
      .where(eq(tacticCandidates.verdict, "reject"))
      .orderBy(desc(tacticCandidates.created_at))
      .limit(limit),
    loadState(),
  ]);
  return rows.map((row) => {
    const promoted = state.tactics.find(
      (tactic) =>
        tactic.name.trim().toLowerCase() === row.name.trim().toLowerCase() &&
        (tactic.source_quote ?? "") === row.source_quote.trim(),
    );
    return { ...row, promoted_tactic_id: promoted?.id ?? null };
  });
}

export async function promoteGapCandidate(args: {
  candidate_id: string;
  name?: string;
  statement?: string;
  domain?: string;
  rationale: string;
  actor_name: string;
  actor_function: ActorFunction;
}): Promise<string> {
  const rationale = requireRationale(args.rationale);
  await ensurePlatformSchema([GAP_CANDIDATES_DDL]);
  const [row] = await db()
    .select()
    .from(gapCandidates)
    .where(and(eq(gapCandidates.id, args.candidate_id), eq(gapCandidates.verdict, "reject")));
  if (!row) throw new Error("Rejected gap candidate not found.");
  if (row.committed_gap_id) throw new Error(`Already promoted as ${row.committed_gap_id}.`);
  const domain = (args.domain || row.domain) as EvidenceDomain;
  const gapId = await createGap({
    name: args.name?.trim() || row.name,
    statement: args.statement?.trim() || row.statement,
    domain: EVIDENCE_DOMAINS.includes(domain) ? domain : undefined,
    source_id: row.source_id,
    source_quote: row.source_quote,
    actor_name: args.actor_name,
    actor_function: args.actor_function,
    note: rationale,
  });
  await db()
    .update(gapCandidates)
    .set({ committed_gap_id: gapId })
    .where(eq(gapCandidates.id, row.id));
  await recordEdit({
    stage: "S2",
    entity_type: "gap_candidate",
    entity_id: row.id,
    field: "verdict",
    action: "accept",
    before: "reject",
    after: gapId,
    rationale,
    actor: { name: args.actor_name, function: args.actor_function },
    signal_kind: "user_accepted_proposal",
  });
  return gapId;
}

export async function promoteTacticCandidate(args: {
  candidate_id: string;
  name?: string;
  type?: string;
  status?: string;
  evidence_question?: string;
  gap_id?: string;
  rationale: string;
  actor_name: string;
  actor_function: ActorFunction;
}): Promise<string> {
  const rationale = requireRationale(args.rationale);
  await ensurePlatformSchema([TACTIC_CANDIDATES_DDL, TACTIC_CANDIDATES_DUPLICATE_DDL]);
  const [row] = await db()
    .select()
    .from(tacticCandidates)
    .where(and(eq(tacticCandidates.id, args.candidate_id), eq(tacticCandidates.verdict, "reject")));
  if (!row) throw new Error("Rejected tactic candidate not found.");
  const state = await loadState();
  const source = state.sources.find((s) => s.id === row.source_id);
  const type = (args.type || row.type) as TacticType;
  const tacticId = await recordMissedTactic({
    name: args.name?.trim() || row.name,
    type: TACTIC_TYPES.includes(type) ? type : (row.type as TacticType),
    evidence_question: args.evidence_question?.trim() || row.evidence_question,
    description: `Promoted by hand from a rejected S3 candidate${source ? ` in ${source.title}` : ""}.`,
    status: args.status || row.status,
    data_source: source?.title ?? row.source_id,
    source_quote: row.source_quote,
    gap_id: args.gap_id || undefined,
    actor_name: args.actor_name,
    actor_function: args.actor_function,
  });
  await recordEdit({
    stage: "S3",
    entity_type: "tactic_candidate",
    entity_id: row.id,
    field: "verdict",
    action: "accept",
    before: "reject",
    after: tacticId,
    rationale,
    actor: { name: args.actor_name, function: args.actor_function },
    signal_kind: "user_accepted_proposal",
  });
  return tacticId;
}
