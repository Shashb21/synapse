import { z } from "zod";
import type { AccuracyModuleContext } from "@/accuracy/kernel/contracts";
import { completeJson, requireAccuracyLlm } from "@/accuracy/kernel/routing";
import { completeAll } from "@/modules/kernel/llm";
import { NoRouteError } from "@/modules/llm/provider";
import {
  claimsForSource,
  completenessVerdictSchema,
  type AuditBlockLite,
  type AuditClaimLite,
  type CompletenessVerdict,
} from "./engine";
import { COMPLETENESS_CRITIC_SYSTEM, completenessCriticUser } from "./prompts";

/** Blocks per critic prompt. Batching only; every block still gets its own verdict. */
export const COMPLETENESS_BATCH = 25;

function chunk<T>(rows: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

/**
 * Asks the completeness critic for a verdict on every block. Verdicts that are
 * missing or off-schema are asked for again; a block the model never answers
 * fails the audit rather than being filled in.
 */
export async function judgeCompleteness(args: {
  ctx: AccuracyModuleContext;
  blocks: AuditBlockLite[];
  claims: AuditClaimLite[];
}): Promise<Map<string, CompletenessVerdict>> {
  const { ctx } = args;
  if (args.blocks.length === 0) return new Map();
  requireAccuracyLlm(ctx.route, "The completeness audit");
  const byId = new Map(args.blocks.map((block) => [block.id, block]));

  return completeAll<CompletenessVerdict>({
    ids: args.blocks.map((block) => block.id),
    what: "completeness verdict",
    describe: (id) => `block ${id}`,
    remedy: "reload Review to ask again, or switch the completeness_audit route in /control.",
    ask: async (missing, attempt) => {
      const bySource = new Map<string, AuditBlockLite[]>();
      for (const id of missing) {
        const block = byId.get(id)!;
        const list = bySource.get(block.source_file_id) ?? [];
        list.push(block);
        bySource.set(block.source_file_id, list);
      }
      const batches = [...bySource.entries()].flatMap(([source_file_id, blocks]) =>
        chunk(blocks, COMPLETENESS_BATCH).map((batch) => ({ source_file_id, batch })),
      );
      const answers = await Promise.all(
        batches.map(async ({ source_file_id, batch }, index) => {
          const asked = new Set(batch.map((block) => block.id));
          const out = new Map<string, CompletenessVerdict>();
          let raw: unknown;
          try {
            raw = await completeJson(ctx.complete, {
              system: COMPLETENESS_CRITIC_SYSTEM,
              user: completenessCriticUser({
                source_file_id,
                claims: claimsForSource(args.claims, source_file_id),
                blocks: batch.map((block) => ({
                  id: block.id,
                  kind: block.kind,
                  heading: block.heading ?? null,
                  text: block.text,
                })),
              }),
              purpose: `completeness_audit:critic:a${attempt}:b${index + 1}`,
            });
          } catch (error) {
            if (error instanceof NoRouteError) throw error;
            ctx.run.note("completeness:invalid-answer", {
              attempt,
              batch: index + 1,
              error: error instanceof Error ? error.message : String(error),
            });
            return out;
          }
          const rows = z.object({ verdicts: z.array(z.unknown()) }).safeParse(raw);
          for (const row of rows.success ? rows.data.verdicts : []) {
            const verdict = completenessVerdictSchema.safeParse(row);
            if (verdict.success && asked.has(verdict.data.block_id)) {
              out.set(verdict.data.block_id, verdict.data);
            }
          }
          return out;
        }),
      );
      const merged = new Map<string, CompletenessVerdict>();
      for (const answer of answers) for (const [id, verdict] of answer) merged.set(id, verdict);
      return merged;
    },
  });
}
