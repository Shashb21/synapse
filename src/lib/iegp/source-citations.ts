/** Serializes source-backed writes with collection and reparse changes. */
import { and, eq } from "drizzle-orm";
import { resolveSourceCitation } from "@/lib/ingest/source-citation";
import { validateQuoteAgainstBlock } from "@/lib/ingest/quote-validator";
import { TrustedApplicationError } from "@/modules/kernel/stage-errors";
import { db } from "./db";
import { sourceBlocks, sources } from "./schema";

type SourceReader = Pick<ReturnType<typeof db>, "select">;

/** Use the same source owner row for writes and source edits. */
export async function lockSourceCitationOwner(sourceId: string, reader: SourceReader = db()) {
  const [source] = await reader.select({ id: sources.id }).from(sources).where(eq(sources.id, sourceId)).for("update");
  return source;
}

/** Recheck a candidate's exact block after locking the source owner row. */
export async function requireRetainedSourceQuote(
  sourceId: string,
  blockId: string | null | undefined,
  quote: string,
  reader: SourceReader = db(),
) {
  const block = blockId
    ? (await reader.select().from(sourceBlocks).where(and(eq(sourceBlocks.source_id, sourceId), eq(sourceBlocks.id, blockId))))[0]
    : undefined;
  if (!block || !validateQuoteAgainstBlock({ block, quote }).ok) {
    throw new TrustedApplicationError("The full quote no longer matches its retained source block. Rerun extraction.", "conflict", 409);
  }
  return { heading: block.heading, location: block.location };
}

/** Recover exact provenance for a legacy candidate with a uniquely retained quotation. */
export async function resolveRetainedSourceQuote(
  sourceId: string,
  blockId: string | null | undefined,
  quote: string,
  reader: SourceReader = db(),
) {
  if (blockId) {
    return { block_id: blockId, source_context: await requireRetainedSourceQuote(sourceId, blockId, quote, reader) };
  }
  const blocks = await reader.select().from(sourceBlocks).where(eq(sourceBlocks.source_id, sourceId));
  const match = resolveSourceCitation({ source_id: sourceId, proposed_block_id: null, quote, displayed: blocks, retained: blocks });
  if (!match.block_id || !match.source_context) {
    throw new TrustedApplicationError(match.citation_error ?? "Quote could not be verified in a source block.", "conflict", 409);
  }
  return { block_id: match.block_id, source_context: match.source_context };
}
