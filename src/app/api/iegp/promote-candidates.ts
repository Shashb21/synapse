/** Promotes rejected extraction candidates after verifying their citations. */
import { ensureCurrentSchemaTables, withWorkspaceTransaction } from "@/lib/iegp/db";
import { lockSourceCitationOwner, resolveRetainedSourceQuote } from "@/lib/iegp/source-citations";
import { attachTacticSource } from "@/modules/stages/s3-tactic-extract/suggestions";
import { TrustedApplicationError } from "@/modules/kernel/stage-errors";
import { and, desc, eq } from "drizzle-orm";
import { db, ensurePlatformSchema } from "@/modules/kernel/db";
import { recordEdit, requireRationale } from "@/modules/kernel/edit-records";
import { gapExtractModule } from "@/modules/stages/s2-gap-extract/module";
import { gapCandidates } from "@/modules/stages/s2-gap-extract/schema";
import { tacticExtractModule } from "@/modules/stages/s3-tactic-extract/module";
import { tacticPromotionsForCandidates } from "@/modules/stages/s3-tactic-extract/promotions";
import { tacticCandidates } from "@/modules/stages/s3-tactic-extract/schema";
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

export async function listRejectedGapCandidates(limit = 200): Promise<RejectedGapCandidate[]> {
  await ensurePlatformSchema(gapExtractModule.migrations);
  return db()
    .select()
    .from(gapCandidates)
    .where(eq(gapCandidates.verdict, "reject"))
    .orderBy(desc(gapCandidates.created_at))
    .limit(limit);
}

export async function listRejectedTacticCandidates(limit = 200): Promise<RejectedTacticCandidate[]> {
  await ensurePlatformSchema(tacticExtractModule.migrations);
  const rows = await db()
    .select()
    .from(tacticCandidates)
    .where(eq(tacticCandidates.verdict, "reject"))
    .orderBy(desc(tacticCandidates.created_at))
    .limit(limit);
  const promotions = await tacticPromotionsForCandidates(rows.map(({ id }) => id));
  return rows.map((row) => ({ ...row, promoted_tactic_id: promotions.get(row.id) ?? null }));
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
  await ensurePlatformSchema(gapExtractModule.migrations);
  await ensureCurrentSchemaTables();
  return withWorkspaceTransaction(async () => {
    const [row] = await db()
      .select()
      .from(gapCandidates)
      .where(and(eq(gapCandidates.id, args.candidate_id), eq(gapCandidates.verdict, "reject")))
      .for("update");
    if (!row) throw new TrustedApplicationError("Rejected gap candidate not found.", "not_found", 404);
    if (row.committed_gap_id) throw new Error(`Already promoted as ${row.committed_gap_id}.`);
    if (row.citation_error) throw new TrustedApplicationError(row.citation_error, "conflict", 409);
    await lockSourceCitationOwner(row.source_id);
    const citation = await resolveRetainedSourceQuote(row.source_id, row.block_id, row.source_quote);
    const domain = (args.domain || row.domain) as EvidenceDomain;
    const gapId = await createGap({
      name: args.name?.trim() || row.name,
      statement: args.statement?.trim() || row.statement,
      domain: EVIDENCE_DOMAINS.includes(domain) ? domain : undefined,
      source_id: row.source_id,
      source_quote: row.source_quote,
      need_provenance: { ...citation, run_id: row.run_id, candidate_row_id: row.id },
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
  await ensurePlatformSchema(tacticExtractModule.migrations);
  await ensureCurrentSchemaTables();
  return withWorkspaceTransaction(async () => {
    const [row] = await db()
      .select()
      .from(tacticCandidates)
      .where(and(eq(tacticCandidates.id, args.candidate_id), eq(tacticCandidates.verdict, "reject")))
      .for("update");
    if (!row) throw new TrustedApplicationError("Rejected tactic candidate not found.", "not_found", 404);
    // The edit and the tactic are committed together under the candidate lock.
    const previous = (await tacticPromotionsForCandidates([row.id])).get(row.id);
    if (previous) return previous;
    if (row.citation_error) throw new TrustedApplicationError(row.citation_error, "conflict", 409);
    await lockSourceCitationOwner(row.source_id);
    const citation = await resolveRetainedSourceQuote(row.source_id, row.block_id, row.source_quote);
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
      ...citation,
      rationale,
      gap_id: args.gap_id || undefined,
      actor_name: args.actor_name,
      actor_function: args.actor_function,
    });
    await attachTacticSource({ tactic_id: tacticId, source_id: row.source_id, source_quote: row.source_quote, ...citation });
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
