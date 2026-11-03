/**
 * LLM prompts for `need_extract` (proposer → critic → reviser → judge).
 *
 * Evidence needs / gaps are decision-relevant holes stated or implied in source material.
 * Prefer stable external IDs when the deck uses them (e.g. NSCLC_CE_01). Do not invent tactics.
 */

export const NEED_PROPOSER_SYSTEM = `You extract evidence gaps (evidence needs) from Integrated Evidence Generation Plan source material.

A gap is a decision-relevant evidence hole: what is unknown, insufficient, or not yet generated. Do not invent gaps. Do not output tactics.

Rules:
- statement is one clear sentence for the evidence need.
- external_id is optional: use deck IDs when present (e.g. NSCLC_HI_04, NSCLC_CE_01). Null when none.
- provenance is one or more verbatim quote spans: source_file_id, block_id, quote (substring of that block's text).
- Return JSON only:
{"gaps":[{"statement":"","external_id":null,"provenance":[{"source_file_id":"","block_id":"","quote":""}]}]}`;

export function needProposerUser(args: {
  workspace_id: string;
  source_file_id: string;
  block_ids: string[];
  blocks: { id: string; heading: string | null; text: string }[];
  critiques: string[];
}): string {
  const blockSection = args.blocks
    .map((b) => `### block_id=${b.id}${b.heading ? ` · ${b.heading}` : ""}\n${b.text}`)
    .join("\n\n")
    .slice(0, 40_000);
  return [
    `workspace_id=${args.workspace_id}`,
    `source_file_id=${args.source_file_id}`,
    args.block_ids.length ? `target_block_ids: ${args.block_ids.join(", ")}` : "",
    args.critiques.length
      ? `Critic issues to fix:\n${args.critiques.map((c) => `- ${c}`).join("\n")}`
      : "",
    "Parse blocks:",
    blockSection || "(no block text loaded — use block_ids only as hints)",
  ]
    .filter(Boolean)
    .join("\n");
}

export const NEED_CRITIC_SYSTEM = `You are the critic in a proposer → critic → judge loop for evidence-need extraction.

For each candidate gap, verify:
- statement is a concrete, decision-relevant evidence hole (not a tactic or dissemination preference).
- provenance quotes are verbatim and tied to the cited block_id and source_file_id.
- external_id, when set, matches a deck scheme such as NSCLC_*_* .

Return JSON only: {"critiques":[{"subject":"","score":0,"issues":["no_quote|weak_quote|vague|wrong_id|duplicate|is_tactic"]}]}`;

export function needCriticUser(args: { draft_json: string }): string {
  return `Review this draft needs JSON:\n${args.draft_json}`;
}
