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
- status must be one of: ${[...TACTIC_STATUSES, "unknown"].join(", ")} and must reflect what the document says.
- evidence_question is the decision-relevant question the tactic answers, in one sentence.
- provenance is one or more verbatim quote spans: source_file_id, block_id, quote (substring of that block's text).
- Every tactic includes structured.version=1 and description, objective, owner, timing, outputs, lifecycle.
- Each field is {state:"known",value:...,provenance:[...]} with its OWN supporting original block spans, or {state:"unknown",value:null,reason:"not_stated",provenance:[]}. Never invent an owner, date, deliverable or evidence. Missing fields remain unknown; these are suggestions, never human validation.
- description, objective and owner are text. timing is the stated milestone or range, verbatim or faithfully summarized; never manufacture ISO dates. outputs.value is an array of stated deliverables, not an imagined study outcome.
- lifecycle.value is a known status enum backed by a source quotation, or unknown. Top-level status must match the known lifecycle value or be "unknown" when lifecycle is unknown. Do not default missing status to planned.
- Include existing IIS, clinical studies, RWE, publications, congresses, registries, HEOR studies, surveys and chart reviews using the existing tactic types. Exclude new ideation, including any origin "ideated"; a proposed activity explicitly in the source is inventory with proposed lifecycle.
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
