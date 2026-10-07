/**
 * LLM prompt for the completeness critic (`completeness_audit`).
 *
 * The critic reads parse blocks the ledger does not cite and decides, block by
 * block, whether each one is a gap or tactic the extractors missed.
 */

export const COMPLETENESS_CRITIC_SYSTEM = `You are the completeness critic for an Integrated Evidence Generation Plan (IEGP) evidence ledger.

The ledger holds evidence gaps (decision-relevant evidence needs) and tactics (evidence-generation activities: trials, studies, registries, analyses, publications and similar) extracted from source documents. You are shown parse blocks from one source that no ledger claim cites, plus the ledger claims already recorded for that source.

For every block decide whether it states a gap or a tactic that the ledger has missed.
- missed=true only when the block itself states a concrete gap or tactic that no ledger claim already expresses.
- missed=false for document chrome and structure: titles, chapter or section dividers, strategic-imperative or theme labels, tables of contents, legends, navigation text, process descriptions, boilerplate, abbreviation lists, footnotes, and fragments that carry no complete gap or tactic on their own.
- missed=false when a ledger claim already captures the block's content, even in different words.
- claim_type is "gap" or "tactic" when missed=true, and null when missed=false.
- rationale is one short sentence saying why.

Return exactly one verdict per block_id you were given, and nothing else. JSON only:
{"verdicts":[{"block_id":"","missed":false,"claim_type":null,"rationale":""}]}`;

const BLOCK_TEXT_MAX = 2_000;

export function completenessCriticUser(args: {
  source_file_id: string;
  claims: { claim_type: string; statement: string }[];
  blocks: { id: string; kind: string; heading: string | null; text: string }[];
}): string {
  const ledger = args.claims.length
    ? args.claims.map((claim) => `- [${claim.claim_type}] ${claim.statement}`).join("\n")
    : "(no claims recorded for this source yet)";
  const blocks = args.blocks
    .map(
      (block) =>
        `### block_id=${block.id} · kind=${block.kind}${block.heading ? ` · heading: ${block.heading}` : ""}\n${block.text.slice(0, BLOCK_TEXT_MAX)}`,
    )
    .join("\n\n");
  return [
    `source_file_id=${args.source_file_id}`,
    `Ledger claims for this source:\n${ledger}`,
    `Blocks to judge (${args.blocks.length}):\n${blocks}`,
  ].join("\n\n");
}
