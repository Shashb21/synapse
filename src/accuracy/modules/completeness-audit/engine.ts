import { z } from "zod";

/** Text + table kinds only — skip slide masters / icons / empty captions (reference UX). */
export const AUDITABLE_BLOCK_KINDS = new Set([
  "prose",
  "table_row",
  "list_item",
  "heading",
]);

export const missFlagSuggestedSchema = z.enum(["gap", "tactic"]);
export type MissFlagSuggested = z.infer<typeof missFlagSuggestedSchema>;

export const missFlagSchema = z.object({
  block_id: z.string(),
  source_file_id: z.string(),
  suggested: missFlagSuggestedSchema,
  reason: z.string(),
  excerpt: z.string(),
  kind: z.string(),
  index: z.number().int(),
});

export type MissFlag = z.infer<typeof missFlagSchema>;

export type AuditBlockLite = {
  id: string;
  source_file_id: string;
  index: number;
  kind: string;
  text: string;
  heading?: string | null;
};

export type AuditClaimLite = {
  id: string;
  claim_type: "gap" | "tactic" | string;
  statement: string;
  provenance?: Array<{ block_id?: string | null }> | null;
};

const MIN_BLOCK_CHARS = 24;
const EXCERPT_MAX = 220;
const OVERLAP_MIN_TOKEN_LEN = 4;
const OVERLAP_HIT_RATIO = 0.45;

const TACTIC_HINT =
  /\b(tactic|study|trial|registry|chart review|publication|rwe|iis|survey|advisory|heor|phase\s*[123]|ongoing|planned|completed)\b/i;
const GAP_HINT =
  /\b(gap|need|evidence gap|unknown|unclear|lack of|insufficient|missing|unmet|open question)\b/i;

function normalizeTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= OVERLAP_MIN_TOKEN_LEN);
}

/** True when block text substantially overlaps a claim statement (gold seed without provenance). */
export function blockOverlapsStatement(blockText: string, statement: string): boolean {
  const blockTokens = new Set(normalizeTokens(blockText));
  const claimTokens = normalizeTokens(statement);
  if (claimTokens.length === 0 || blockTokens.size === 0) return false;
  let hits = 0;
  for (const token of claimTokens) {
    if (blockTokens.has(token)) hits += 1;
  }
  return hits / claimTokens.length >= OVERLAP_HIT_RATIO;
}

export function excerptFromBlock(text: string, max = EXCERPT_MAX): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max - 1)}…`;
}

export function suggestClaimType(block: AuditBlockLite): MissFlagSuggested {
  const hay = `${block.heading ?? ""} ${block.text}`;
  const tacticScore = TACTIC_HINT.test(hay) ? 1 : 0;
  const gapScore = GAP_HINT.test(hay) ? 1 : 0;
  if (tacticScore > gapScore) return "tactic";
  if (gapScore > tacticScore) return "gap";
  if (block.kind === "table_row") return "tactic";
  return "gap";
}

function citedBlockIds(claims: AuditClaimLite[]): Set<string> {
  const ids = new Set<string>();
  for (const claim of claims) {
    const spans = Array.isArray(claim.provenance) ? claim.provenance : [];
    for (const span of spans) {
      if (span?.block_id) ids.add(span.block_id);
    }
  }
  return ids;
}

function isCoveredByClaims(block: AuditBlockLite, claims: AuditClaimLite[], cited: Set<string>): boolean {
  if (cited.has(block.id)) return true;
  return claims.some((claim) => blockOverlapsStatement(block.text, claim.statement));
}

/**
 * Deterministic completeness audit: index (parse blocks) vs inventory/needs (claims).
 * Flags auditable blocks that are neither provenance-cited nor lexically covered.
 */
export function auditCompleteness(args: {
  blocks: AuditBlockLite[];
  claims: AuditClaimLite[];
  resolved_block_ids?: Iterable<string>;
}): MissFlag[] {
  const resolved = new Set(args.resolved_block_ids ?? []);
  const cited = citedBlockIds(args.claims);
  const flags: MissFlag[] = [];

  const sorted = [...args.blocks].sort((a, b) => {
    if (a.source_file_id !== b.source_file_id) {
      return a.source_file_id.localeCompare(b.source_file_id);
    }
    return a.index - b.index;
  });

  for (const block of sorted) {
    if (resolved.has(block.id)) continue;
    if (!AUDITABLE_BLOCK_KINDS.has(block.kind)) continue;
    const text = block.text.replace(/\s+/g, " ").trim();
    if (text.length < MIN_BLOCK_CHARS) continue;
    if (isCoveredByClaims(block, args.claims, cited)) continue;

    const suggested = suggestClaimType(block);
    flags.push({
      block_id: block.id,
      source_file_id: block.source_file_id,
      suggested,
      reason:
        suggested === "tactic"
          ? "Parse block not cited by inventory and not overlapping a tactic statement"
          : "Parse block not cited by needs and not overlapping a gap statement",
      excerpt: excerptFromBlock(text),
      kind: block.kind,
      index: block.index,
    });
  }

  return flags;
}
