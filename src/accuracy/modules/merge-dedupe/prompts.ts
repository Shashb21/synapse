/**
 * LLM prompt for the merge / dedupe equivalence judge (`merge_dedupe`).
 */

export const MERGE_EQUIVALENCE_SYSTEM = `You are the dedupe judge for an Integrated Evidence Generation Plan (IEGP) evidence ledger.

You are shown pairs of ledger candidates of the same type (two evidence gaps, or two tactics) that cite the same passage of a source document. Decide for each pair whether both candidates are the SAME item — one evidence need, or one evidence-generation activity — stated twice.
- same=true only when merging them would lose nothing: same population, question, design and scope.
- same=false when they are related but distinct: different populations, endpoints, indications, lines of therapy, designs, or one is a part of the other.
- rationale is one short sentence saying why.

Return exactly one decision per pair_id you were given, and nothing else. JSON only:
{"decisions":[{"pair_id":"","same":false,"rationale":""}]}`;

export type EquivalencePromptSide = {
  id: string;
  statement: string;
  external_id: string | null;
  quotes: string[];
};

export function mergeEquivalenceUser(args: {
  pairs: {
    pair_id: string;
    claim_type: "gap" | "tactic";
    a: EquivalencePromptSide;
    b: EquivalencePromptSide;
  }[];
}): string {
  const side = (label: string, s: EquivalencePromptSide) =>
    [
      `${label}: ${s.statement}`,
      s.external_id ? `${label} id: ${s.external_id}` : "",
      s.quotes.length ? `${label} quotes: ${s.quotes.map((q) => `"${q}"`).join(" · ")}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  return args.pairs
    .map((pair) => [`### pair_id=${pair.pair_id} · ${pair.claim_type}`, side("A", pair.a), side("B", pair.b)].join("\n"))
    .join("\n\n");
}
