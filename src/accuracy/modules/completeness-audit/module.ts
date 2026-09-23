import { z } from "zod";
import { mechanicalModule } from "../_factory";
import {
  auditCompletenessDetailed,
  missFlagSchema,
  type AuditClaimLite,
} from "./engine";
import {
  claimMetadata,
  isActiveLedgerClaim,
  listClaims,
  type AccuracyClaimRow,
} from "@/accuracy/store/claim-store";
import { readAllParseBlocks } from "@/accuracy/store/parse-store";
import { resolvedMissFlagBlockIds } from "@/accuracy/store/miss-flag-store";

export { auditCompleteness, auditCompletenessDetailed, missFlagSchema } from "./engine";
export type { MissFlag, MissFlagSuggested, CompletenessAuditResult } from "./engine";
export {
  completenessSkipReason,
  isHeadingOnlyNoise,
  isChapterLabelNoise,
  isSiLabelNoise,
} from "./skip-rules";

const inputSchema = z.object({
  workspace_id: z.string(),
  /** Optional cap for UI; full audit still deterministic. */
  limit: z.number().int().positive().optional(),
});

const outputSchema = z.object({
  flags: z.array(missFlagSchema),
  scanned_blocks: z.number().int(),
  open_flags: z.number().int(),
  skipped_noise: z.number().int(),
  skipped_by_reason: z.object({
    heading_only: z.number().int(),
    chapter_label: z.number().int(),
    si_label: z.number().int(),
  }),
});

export type CompletenessAuditOutput = z.infer<typeof outputSchema>;

function claimsForAudit(
  rows: Awaited<ReturnType<typeof listClaims>>,
): AuditClaimLite[] {
  return rows.filter(isActiveLedgerClaim).map((row: AccuracyClaimRow) => {
    const meta = claimMetadata(row);
    const provenance = Array.isArray(meta.provenance)
      ? (meta.provenance as Array<{ block_id?: string | null }>)
      : null;
    return {
      id: row.id,
      claim_type: row.claim_type,
      statement: row.statement,
      provenance,
    };
  });
}

/**
 * Completeness audit — deterministic local recall gate (index vs inventory).
 * No LLM required. A future agentic critic can layer on once providers are connected.
 */
export const completenessAuditModule = mechanicalModule({
  id: "completeness-audit.local-v1",
  call_kind: "completeness_audit",
  title: "Completeness audit",
  summary: "Index vs inventory miss flags.",
  inputSchema,
  outputSchema,
  run: async (input, ctx) => {
    const [blocks, claims, resolved] = await Promise.all([
      readAllParseBlocks(input.workspace_id),
      listClaims(input.workspace_id, { limit: 500 }),
      resolvedMissFlagBlockIds(input.workspace_id),
    ]);
    const { flags, skipped_noise, skipped_by_reason } = auditCompletenessDetailed({
      blocks,
      claims: claimsForAudit(claims),
      resolved_block_ids: resolved,
    });
    const limited =
      typeof input.limit === "number" ? flags.slice(0, input.limit) : flags;
    ctx.run.note("completeness:scanned", {
      scanned_blocks: blocks.length,
      open_flags: flags.length,
      skipped_noise,
      skipped_by_reason,
      returned: limited.length,
    });
    return {
      output: {
        flags: limited,
        scanned_blocks: blocks.length,
        open_flags: flags.length,
        skipped_noise,
        skipped_by_reason,
      },
      summary: `Completeness audit: ${flags.length} open miss flag(s) from ${blocks.length} block(s); ${skipped_noise} heading/chapter/SI skipped`,
    };
  },
});
