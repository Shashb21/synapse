/** Resolves extracted quotations to retained source blocks and carries their review context. */
import { z } from "zod";
import { validateQuoteAgainstBlock } from "./quote-validator";

export const sourceContextSchema = z.object({ heading: z.string(), location: z.string() });
export type SourceContext = z.infer<typeof sourceContextSchema>;
export type CitationBlock = SourceContext & { id: string; source_id: string; text: string };
type CandidateLocation = { block_id: string | null; source_context: SourceContext | null };

/** Require the full quote in the named source block, or resolve an unambiguous quote. */
export function resolveSourceCitation(args: {
  source_id: string;
  quote: string;
  proposed_block_id: string | null;
  displayed: readonly CitationBlock[];
  retained: readonly CitationBlock[];
}): CandidateLocation & { citation_error: string | null } {
  const reject = (citation_error: string) => ({ block_id: null, source_context: null, citation_error });
  if (!args.quote.trim()) return reject("An empty quote cannot cite a source block.");
  const matches = (block: CitationBlock) =>
    block.source_id === args.source_id && validateQuoteAgainstBlock({ block, quote: args.quote }).ok;
  const displayed = args.displayed.filter(matches);
  const retained = args.retained.filter(matches);
  if (!args.proposed_block_id && new Set([...displayed, ...retained].map((block) => block.id)).size > 1) {
    return reject("The quote occurs in more than one source block. Identify the quoted block explicitly.");
  }
  const blockId = args.proposed_block_id ?? displayed[0]?.id;
  const block = retained.find((row) => row.id === blockId);
  if (!block || !displayed.some((row) => row.id === blockId)) {
    return reject("The full quote was not found in the identified retained source block.");
  }
  return { block_id: block.id, source_context: { heading: block.heading, location: block.location }, citation_error: null };
}
