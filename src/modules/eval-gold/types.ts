export type CuratedGoldMeta = {
  pack: string;
  source_id: string;
  /** Lowercase substrings expected in accepted gap/tactic statements for this case. */
  must_match?: string[];
  parse_min_blocks?: number;
  parse_min_need_cues?: number;
};

export type CuratedEvalCase<I> = {
  name: string;
  input: I;
  gold?: CuratedGoldMeta;
};

export function scoreMustMatch(
  statements: string[],
  must_match: string[] | undefined,
): { value: number; detail: string } {
  if (!must_match?.length) return { value: 1, detail: "no must_match" };
  const haystack = statements.join(" ").toLowerCase();
  const hits = must_match.filter((needle) => haystack.includes(needle.toLowerCase()));
  const value = hits.length / must_match.length;
  return {
    value: Number(value.toFixed(3)),
    detail: `${hits.length}/${must_match.length} curated needles (${must_match.join(", ")})`,
  };
}
