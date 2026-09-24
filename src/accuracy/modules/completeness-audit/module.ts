import { z } from "zod";
import { agenticModule } from "../_factory";
import {
  collapseAuditText,
  flagsFromVerdicts,
  missFlagSchema,
  selectBlocksToJudge,
  type AuditClaimLite,
  type CompletenessVerdict,
} from "./engine";
import { judgeCompleteness } from "./critic";
import { assertAiEnabled } from "@/modules/kernel/ai-switch";
import {
  claimMetadata,
  isActiveLedgerClaim,
  listClaims,
  type AccuracyClaimRow,
} from "@/accuracy/store/claim-store";
import { readAllParseBlocks } from "@/accuracy/store/parse-store";
import { resolvedMissFlagBlockIds } from "@/accuracy/store/miss-flag-store";
import {
  listCompletenessVerdicts,
  saveCompletenessVerdicts,
  sha256,
} from "@/accuracy/store/completeness-verdict-store";
import { isTestStub } from "@/modules/kernel/llm";

export {
  citedBlockIds,
  completenessVerdictSchema,
  excerptFromBlock,
  flagsFromVerdicts,
  missFlagSchema,
  selectBlocksToJudge,
} from "./engine";
export type { CompletenessVerdict, MissFlag, MissFlagSuggested } from "./engine";
export { judgeCompleteness } from "./critic";

const inputSchema = z.object({
  workspace_id: z.string(),
  /** Optional cap for UI; every block is still judged. */
  limit: z.number().int().positive().optional(),
  /** Ignore stored verdicts and ask the critic about every block again. */
  fresh: z.boolean().optional(),
});

const outputSchema = z.object({
  mode: z.enum(["llm", "stub"]),
  flags: z.array(missFlagSchema),
  scanned_blocks: z.number().int(),
  open_flags: z.number().int(),
  /** Blocks a ledger claim cites by provenance (covered as a matter of fact). */
  cited_blocks: z.number().int(),
  /** Blocks the critic judged this run. */
  judged_blocks: z.number().int(),
  /** Blocks answered from an earlier critic verdict on the same text. */
  reused_verdicts: z.number().int(),
  /** Blocks the critic judged not to be a missed gap or tactic. */
  skipped_noise: z.number().int(),
});

export type CompletenessAuditOutput = z.infer<typeof outputSchema>;

function claimsForAudit(rows: AccuracyClaimRow[]): AuditClaimLite[] {
  return rows.filter(isActiveLedgerClaim).map((row) => {
    const meta = claimMetadata(row);
    const provenance = Array.isArray(meta.provenance)
      ? (meta.provenance as Array<{ block_id?: string | null }>)
      : null;
    return {
      id: row.id,
      claim_type: row.claim_type,
      statement: row.statement,
      source_file_id: row.source_file_id,
      provenance,
    };
  });
}

/** Fingerprint of the ledger a verdict was judged against. */
function ledgerDigest(claims: AuditClaimLite[]): string {
  return sha256(
    claims
      .map((claim) => `${claim.id}\u0000${claim.claim_type}\u0000${claim.statement}`)
      .sort()
      .join("\u0001"),
  );
}

/**
 * Completeness audit — the recall gate (index vs ledger). Cited blocks are
 * covered by fact; every other block is judged by the LLM completeness critic,
 * which decides whether it is a missed gap or tactic and says why. No LLM, no
 * audit: there is no rule-based fallback.
 *
 * Verdicts are stored per block text. A "not missed" verdict stays valid as
 * the ledger grows; a "missed" one is re-asked whenever the ledger changes,
 * since a new claim may now cover it. `fresh` re-asks everything.
 */
export const completenessAuditModule = agenticModule({
  id: "completeness-audit.critic-v1",
  call_kind: "completeness_audit",
  title: "Completeness audit",
  summary: "LLM completeness critic: index vs ledger miss flags.",
  inputSchema,
  outputSchema,
  run: async (input, ctx) => {
    // Defence in depth behind runAccuracyModule: with AI off the audit never
    // reads blocks, asks a model or stores a verdict (the test stub included).
    await assertAiEnabled("The completeness audit");
    const [blocks, claimRows, resolved] = await Promise.all([
      readAllParseBlocks(input.workspace_id),
      listClaims(input.workspace_id, { limit: 500 }),
      resolvedMissFlagBlockIds(input.workspace_id),
    ]);
    const claims = claimsForAudit(claimRows);
    const selection = selectBlocksToJudge({ blocks, claims, resolved_block_ids: resolved });
    const verdicts = new Map<string, CompletenessVerdict>();
    let judged = 0;
    let reused = 0;
    const stub = isTestStub();

    if (stub) {
      // Test stub only: every uncited block is surfaced, labelled as unjudged.
      for (const block of selection.to_judge) {
        verdicts.set(block.id, {
          block_id: block.id,
          missed: true,
          claim_type: "gap",
          rationale: "Test stub (SYNAPSE_TEST_STUB_LLM): uncited block, not judged by a model",
        });
      }
    } else {
      const digest = ledgerDigest(claims);
      const hashOf = new Map(
        selection.to_judge.map((block) => [block.id, sha256(collapseAuditText(block.text))]),
      );
      if (!input.fresh) {
        for (const row of await listCompletenessVerdicts(input.workspace_id)) {
          if (hashOf.get(row.block_id) !== row.text_hash) continue;
          if (row.missed && row.ledger_digest !== digest) continue;
          verdicts.set(row.block_id, {
            block_id: row.block_id,
            missed: row.missed,
            claim_type: row.claim_type === "gap" || row.claim_type === "tactic" ? row.claim_type : null,
            rationale: row.rationale,
          });
        }
      }
      reused = verdicts.size;
      const pending = selection.to_judge.filter((block) => !verdicts.has(block.id));
      const fresh = await judgeCompleteness({ ctx, blocks: pending, claims });
      judged = fresh.size;
      await saveCompletenessVerdicts(
        [...fresh.values()].map((verdict) => ({
          workspace_id: input.workspace_id,
          block_id: verdict.block_id,
          text_hash: hashOf.get(verdict.block_id)!,
          ledger_digest: digest,
          missed: verdict.missed,
          claim_type: verdict.claim_type,
          rationale: verdict.rationale,
          run_id: ctx.run.id,
        })),
      );
      for (const [id, verdict] of fresh) verdicts.set(id, verdict);
    }

    const flags = flagsFromVerdicts(selection.to_judge, verdicts);
    const notMissed = selection.to_judge.length - flags.length;
    const limited = typeof input.limit === "number" ? flags.slice(0, input.limit) : flags;
    ctx.run.note("completeness:scanned", {
      scanned_blocks: blocks.length,
      cited: selection.cited,
      resolved: selection.resolved,
      empty: selection.empty,
      judged,
      reused,
      open_flags: flags.length,
      returned: limited.length,
    });
    return {
      output: {
        mode: stub ? "stub" : "llm",
        flags: limited,
        scanned_blocks: blocks.length,
        open_flags: flags.length,
        cited_blocks: selection.cited,
        judged_blocks: judged,
        reused_verdicts: reused,
        skipped_noise: notMissed,
      },
      summary: stub
        ? `Completeness audit test stub (SYNAPSE_TEST_STUB_LLM): ${flags.length} uncited block(s) surfaced unjudged`
        : `Completeness audit: ${flags.length} open miss flag(s) from ${blocks.length} block(s); critic judged ${judged}, reused ${reused}, ${notMissed} not a miss`,
    };
  },
});
