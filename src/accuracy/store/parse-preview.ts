import type { ParseBlock } from "./quote-validator";
import { validateQuoteAgainstBlock } from "./quote-validator";

/**
 * Verbatim parse-block preview for Sources.
 * `text` is the parse-store payload with no rewrite, collapse, or ellipsis —
 * quotes copied from this surface must pass substring validation.
 */
export type ParseBlockPreview = {
  id: string;
  source_file_id: string;
  index: number;
  kind: ParseBlock["kind"] | string;
  heading: string | null;
  text: string;
};

type PreviewBlockInput = {
  id: string;
  source_file_id: string;
  index: number;
  kind: ParseBlock["kind"] | string;
  heading: string | null;
  text: string;
};

export function toParseBlockPreview(block: PreviewBlockInput): ParseBlockPreview {
  return {
    id: block.id,
    source_file_id: block.source_file_id,
    index: block.index,
    kind: block.kind,
    heading: block.heading,
    text: block.text,
  };
}

export function toParseBlockPreviews(blocks: PreviewBlockInput[]): ParseBlockPreview[] {
  return [...blocks].sort((a, b) => a.index - b.index).map(toParseBlockPreview);
}

/** Copyable quote from the preview surface (full block text, not a paraphrase). */
export function quoteFromPreview(preview: Pick<ParseBlockPreview, "text">): string {
  return preview.text;
}

/** Accuracy gate: preview text / a copied quote must be a substring of the stored block. */
export function previewQuoteIsValidatable(args: {
  stored: Pick<ParseBlock, "text">;
  preview: Pick<ParseBlockPreview, "text">;
  quote?: string;
}): { ok: true; normalized: string } | { ok: false; reason: string } {
  const quote = args.quote ?? quoteFromPreview(args.preview);
  return validateQuoteAgainstBlock({ block: args.stored, quote });
}
