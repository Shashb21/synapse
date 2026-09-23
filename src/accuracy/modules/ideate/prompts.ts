import { TACTIC_TYPES } from "@/lib/iegp/enums";

/**
 * LLM prompts for `ideate` (proposer → mechanical critic → reviser → judge).
 *
 * Net-new tactics for validated HIGH-priority open gaps only.
 * Inventory tactics come from `inventory_extract` — never invent them here,
 * never attach provenance quotes from parse blocks, and never reuse deck IDs.
 */

export const IDEATE_PROPOSER_SYSTEM = `You design net-new evidence tactics for a pharma Integrated Evidence Generation Plan.

These tactics do NOT already exist in the source materials. They are created to close residual HIGH-priority open evidence gaps. Inventory tactics (studies already in the deck) are extracted separately — do not copy them.

Rules:
- Propose tactics only for the listed eligible gap_ids. Ignore any other gap.
- origin must be "ideated". status must be "proposed". not_from_reference must be true.
- Do not cite parse-block quotes, source_file_id, block_id, or provenance.
- Do not reuse inventory identifiers (G:n, NSCLC_*_*, tactic numbers) as the name.
- Do not duplicate existing_tactic_names.
- type must be one of: ${TACTIC_TYPES.join(", ")}.
- name is a specific runnable study/analysis/publication title (8–280 chars).
- design_summary is one short paragraph: population, comparator if relevant, outcomes, data source, design.
- Return JSON only:
{"proposals":[{"gap_id":"","name":"","type":"","origin":"ideated","status":"proposed","design_summary":"","not_from_reference":true}]}`;

export function ideateProposerUser(args: {
  workspace_id: string;
  gaps: { id: string; statement: string }[];
  existing_tactic_names: string[];
  per_gap: number;
  hints?: string;
  critiques?: string[];
}): string {
  const gapSection = args.gaps
    .map((g) => `- gap_id=${g.id}\n  statement: ${g.statement}`)
    .join("\n");
  const library =
    args.existing_tactic_names.length > 0
      ? args.existing_tactic_names.slice(0, 80).map((n) => `- ${n}`).join("\n")
      : "(none)";
  return [
    `workspace_id=${args.workspace_id}`,
    `tactics_per_gap=${args.per_gap}`,
    args.hints ? `Human hints:\n${args.hints}` : "",
    args.critiques?.length
      ? `Critic issues to fix:\n${args.critiques.map((c) => `- ${c}`).join("\n")}`
      : "",
    "Eligible HIGH-priority open gaps (only these):",
    gapSection || "(none)",
    "Existing tactic names (do not duplicate):",
    library,
  ]
    .filter(Boolean)
    .join("\n\n");
}
