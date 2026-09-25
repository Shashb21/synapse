import { z } from "zod";
import { assertAiEnabled } from "@/modules/kernel/ai-switch";
import type { AccuracyModuleContext } from "@/accuracy/kernel/contracts";
import { completeJson, requireAccuracyLlm } from "@/accuracy/kernel/routing";
import { completeAll } from "@/modules/kernel/llm";
import { NoRouteError } from "@/modules/llm/provider";
import type { EquivalenceQuestion, EquivalentPair, MergeCandidate } from "./engine";
import { MERGE_EQUIVALENCE_SYSTEM, mergeEquivalenceUser } from "./prompts";

/** Pairs per judge prompt. Batching only; every pair still gets its own decision. */
export const EQUIVALENCE_BATCH = 20;

const decisionSchema = z.object({
  pair_id: z.string().min(1),
  same: z.boolean(),
  rationale: z.string().trim().min(1),
});

type Decision = z.infer<typeof decisionSchema>;

/**
 * Asks the LLM judge whether each same-block pair is one item. Returns the pairs
 * it called the same. A pair the model never answers fails the merge.
 */
export async function judgeEquivalence(args: {
  ctx: AccuracyModuleContext;
  questions: EquivalenceQuestion[];
  candidates: MergeCandidate[];
}): Promise<EquivalentPair[]> {
  const { ctx } = args;
  if (args.questions.length === 0) return [];
  // Merge-dedupe itself is mechanical; only this judge needs a model, so the switch is checked here.
  await assertAiEnabled("Merge / dedupe");
  requireAccuracyLlm(ctx.route, "Merge / dedupe");
  const byId = new Map(args.candidates.map((candidate) => [candidate.id, candidate]));
  const questionById = new Map(args.questions.map((q, index) => [`p${index + 1}`, q]));
  const sideOf = (id: string) => {
    const candidate = byId.get(id)!;
    return {
      id,
      statement: candidate.statement,
      external_id: candidate.external_id,
      quotes: candidate.provenance.map((span) => span.quote).filter(Boolean),
    };
  };

  const decisions = await completeAll<Decision>({
    ids: [...questionById.keys()],
    what: "dedupe decision",
    describe: (pairId) => {
      const q = questionById.get(pairId)!;
      return `${q.a_id} vs ${q.b_id}`;
    },
    remedy: "run extract again or switch the merge_dedupe route in /admin/control.",
    ask: async (missing, attempt) => {
      const batches: string[][] = [];
      for (let i = 0; i < missing.length; i += EQUIVALENCE_BATCH) {
        batches.push(missing.slice(i, i + EQUIVALENCE_BATCH));
      }
      const answers = await Promise.all(
        batches.map(async (batch, index) => {
          const asked = new Set(batch);
          const out = new Map<string, Decision>();
          let raw: unknown;
          try {
            raw = await completeJson(ctx.complete, {
              system: MERGE_EQUIVALENCE_SYSTEM,
              user: mergeEquivalenceUser({
                pairs: batch.map((pair_id) => {
                  const q = questionById.get(pair_id)!;
                  return { pair_id, claim_type: q.claim_type, a: sideOf(q.a_id), b: sideOf(q.b_id) };
                }),
              }),
              purpose: `merge_dedupe:judge:a${attempt}:b${index + 1}`,
            });
          } catch (error) {
            if (error instanceof NoRouteError) throw error;
            ctx.run.note("merge:invalid-answer", {
              attempt,
              batch: index + 1,
              error: error instanceof Error ? error.message : String(error),
            });
            return out;
          }
          const rows = z.object({ decisions: z.array(z.unknown()) }).safeParse(raw);
          for (const row of rows.success ? rows.data.decisions : []) {
            const decision = decisionSchema.safeParse(row);
            if (decision.success && asked.has(decision.data.pair_id)) {
              out.set(decision.data.pair_id, decision.data);
            }
          }
          return out;
        }),
      );
      const merged = new Map<string, Decision>();
      for (const answer of answers) for (const [id, decision] of answer) merged.set(id, decision);
      return merged;
    },
  });

  ctx.run.note(
    "merge:judge",
    [...decisions.entries()].map(([pair_id, d]) => ({ ...questionById.get(pair_id), same: d.same, rationale: d.rationale })),
  );
  return [...decisions.entries()]
    .filter(([, decision]) => decision.same)
    .map(([pair_id, decision]) => {
      const q = questionById.get(pair_id)!;
      return { a_id: q.a_id, b_id: q.b_id, rationale: decision.rationale };
    });
}
