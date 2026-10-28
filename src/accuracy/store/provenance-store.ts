/** Validates durable claim evidence and serializes it with parse mutations. */
import { and, eq, inArray, sql } from "drizzle-orm";
import { accuracyDb, ensureAccuracySchema } from "./db";
import * as t from "./schema";
import { newId, nowIso } from "@/modules/kernel/ids";
import { provenanceSpanSchema, validateProvenance, type ProvenanceSpan } from "./quote-validator";
import type { QuoteDependent } from "@/lib/ingest/manual-blocks";

export type AccuracyTransaction = Parameters<Parameters<ReturnType<typeof accuracyDb>["transaction"]>[0]>[0];
export type AccuracyExecutor = ReturnType<typeof accuracyDb> | AccuracyTransaction;
export type EvidenceDependent = QuoteDependent & { block_id: string; provenance_id: string; unresolved?: boolean };

/** An evidence span cannot be tied to current source text in this workspace. */
export class ProvenanceValidationError extends Error {
  constructor(readonly reason: string) {
    super(`Invalid provenance: ${reason}`);
    this.name = "ProvenanceValidationError";
  }
}

/**
 * Runs evidence writes and source mutations under the same workspace lock.
 * The transaction commits the claim, evidence, and parse changes together;
 * PostgreSQL releases its advisory lock on either commit or rollback.
 */
export async function withProvenanceTransaction<T>(workspace_id: string, work: (db: AccuracyTransaction) => Promise<T>): Promise<T> {
  await ensureAccuracySchema();
  return accuracyDb().transaction(async (db) => {
    await db.execute(sql`select pg_advisory_xact_lock(hashtext('accuracy-provenance'), hashtext(${workspace_id}))`);
    return work(db);
  });
}

/** Validate every span against database text before any claim/evidence insertion. */
export async function validateClaimProvenance(db: AccuracyExecutor, args: {
  workspace_id: string;
  source_file_id?: string | null;
  provenance: unknown;
}): Promise<ProvenanceSpan[]> {
  const parsed = provenanceSpanSchema.array().safeParse(args.provenance === undefined ? [] : args.provenance);
  if (!parsed.success) throw new ProvenanceValidationError("malformed_spans");
  const sources = await db.select().from(t.accuracySourceFiles).where(eq(t.accuracySourceFiles.workspace_id, args.workspace_id));
  const sourceIds = new Set(sources.map((row) => row.id));
  if (args.source_file_id && !sourceIds.has(args.source_file_id)) throw new ProvenanceValidationError("source_not_in_workspace");
  if (!parsed.data.length) return [];
  const blocks = await db.select().from(t.accuracyParseBlocks).where(and(
    eq(t.accuracyParseBlocks.workspace_id, args.workspace_id),
    inArray(t.accuracyParseBlocks.id, parsed.data.map((span) => span.block_id)),
  ));
  const byId = new Map(blocks.map((row) => [row.id, row]));
  for (const span of parsed.data) {
    if (!sourceIds.has(span.source_file_id)) throw new ProvenanceValidationError("source_not_in_workspace");
    if (args.source_file_id && span.source_file_id !== args.source_file_id) throw new ProvenanceValidationError("claim_source_mismatch");
    const block = byId.get(span.block_id);
    if (!block) throw new ProvenanceValidationError("block_not_in_workspace");
    const result = validateProvenance({ block, span });
    if (!result.ok) throw new ProvenanceValidationError(result.reason);
  }
  return parsed.data;
}

type EvidenceClaim = typeof t.accuracyClaims.$inferSelect;

/**
 * Validate an intentional evidence replacement against current workspace sources
 * and blocks. Human annotations remain metadata-only when unverified.
 * The caller holds the workspace evidence lock and compares its old snapshot.
 */
export async function validateClaimProvenanceChange(db: AccuracyExecutor, claim: EvidenceClaim, metadata: Record<string, unknown>, allowHumanAnnotations = false): Promise<ProvenanceSpan[]> {
  const rawSpans = metadata.provenance === undefined ? [] : metadata.provenance;
  if (!Array.isArray(rawSpans)) throw new ProvenanceValidationError("malformed_spans");
  const verified: ProvenanceSpan[] = [];
  for (const raw of rawSpans) {
    try {
      const [span] = await validateClaimProvenance(db, { workspace_id: claim.workspace_id, provenance: [raw] });
      verified.push(span!);
    } catch (error) {
      const human = raw && typeof raw === "object" && (raw as Record<string, unknown>).edited_by_human === true;
      if (!(error instanceof ProvenanceValidationError) || !allowHumanAnnotations || !human) throw error;
    }
  }
  return verified;
}

/** Read both historical metadata and relational evidence; backfill only verified spans. */
export async function reconcileDependents(db: AccuracyExecutor, workspace_id: string, block_ids: string[]): Promise<EvidenceDependent[]> {
  if (!block_ids.length) return [];
  const blocks = await db.select().from(t.accuracyParseBlocks).where(eq(t.accuracyParseBlocks.workspace_id, workspace_id));
  const byId = new Map(blocks.map((block) => [block.id, block]));
  const requested = new Set(block_ids);
  const sources = new Set((await db.select().from(t.accuracySourceFiles).where(eq(t.accuracySourceFiles.workspace_id, workspace_id))).map((source) => source.id));
  const rows = await db.select().from(t.accuracyProvenance).where(eq(t.accuracyProvenance.workspace_id, workspace_id));
  const key = (claim_id: string, span: ProvenanceSpan) => JSON.stringify([claim_id, span.source_file_id, span.block_id, span.quote]);
  const existing = new Set(rows.map((row) => key(row.claim_id, row)));
  const dependents: EvidenceDependent[] = rows.filter((row) => requested.has(row.block_id)).map((row) => {
    const block = byId.get(row.block_id);
    const unresolved = !block || !sources.has(row.source_file_id) || !validateProvenance({ block, span: row }).ok;
    return { id: row.claim_id, quote: row.quote, block_id: row.block_id, provenance_id: row.id, unresolved };
  });
  const claims = await db.select().from(t.accuracyClaims).where(eq(t.accuracyClaims.workspace_id, workspace_id));
  for (const claim of claims) {
    const metadata = (claim.metadata ?? {}) as Record<string, unknown>;
    if (metadata.provenance === undefined) continue;
    const rawSpans = Array.isArray(metadata.provenance) ? metadata.provenance : [metadata.provenance];
    for (const raw of rawSpans) {
      const parsed = provenanceSpanSchema.safeParse(raw);
      const span = parsed.success ? parsed.data : null;
      const block = span ? byId.get(span.block_id) : undefined;
      if (span && block && sources.has(span.source_file_id) && validateProvenance({ block, span }).ok) {
        // Unrelated blocks are reconciled when their own guard/read runs.
        if (!requested.has(block.id)) continue;
        const identity = key(claim.id, span);
        if (!existing.has(identity)) {
          const row = { id: newId("prov"), workspace_id, claim_id: claim.id, source_file_id: span.source_file_id, block_id: span.block_id, quote: span.quote };
          await db.insert(t.accuracyProvenance).values(row);
          existing.add(identity);
          dependents.push({ id: claim.id, quote: row.quote, block_id: row.block_id, provenance_id: row.id });
        }
        continue;
      }
      // Invalid historic evidence is a protection signal, never verified evidence.
      // If its block cannot be located, protect the identifiable source, or the
      // workspace when no trustworthy location survives. A human must repair it.
      const hint = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
      const hintedBlock = typeof hint.block_id === "string" ? byId.get(hint.block_id) : undefined;
      const hintedSources = new Set([claim.source_file_id, hint.source_file_id].filter((id): id is string => typeof id === "string" && sources.has(id)));
      const protectedBlocks = hintedBlock ? [hintedBlock] : blocks.filter((candidate) => !hintedSources.size || hintedSources.has(candidate.source_file_id));
      for (const candidate of protectedBlocks) {
        if (!requested.has(candidate.id)) continue;
        dependents.push({ id: claim.id, quote: typeof hint.quote === "string" ? hint.quote : "", block_id: candidate.id, provenance_id: "", unresolved: true });
      }
    }
  }
  return dependents;
}

/** Keep metadata consumers aligned when a split/merge moves relational evidence. */
export async function repointMetadataProvenance(db: AccuracyExecutor, workspace_id: string, from: string, to: string, quote?: string): Promise<void> {
  const claims = await db.select().from(t.accuracyClaims).where(eq(t.accuracyClaims.workspace_id, workspace_id));
  for (const claim of claims) {
    const metadata = (claim.metadata ?? {}) as Record<string, unknown>;
    if (!Array.isArray(metadata.provenance)) continue;
    let changed = false;
    const provenance = metadata.provenance.map((raw) => {
      const parsed = provenanceSpanSchema.safeParse(raw);
      if (!parsed.success || parsed.data.block_id !== from || (quote !== undefined && parsed.data.quote !== quote)) return raw;
      changed = true;
      // Character offsets refer to the original block, so they cannot follow it.
      const span = { ...parsed.data, block_id: to };
      delete span.char_start;
      delete span.char_end;
      return span;
    });
    if (changed) await db.update(t.accuracyClaims).set({
      // Patch only evidence: a concurrent validation annotation must survive.
      metadata: sql`jsonb_set(coalesce(${t.accuracyClaims.metadata}, '{}'::jsonb), '{provenance}', ${JSON.stringify(provenance)}::jsonb)`,
      updated_at: nowIso(),
    }).where(eq(t.accuracyClaims.id, claim.id));
  }
}
