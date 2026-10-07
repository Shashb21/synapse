import { z } from "zod";

/**
 * Completeness audit bookkeeping: index (parse blocks) vs ledger (claims).
 *
 * Only facts are settled here — a block the ledger cites by provenance is
 * covered, a resolved or empty block has nothing to judge. Whether any other
 * block is a missed gap or tactic is the completeness critic's call (critic.ts).
 */

export const missFlagSuggestedSchema = z.enum(["gap", "tactic"]);
export type MissFlagSuggested = z.infer<typeof missFlagSuggestedSchema>;

export const missFlagSchema = z.object({
  block_id: z.string(),
  source_file_id: z.string(),
  suggested: missFlagSuggestedSchema,
  /** The critic's rationale (or the test-stub label). */
  reason: z.string(),
  excerpt: z.string(),
  kind: z.string(),
  index: z.number().int(),
});

export type MissFlag = z.infer<typeof missFlagSchema>;

/** One critic verdict. A miss must say whether it is a gap or a tactic. */
export const completenessVerdictSchema = z
  .object({
    block_id: z.string().min(1),
    missed: z.boolean(),
    claim_type: missFlagSuggestedSchema.nullable(),
    rationale: z.string().trim().min(1),
  })
  .refine((verdict) => !verdict.missed || verdict.claim_type !== null, {
    message: "a missed block needs claim_type gap or tactic",
  });

export type CompletenessVerdict = z.infer<typeof completenessVerdictSchema>;

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
  source_file_id?: string | null;
  provenance?: Array<{ block_id?: string | null }> | null;
};

const EXCERPT_MAX = 220;

export function collapseAuditText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function excerptFromBlock(text: string, max = EXCERPT_MAX): string {
  const collapsed = collapseAuditText(text);
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max - 1)}…`;
}

export function citedBlockIds(claims: AuditClaimLite[]): Set<string> {
  const ids = new Set<string>();
  for (const claim of claims) {
    const spans = Array.isArray(claim.provenance) ? claim.provenance : [];
    for (const span of spans) {
      if (span?.block_id) ids.add(span.block_id);
    }
  }
  return ids;
}

export type AuditSelection = {
  /** Blocks the critic must judge, in document order. */
  to_judge: AuditBlockLite[];
  /** Blocks a ledger claim cites by provenance. */
  cited: number;
  /** Blocks already promoted or dismissed by a reviewer. */
  resolved: number;
  /** Blocks with no text at all. */
  empty: number;
};

/** Splits blocks into settled facts and the ones that need a verdict. */
export function selectBlocksToJudge(args: {
  blocks: AuditBlockLite[];
  claims: AuditClaimLite[];
  resolved_block_ids?: Iterable<string>;
}): AuditSelection {
  const resolvedIds = new Set(args.resolved_block_ids ?? []);
  const citedIds = citedBlockIds(args.claims);
  const sorted = [...args.blocks].sort((a, b) => {
    if (a.source_file_id !== b.source_file_id) {
      return a.source_file_id.localeCompare(b.source_file_id);
    }
    return a.index - b.index;
  });
  const selection: AuditSelection = { to_judge: [], cited: 0, resolved: 0, empty: 0 };
  for (const block of sorted) {
    if (resolvedIds.has(block.id)) {
      selection.resolved += 1;
    } else if (citedIds.has(block.id)) {
      selection.cited += 1;
    } else if (!collapseAuditText(block.text)) {
      selection.empty += 1;
    } else {
      selection.to_judge.push(block);
    }
  }
  return selection;
}

/** Ledger claims the critic sees for one source (plus claims with no source). */
export function claimsForSource(claims: AuditClaimLite[], source_file_id: string): AuditClaimLite[] {
  return claims.filter((claim) => !claim.source_file_id || claim.source_file_id === source_file_id);
}

/** Open miss flags: every judged block the critic called a miss, in document order. */
export function flagsFromVerdicts(
  blocks: AuditBlockLite[],
  verdicts: Map<string, CompletenessVerdict>,
): MissFlag[] {
  const flags: MissFlag[] = [];
  for (const block of blocks) {
    const verdict = verdicts.get(block.id);
    if (!verdict?.missed || !verdict.claim_type) continue;
    flags.push({
      block_id: block.id,
      source_file_id: block.source_file_id,
      suggested: verdict.claim_type,
      reason: verdict.rationale,
      excerpt: excerptFromBlock(block.text),
      kind: block.kind,
      index: block.index,
    });
  }
  return flags;
}
