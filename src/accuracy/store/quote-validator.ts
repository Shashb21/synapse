import { z } from "zod";

export const provenanceSpanSchema = z.object({
  source_file_id: z.string(),
  block_id: z.string(),
  quote: z.string(),
  char_start: z.number().int().nonnegative().optional(),
  char_end: z.number().int().nonnegative().optional(),
});

export type ProvenanceSpan = z.infer<typeof provenanceSpanSchema>;

export type ParseBlock = {
  id: string;
  workspace_id: string;
  source_file_id: string;
  index: number;
  kind: "prose" | "table_row" | "list_item" | "heading" | "caption" | "other";
  heading: string | null;
  text: string;
};

/** Returns null when quote is not a substring of block text (accuracy gate). */
export function validateQuoteAgainstBlock(args: {
  block: Pick<ParseBlock, "text">;
  quote: string;
}): { ok: true; normalized: string } | { ok: false; reason: string } {
  const quote = args.quote.trim();
  if (!quote) return { ok: false, reason: "empty_quote" };
  if (args.block.text.includes(quote)) {
    return { ok: true, normalized: quote };
  }
  const collapsed = quote.replace(/\s+/g, " ");
  const blockCollapsed = args.block.text.replace(/\s+/g, " ");
  if (blockCollapsed.includes(collapsed)) {
    return { ok: true, normalized: quote };
  }
  return { ok: false, reason: "quote_not_substring" };
}

export function validateProvenance(args: {
  block: ParseBlock;
  span: ProvenanceSpan;
}): { ok: true } | { ok: false; reason: string } {
  if (args.span.block_id !== args.block.id) {
    return { ok: false, reason: "block_id_mismatch" };
  }
  if (args.span.source_file_id !== args.block.source_file_id) {
    return { ok: false, reason: "source_file_mismatch" };
  }
  const q = validateQuoteAgainstBlock({ block: args.block, quote: args.span.quote });
  return q.ok ? { ok: true } : { ok: false, reason: q.reason };
}
