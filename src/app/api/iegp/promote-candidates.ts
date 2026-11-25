/** Human promotion of rejected extraction candidates and their source provenance. */
import { TrustedApplicationError } from "@/modules/kernel/stage-errors";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db, ensurePlatformSchema } from "@/modules/kernel/db";
import { withWorkspaceTransaction } from "@/lib/iegp/db";
import { lockRelationships } from "@/lib/iegp/relationship-change";
import { sources, sourceBlocks } from "@/lib/iegp/schema";
import { containsQuote } from "@/lib/ingest/manual-blocks";
import { recordEdit, requireRationale } from "@/modules/kernel/edit-records";
import { editRecords } from "@/modules/kernel/schema";
import { GAP_CANDIDATES_DDL, GAP_BLOCK_DDL, gapCandidates } from "@/modules/stages/s2-gap-extract/schema";
import {
  TACTIC_CANDIDATES_DDL, TACTIC_BLOCK_DDL,
  TACTIC_CANDIDATES_DUPLICATE_DDL,
  tacticCandidates,
} from "@/modules/stages/s3-tactic-extract/schema";
import { appendAudit, createGap, loadState, recordMissedTactic } from "@/lib/iegp/store";
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

type CandidateCitation = { source_id: string; source_quote: string; block_id: string | null };

/** Keep the verified occurrence, or use a replacement only when the quote identifies one block. */
function currentCandidateBlockId(candidate: CandidateCitation, blocks: Pick<typeof sourceBlocks.$inferSelect, "source_id" | "id" | "text">[]): string | null {
  if (!candidate.block_id || !candidate.source_quote.trim()) return null;
  const matches = blocks.filter(block => block.source_id === candidate.source_id &&
    containsQuote(block.text.toLowerCase(), candidate.source_quote.toLowerCase()));
  return matches.find(block => block.id === candidate.block_id)?.id ??
    (matches.length === 1 ? matches[0]!.id : null);
}

/** Hold the same source lock as S1 until promotion has saved its citations. */
async function lockCandidateCitation(candidate: CandidateCitation) {
  const [source] = await db().select({ id: sources.id, title: sources.title })
    .from(sources).where(eq(sources.id, candidate.source_id)).for("update");
  const blocks = source && candidate.block_id
    ? await db().select().from(sourceBlocks).where(eq(sourceBlocks.source_id, source.id))
    : [];
  return { source, blockId: currentCandidateBlockId(candidate, blocks) };
}

export async function listRejectedGapCandidates(limit = 200): Promise<RejectedGapCandidate[]> {
  await ensurePlatformSchema([GAP_CANDIDATES_DDL, GAP_BLOCK_DDL]);
  return db()
    .select()
    .from(gapCandidates)
    .where(eq(gapCandidates.verdict, "reject"))
    .orderBy(desc(gapCandidates.created_at))
    .limit(limit);
}

export async function listRejectedTacticCandidates(limit = 200): Promise<RejectedTacticCandidate[]> {
  await ensurePlatformSchema([TACTIC_CANDIDATES_DDL, TACTIC_BLOCK_DDL, TACTIC_CANDIDATES_DUPLICATE_DDL]);
  const [rows, state] = await Promise.all([
    db()
      .select()
      .from(tacticCandidates)
      .where(eq(tacticCandidates.verdict, "reject"))
      .orderBy(desc(tacticCandidates.created_at))
      .limit(limit),
    loadState(),
  ]);
  if (!rows.length) return [];
  const edits = await db().select({ candidateId: editRecords.entity_id, tacticId: editRecords.after })
    .from(editRecords).where(and(
      eq(editRecords.entity_type, "tactic_candidate"),
      eq(editRecords.action, "accept"),
      inArray(editRecords.entity_id, rows.map(row => row.id)),
    )).orderBy(desc(editRecords.at));
  const tacticsById = new Map(state.tactics.map(tactic => [tactic.id, tactic]));
  const promotions = new Map<string, string>();
  for (const { candidateId, tacticId } of edits) {
    if (tacticId && tacticsById.has(tacticId) && !promotions.has(candidateId)) {
      promotions.set(candidateId, tacticId);
    }
  }
  return rows.map((row) => {
    const recordedId = promotions.get(row.id);
    if (recordedId) return { ...row, promoted_tactic_id: recordedId };
    // Older records can lack an edit linking the promotion to its candidate.
    const promoted = state.tactics.find(
      (tactic) =>
        tactic.name.trim().toLowerCase() === row.name.trim().toLowerCase() &&
        (tactic.source_quote ?? "") === row.source_quote.trim() && (!row.block_id || tactic.block_id === row.block_id),
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
  await ensurePlatformSchema([GAP_CANDIDATES_DDL, GAP_BLOCK_DDL]);
  return withWorkspaceTransaction(async () => {
    const [row] = await db()
      .select()
      .from(gapCandidates)
      .where(and(eq(gapCandidates.id, args.candidate_id), eq(gapCandidates.verdict, "reject")))
      .for("update");
    if (!row) throw new TrustedApplicationError("Rejected gap candidate not found.", "not_found", 404);
    if (row.committed_gap_id) throw new Error(`Already promoted as ${row.committed_gap_id}.`);
    const { blockId } = await lockCandidateCitation(row);
    const domain = (args.domain || row.domain) as EvidenceDomain;
    const gapId = await createGap({
      name: args.name?.trim() || row.name,
      statement: args.statement?.trim() || row.statement,
      domain: EVIDENCE_DOMAINS.includes(domain) ? domain : undefined,
      source_id: row.source_id,
      source_quote: row.source_quote,
      need_provenance: { block_id: blockId, run_id: row.run_id, candidate_row_id: row.id },
      actor_name: args.actor_name,
      actor_function: args.actor_function,
      note: rationale,
    });
    await db()
      .update(gapCandidates)
      .set({ committed_gap_id: gapId })
      .where(eq(gapCandidates.id, row.id));
    // On the gap's own trail too, so its history says where it came from (KAN-90).
    await appendAudit(args.actor_name, args.actor_function, "gap", gapId, "promote_candidate", `${row.id}: ${rationale}`);
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
  });
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
  await ensurePlatformSchema([TACTIC_CANDIDATES_DDL, TACTIC_BLOCK_DDL, TACTIC_CANDIDATES_DUPLICATE_DDL]);
  return withWorkspaceTransaction(async () => {
    // Mapping writes take the relationship lock before source rows.
    if (args.gap_id) await lockRelationships();
    const [row] = await db()
      .select()
      .from(tacticCandidates)
      .where(and(eq(tacticCandidates.id, args.candidate_id), eq(tacticCandidates.verdict, "reject")));
    if (!row) throw new TrustedApplicationError("Rejected tactic candidate not found.", "not_found", 404);
    const { source, blockId } = await lockCandidateCitation(row);
    const type = (args.type || row.type) as TacticType;
    const tacticId = await recordMissedTactic({
      name: args.name?.trim() || row.name,
      type: TACTIC_TYPES.includes(type) ? type : (row.type as TacticType),
      evidence_question: args.evidence_question?.trim() || row.evidence_question,
      description: `Promoted by hand from a rejected S3 candidate${source ? ` in ${source.title}` : ""}.`,
      status: args.status || row.status,
      data_source: source?.title ?? row.source_id,
      source_id: source?.id,
      block_id: blockId,
      source_quote: row.source_quote,
      rationale,
      gap_id: args.gap_id || undefined,
      actor_name: args.actor_name,
      actor_function: args.actor_function,
    });
    await appendAudit(args.actor_name, args.actor_function, "tactic", tacticId, "promote_candidate", `${row.id}: ${rationale}`);
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
  });
}
