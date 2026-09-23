import { z } from "zod";
import { mechanicalModule } from "../_factory";
import {
  auditCompleteness,
  missFlagSchema,
  type AuditClaimLite,
} from "./engine";
import { claimMetadata, listClaims } from "@/accuracy/store/claim-store";
import { readAllParseBlocks } from "@/accuracy/store/parse-store";
import { resolvedMissFlagBlockIds } from "@/accuracy/store/miss-flag-store";

export { auditCompleteness, missFlagSchema } from "./engine";
export type { MissFlag, MissFlagSuggested } from "./engine";

const inputSchema = z.object({
  workspace_id: z.string(),
  /** Optional cap for UI; full audit still deterministic. */
  limit: z.number().int().positive().optional(),
});

const outputSchema = z.object({
  flags: z.array(missFlagSchema),
  scanned_blocks: z.number().int(),
  open_flags: z.number().int(),
});

export type CompletenessAuditOutput = z.infer<typeof outputSchema>;

function claimsForAudit(
  rows: Awaited<ReturnType<typeof listClaims>>,
): AuditClaimLite[] {
  return rows.map((row) => {
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
    const flags = auditCompleteness({
      blocks,
      claims: claimsForAudit(claims),
      resolved_block_ids: resolved,
    });
    const limited =
      typeof input.limit === "number" ? flags.slice(0, input.limit) : flags;
    ctx.run.note("completeness:scanned", {
      scanned_blocks: blocks.length,
      open_flags: flags.length,
      returned: limited.length,
    });
    return {
      output: {
        flags: limited,
        scanned_blocks: blocks.length,
        open_flags: flags.length,
      },
      summary: `Completeness audit: ${flags.length} open miss flag(s) from ${blocks.length} block(s)`,
    };
  },
});
