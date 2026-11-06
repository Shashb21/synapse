import { TACTIC_STATUSES, TACTIC_TYPES } from "@/lib/iegp/enums";

/**
 * LLM prompts for `inventory_extract` (proposer → critic → reviser → judge).
 *
 * Inventory tactics are studies, analyses, publications, or dissemination activities
 * already described in source materials — not net-new ideation (`origin: ideated`).
 * Every tactic must cite verbatim provenance: `source_file_id`, `block_id`, and `quote`.
 */

export const INVENTORY_PROPOSER_SYSTEM = `You extract tactics already committed or described in pharma Integrated Evidence Generation Plan source material.

A tactic is a study, analysis, publication, registry entry, or dissemination activity that exists, is running, is planned, or is explicitly proposed in the document. Do not invent tactics and do not turn an evidence gap into a tactic.

Rules:
- Every tactic must have origin "inventory" (found in the source — not created for a gap).
- type must be one of: ${TACTIC_TYPES.join(", ")}.
- status must be one of: ${TACTIC_STATUSES.join(", ")} and must reflect what the document says.
- evidence_question is the decision-relevant question the tactic answers, in one sentence.
- provenance is one or more verbatim quote spans: source_file_id, block_id, quote (substring of that block's text).
- Return JSON only:
{"tactics":[{"name":"","type":"","status":"","evidence_question":"","origin":"inventory","provenance":[{"source_file_id":"","block_id":"","quote":""}]}]}`;

export function inventoryProposerUser(args: {
  workspace_id: string;
  source_file_id: string;
  block_ids: string[];
  blocks: { id: string; heading: string | null; text: string }[];
  hints: string;
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
    args.hints ? `\n${args.hints}\n` : "",
    args.critiques.length ? `Critic issues to fix:\n${args.critiques.map((c) => `- ${c}`).join("\n")}` : "",
    "Parse blocks:",
    blockSection || "(no block text loaded — use block_ids only as hints)",
  ]
    .filter(Boolean)
    .join("\n");
}

export const INVENTORY_CRITIC_SYSTEM = `You are the critic in a proposer → critic → judge loop for tactic inventory extraction.

For each candidate tactic, verify:
- origin is inventory (not ideated).
- name, type, status, and evidence_question are specific and grounded.
- provenance quotes are verbatim and tied to the cited block_id and source_file_id.

Return JSON only: {"critiques":[{"subject":"","score":0,"issues":["no_quote|weak_quote|wrong_origin|vague|duplicate"]}]}`;

export function inventoryCriticUser(args: {
  draft_json: string;
}): string {
  return `Review this draft inventory JSON:\n${args.draft_json}`;
}
