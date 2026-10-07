import { sourceUnitHeader } from "../../domain/source-pages";
import { SOURCE_EVIDENCE_CATEGORY_DOMAINS } from "@/lib/iegp/enums";

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
- Slice headers use ORIGINAL block IDs and ORIGINAL character offsets. Cite only the supplied slice. Include char_start/char_end using original offsets, especially for repeated words.
- provenance is one or more verbatim quote spans: source_file_id, block_id, quote (substring of that block's text).
- Every gap includes structured.version=1 and these fields: description, indication, disease_setting, category, rationale, supporting_documents, interview_quotes.
- Each field is {state:"known",value:...,provenance:[...]} with its OWN supporting original block spans, or {state:"unknown",value:null,reason:"not_stated",provenance:[]}. Never invent absent facts, quotations or evidence. These are suggestions, never human validation.
- description, indication, disease_setting and rationale have text values; do not infer setting from the indication.
- category.value is {source_label:"...",evidence_domain:"..."}; retain the exact source area even when the vocabulary is coarser. Allowed source areas and mapped evidence domains: ${JSON.stringify(SOURCE_EVIDENCE_CATEGORY_DOMAINS)}. If the source cannot support a category, mark it unknown.
- supporting_documents.value is an array of {title:"stated title",document_id:"stated ID or null",resolution:"unresolved",source_file_id:null}. A mentioned document is not an available attachment. Do not invent or resolve file links.
- interview_quotes.value is an array of {quote:{source_file_id,block_id,quote},speaker:structured text field,role:structured text field}. Cite the original words and separately evidence each stated speaker and role. Keep attribution unknown when not stated; a source's stakeholder classification does not identify a speaker.
- Return JSON only:
{"gaps":[{"statement":"","external_id":null,"provenance":[{"source_file_id":"","block_id":"","quote":""}]}]}`;

export function needProposerUser(args: {
  workspace_id: string;
  source_file_id: string;
  block_ids: string[];
  blocks: { id: string; heading: string | null; text: string; char_start?: number; char_end?: number }[];
  critiques: string[];
}): string {
  const blockSection = args.blocks
    .map((b) => `${b.char_start === undefined ? `### block_id=${b.id}${b.heading ? ` · ${b.heading}` : ""}\n` : sourceUnitHeader({ block_id: b.id, heading: b.heading, char_start: b.char_start, char_end: b.char_end! })}${b.text}`)
    .join("\n\n");
  return [
    `workspace_id=${args.workspace_id}`,
    `source_file_id=${args.source_file_id}`,
    args.block_ids.length && !args.blocks.some(b => b.char_start !== undefined) ? `target_block_ids: ${args.block_ids.join(", ")}` : "",
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
