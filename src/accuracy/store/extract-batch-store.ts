import { TrustedApplicationError } from "@/modules/kernel/stage-errors";
/** Durable extraction pages: bind progress to source content and save each kind exactly once. */
import { createHash } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { integer, pgTable, text } from "drizzle-orm/pg-core";
import { z } from "zod";
import { accuracyDb, ensureAccuracySchema } from "./db";
import { accuracyClaims, accuracyParseBlocks, accuracyProvenance, accuracySourceFiles } from "./schema";
import { readParseBlocks } from "./parse-store";
import { validateProvenance, type ParseBlock, type ProvenanceSpan } from "./quote-validator";
import type { AccuracyClaimMetadata, AccuracyClaimType } from "./claim-store";
import { newId, nowIso } from "@/modules/kernel/ids";
import { lockAccuracySource, type SourceConnection } from "./source-lock";

/** Bound provider work to the existing 80-block request budget. */
const PAGE_SIZE = 80;
export type ExtractKind = "need" | "inventory";
export const extractContinuationSchema = z.strictObject({
  workspace_id: z.string().min(1),
  source_file_id: z.string().min(1),
  snapshot: z.string().regex(/^[a-f0-9]{64}$/),
  offset: z.number().int().nonnegative(),
  kinds: z.array(z.enum(["need", "inventory"])).min(1).max(2),
});
export type ExtractContinuation = z.infer<typeof extractContinuationSchema>;

const batches = pgTable("accuracy_extract_batches", {
  id: text("id").primaryKey(),
  workspace_id: text("workspace_id").notNull(),
  source_file_id: text("source_file_id").notNull(),
  snapshot: text("snapshot").notNull(),
  page_offset: integer("page_offset").notNull(),
  kind: text("kind").notNull(),
  claim_count: integer("claim_count").notNull(),
  run_id: text("run_id").notNull(),
  completed_at: text("completed_at").notNull(),
});
const DDL = `CREATE TABLE IF NOT EXISTS accuracy_extract_batches (
  id text PRIMARY KEY, workspace_id text NOT NULL, source_file_id text NOT NULL,
  snapshot text NOT NULL, page_offset integer NOT NULL, kind text NOT NULL,
  claim_count integer NOT NULL, run_id text NOT NULL, completed_at text NOT NULL,
  UNIQUE (workspace_id, source_file_id, snapshot, page_offset, kind)
)`;
const globalBatch = globalThis as unknown as { accuracyExtractSchema?: Promise<void> };

/** Initialize durable extraction checkpoints before transactional store work. */
export async function ensureBatchSchema() {
  await ensureAccuracySchema();
  if (!globalBatch.accuracyExtractSchema) {
    globalBatch.accuracyExtractSchema = accuracyDb().execute(sql.raw(DDL)).then(() => {}).catch((error) => {
      globalBatch.accuracyExtractSchema = undefined;
      throw error;
    });
  }
  await globalBatch.accuracyExtractSchema;
}

/** Remove checkpoints in the caller's workspace-deletion transaction after locking its sources. */
export async function deleteWorkspaceExtractBatches(workspaceId: string, db: SourceConnection): Promise<void> {
  await db.delete(batches).where(eq(batches.workspace_id, workspaceId));
}

/** A continuation is unusable after source changes or when earlier work was never saved. */
export class ExtractContinuationError extends Error {}

export type ExtractPage = {
  workspace_id: string;
  source_file_id: string;
  reference_pack_id: string | null;
  snapshot: string;
  offset: number;
  kinds: ExtractKind[];
  blocks: ParseBlock[];
  total: number;
};
export type ExtractBatchClaim = {
  claim_type: AccuracyClaimType;
  statement: string;
  status: string;
  metadata: AccuracyClaimMetadata;
  provenance: ProvenanceSpan[];
};

function digest(blocks: ParseBlock[], referencePackId: string | null): string {
  return createHash("sha256").update(JSON.stringify({ referencePackId, blocks: blocks.map((block) => [
    block.workspace_id, block.source_file_id, block.id, block.index, block.kind, block.heading, block.text,
  ]) })).digest("hex");
}

function continuation(page: ExtractPage, offset: number): ExtractContinuation {
  return { workspace_id: page.workspace_id, source_file_id: page.source_file_id, snapshot: page.snapshot, offset, kinds: page.kinds };
}

/** Prepare one bounded page; an offset never stands in for durable earlier completions. */
export async function prepareExtractPage(args: {
  workspace_id: string;
  source_file_id: string;
  reference_pack_id: string | null;
  kinds: ExtractKind[];
  continuation?: ExtractContinuation;
}): Promise<ExtractPage> {
  const blocks = (await readParseBlocks(args.workspace_id, args.source_file_id)) as ParseBlock[];
  blocks
    .sort((a, b) => a.index - b.index || a.id.localeCompare(b.id));
  const snapshot = digest(blocks, args.reference_pack_id);
  const kinds = [...new Set(args.kinds)].sort() as ExtractKind[];
  const previous = args.continuation;
  const offset = previous?.offset ?? 0;
  if (previous && (
    previous.workspace_id !== args.workspace_id || previous.source_file_id !== args.source_file_id ||
    previous.snapshot !== snapshot || [...new Set(previous.kinds)].sort().join() !== kinds.join() ||
    offset % PAGE_SIZE !== 0 || offset >= blocks.length
  )) throw new ExtractContinuationError("Source or extraction selection changed. Restart extraction from the first batch.");
  const page: ExtractPage = { ...args, snapshot, kinds, offset, blocks: blocks.slice(offset, offset + PAGE_SIZE), total: blocks.length };
  if (previous) {
    const progress = await extractPageProgress(page);
    if (progress.blocks_processed < offset) {
      throw new ExtractContinuationError("Earlier extraction batches are incomplete. Restart extraction to resume saved work.");
    }
  }
  return page;
}

async function savedBatches(page: ExtractPage) {
  await ensureBatchSchema();
  return accuracyDb().select().from(batches).where(and(
    eq(batches.workspace_id, page.workspace_id), eq(batches.source_file_id, page.source_file_id), eq(batches.snapshot, page.snapshot),
  ));
}

/** Return the kinds already committed for this page so retries avoid provider calls. */
export async function completedExtractKinds(page: ExtractPage): Promise<Set<string>> {
  return new Set((await savedBatches(page)).filter((row) => row.page_offset === page.offset).map((row) => row.kind));
}

/** Report only the contiguous prefix for which every requested kind is durably saved. */
export async function extractPageProgress(page: ExtractPage) {
  const rows = await savedBatches(page);
  let processed = 0;
  while (processed < page.total && page.kinds.every((kind) => rows.some((row) => row.page_offset === processed && row.kind === kind))) {
    processed = Math.min(processed + PAGE_SIZE, page.total);
  }
  const complete = processed === page.total;
  return {
    block_count: page.total,
    blocks_used: page.blocks.length,
    blocks_processed: processed,
    complete,
    status: complete ? "complete" as const : "partial" as const,
    continuation: complete ? null : continuation(page, processed),
  };
}

/** A failure retries this same page, including when only postprocessing remains. */
export function retryExtractContinuation(page: ExtractPage): ExtractContinuation {
  return continuation(page, page.offset);
}

/**
 * Commit generated claims and their completion together. The unique checkpoint
 * arbitrates concurrent requests; a losing request never updates existing claims.
 * Model generation happens before this short transaction and IDs are assigned here.
 */
export async function saveExtractBatch(args: {
  page: ExtractPage;
  kind: ExtractKind;
  claims: ExtractBatchClaim[];
  run_id: string;
}): Promise<number> {
  await ensureBatchSchema();
  const { page } = args;
  return accuracyDb().transaction(async (tx) => {
    await lockAccuracySource(tx, page.workspace_id, page.source_file_id);
    const now = nowIso();
    const id = createHash("sha256").update(JSON.stringify([page.workspace_id, page.source_file_id, page.snapshot, page.offset, args.kind])).digest("hex");
    const won = await tx.insert(batches).values({
      id, workspace_id: page.workspace_id, source_file_id: page.source_file_id, snapshot: page.snapshot,
      page_offset: page.offset, kind: args.kind, claim_count: args.claims.length, run_id: args.run_id, completed_at: now,
    }).onConflictDoNothing().returning({ id: batches.id });
    if (!won.length) return 0;
    const current = await tx.select().from(accuracyParseBlocks).where(and(
      eq(accuracyParseBlocks.workspace_id, page.workspace_id), eq(accuracyParseBlocks.source_file_id, page.source_file_id),
    )).orderBy(asc(accuracyParseBlocks.index), asc(accuracyParseBlocks.id));
    const [source] = await tx.select().from(accuracySourceFiles).where(and(
      eq(accuracySourceFiles.workspace_id, page.workspace_id), eq(accuracySourceFiles.id, page.source_file_id),
    ));
    if (!source || digest(current as ParseBlock[], source.reference_pack_id) !== page.snapshot) {
      throw new ExtractContinuationError("Source changed while extracting. Restart extraction from the first batch.");
    }
    const allowed = new Map(page.blocks.map((block) => [block.id, block]));
    for (const claim of args.claims) {
      if (!claim.provenance.length) throw new TrustedApplicationError("Extraction requires a source quote for every claim.");
      for (const span of claim.provenance) {
        const block = allowed.get(span.block_id);
        if (!block || block.workspace_id !== page.workspace_id || !validateProvenance({ block, span }).ok) {
          throw new TrustedApplicationError("Extraction returned an invalid quote or a quote outside this source batch. Retry extraction.");
        }
      }
      const claimId = newId(claim.claim_type === "gap" ? "gap" : "tac");
      await tx.insert(accuracyClaims).values({
        id: claimId, workspace_id: page.workspace_id, source_file_id: page.source_file_id,
        claim_type: claim.claim_type, statement: claim.statement, status: claim.status, validated: false,
        metadata: { ...claim.metadata, provenance: claim.provenance }, created_at: now, updated_at: now,
      });
      await tx.insert(accuracyProvenance).values(claim.provenance.map((span) => ({
        id: newId("prov"), workspace_id: page.workspace_id, claim_id: claimId,
        source_file_id: page.source_file_id, block_id: span.block_id, quote: span.quote,
      })));
    }
    return args.claims.length;
  });
}
