import { desc } from "drizzle-orm";
import { z } from "zod";
import { db, ensurePlatformSchema } from "@/modules/kernel/db";
import { newId, nowIso } from "@/modules/kernel/ids";
import { registerModule } from "@/modules/kernel/registry";
import { runAgenticCycle } from "@/modules/kernel/agentic";
import { canPrompt } from "@/modules/kernel/routing";
import type { ModuleContext, SynapseModule } from "@/modules/kernel/contracts";
import { assignTacticToGap, loadState } from "@/lib/iegp/store";
import { gapEligibleForMapping, tacticEligibleForMapping } from "@/lib/iegp/engine";
import { MAPPING_SCORE_FLOOR, scoreGapTacticMapping } from "@/lib/iegp/mapping";
import type { IegpState } from "@/lib/iegp/types";
import { MAPPING_CANDIDATES_DDL, mappingCandidates } from "./schema";

const inputSchema = z.object({
  gap_ids: z.array(z.string()).optional(),
  tactic_ids: z.array(z.string()).optional(),
  /** Maximum edges kept per gap so the graph stays readable. */
  max_per_gap: z.number().int().min(1).max(20).default(6),
  dry_run: z.boolean().default(false),
});

const edgeSchema = z.object({
  gap_id: z.string(),
  gap_name: z.string(),
  tactic_id: z.string(),
  tactic_name: z.string(),
  score: z.number(),
  confidence: z.number(),
  rationale: z.array(z.string()),
  verdict: z.string(),
});

const outputSchema = z.object({
  mode: z.enum(["llm", "deterministic"]),
  proposed: z.number(),
  accepted: z.array(edgeSchema),
  rejected: z.array(edgeSchema),
  committed: z.array(z.object({ gap_id: z.string(), tactic_id: z.string() })),
  graph: z.object({
    gaps: z.number(),
    tactics: z.number(),
    edges: z.number(),
    gaps_with_no_edge: z.number(),
  }),
});

export type MappingInput = z.infer<typeof inputSchema>;
export type MappingOutput = z.infer<typeof outputSchema>;

type Edge = {
  gap_id: string;
  gap_name: string;
  tactic_id: string;
  tactic_name: string;
  score: number;
  confidence: number;
  rationale: string[];
};

const MAPPING_PROPOSER_SYSTEM = `You map evidence gaps to tactics for an Integrated Evidence Generation Plan.

A mapping means the tactic produces evidence that bears on the gap. Mapping is many-to-many: one tactic may bear on several gaps and one gap may need several tactics. Do not map a tactic that merely disseminates evidence unless the gap is about dissemination.

For each edge give confidence 0-100 and a one-sentence rationale naming what overlaps (population, comparator, outcome, timing).

Return JSON only: {"edges":[{"gap_id":"","tactic_id":"","confidence":0,"rationale":""}]}`;

function key(edge: { gap_id: string; tactic_id: string }): string {
  return `${edge.gap_id}::${edge.tactic_id}`;
}

function candidateSets(state: IegpState, input: MappingInput) {
  const gaps = state.gaps.filter(
    (gap) =>
      gapEligibleForMapping(gap.status) &&
      !gap.retired &&
      (!input.gap_ids?.length || input.gap_ids.includes(gap.id)),
  );
  const tactics = state.tactics.filter(
    (tactic) =>
      tacticEligibleForMapping(tactic) &&
      (!input.tactic_ids?.length || input.tactic_ids.includes(tactic.id)),
  );
  return { gaps, tactics };
}

function localProposals(state: IegpState, input: MappingInput): Edge[] {
  const { gaps, tactics } = candidateSets(state, input);
  const rejected = new Set(
    state.mapping_suggestions.filter((row) => row.status === "rejected").map(key),
  );
  const covered = new Set(state.coverages.map(key));
  const needsByGap = new Map<string, IegpState["needs"]>();
  for (const link of state.need_gap_links) {
    const need = state.needs.find((row) => row.id === link.need_id);
    if (!need) continue;
    const list = needsByGap.get(link.gap_id) ?? [];
    list.push(need);
    needsByGap.set(link.gap_id, list);
  }
  const residualByGap = new Map(state.residuals.map((row) => [row.gap_id, row.statement]));
  const out: Edge[] = [];
  for (const gap of gaps) {
    for (const tactic of tactics) {
      const pair = { gap_id: gap.id, tactic_id: tactic.id };
      if (rejected.has(key(pair)) || covered.has(key(pair))) continue;
      const scored = scoreGapTacticMapping(gap, tactic, {
        needs: needsByGap.get(gap.id),
        residual_statement: residualByGap.get(gap.id),
      });
      if (scored.score < MAPPING_SCORE_FLOOR) continue;
      out.push({
        gap_id: gap.id,
        gap_name: gap.name,
        tactic_id: tactic.id,
        tactic_name: tactic.name,
        score: scored.score,
        confidence: scored.score,
        rationale: scored.reasons,
      });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

async function llmProposals(
  ctx: ModuleContext,
  state: IegpState,
  input: MappingInput,
  hints: string,
): Promise<Edge[]> {
  const { gaps, tactics } = candidateSets(state, input);
  if (gaps.length === 0 || tactics.length === 0) return [];
  const payload = (await ctx.complete({
    system: MAPPING_PROPOSER_SYSTEM,
    user: JSON.stringify({
      hints: hints || undefined,
      gaps: gaps.map((gap) => ({ id: gap.id, name: gap.name, statement: gap.statement, domain: gap.domain })),
      tactics: tactics.map((tactic) => ({
        id: tactic.id,
        name: tactic.name,
        type: tactic.type,
        status: tactic.status,
        evidence_question: tactic.evidence_question,
        population: tactic.population,
        comparator: tactic.comparator,
        outcomes: tactic.outcomes,
      })),
    }),
    purpose: "kg-mapping-proposer",
  })) as { edges?: { gap_id?: string; tactic_id?: string; confidence?: number; rationale?: string }[] };
  const out: Edge[] = [];
  for (const edge of payload.edges ?? []) {
    const gap = gaps.find((candidate) => candidate.id === edge.gap_id);
    const tactic = tactics.find((candidate) => candidate.id === edge.tactic_id);
    if (!gap || !tactic) continue;
    const scored = scoreGapTacticMapping(gap, tactic, {});
    out.push({
      gap_id: gap.id,
      gap_name: gap.name,
      tactic_id: tactic.id,
      tactic_name: tactic.name,
      score: scored.score,
      confidence: Math.max(0, Math.min(100, Math.round(edge.confidence ?? 50))),
      rationale: [(edge.rationale ?? "").trim() || "model proposed this edge", ...scored.reasons],
    });
  }
  return out;
}

export const kgMappingModule: SynapseModule<MappingInput, MappingOutput> = {
  manifest: {
    id: "s4-kg-mapping.scored-pcj",
    stage: "S4",
    version: "1.0.0",
    title: "Knowledge-graph mapping (scored + judged)",
    summary:
      "Proposes many-to-many gap ↔ tactic edges from the dimension scorer and the model, then judges which edges join.",
    contract: 1,
    agentic: true,
    capabilities: ["many-to-many", "llm-proposer", "scored-proposer"],
  },
  inputSchema,
  outputSchema,
  migrations: [MAPPING_CANDIDATES_DDL],
  async run(input, ctx) {
    const state = await loadState();
    const { gaps, tactics } = candidateSets(state, input);

    const outcome = await runAgenticCycle<Edge>(ctx, "S4", {
      subjectOf: (edge) => key(edge),
      proposer: {
        local: () => localProposals(state, input),
        llm: canPrompt(ctx.route) ? ({ hints }) => llmProposals(ctx, state, input, hints) : undefined,
      },
      critic: (edges) =>
        edges.map((edge) => {
          const blended = Math.round((edge.score + edge.confidence) / 2);
          const notes: string[] = [];
          if (edge.score < MAPPING_SCORE_FLOOR) notes.push("below the dimension-score floor");
          if (edge.confidence < 40) notes.push("low model confidence");
          if (edge.rationale.length === 0) notes.push("no rationale");
          return {
            subject: key(edge),
            verdict: blended >= 60 ? ("keep" as const) : blended >= 40 ? ("revise" as const) : ("drop" as const),
            note: notes.length ? notes.join("; ") : edge.rationale.slice(0, 2).join("; "),
            score: blended,
          };
        }),
      judge: ({ candidates, critiques }) => {
        const perGap = new Map<string, number>();
        const seen = new Set<string>();
        return [...candidates]
          .sort((a, b) => b.score - a.score)
          .map((edge) => {
            const critique = critiques.find((item) => item.subject === key(edge));
            const score = critique?.score ?? 50;
            const used = perGap.get(edge.gap_id) ?? 0;
            const duplicate = seen.has(key(edge));
            const accept =
              !duplicate && critique?.verdict !== "drop" && score >= 45 && used < input.max_per_gap;
            if (accept) {
              perGap.set(edge.gap_id, used + 1);
              seen.add(key(edge));
            }
            return {
              candidate: edge,
              subject: key(edge),
              verdict: accept ? ("accept" as const) : ("reject" as const),
              score,
              note: duplicate
                ? "Rejected: duplicate edge."
                : used >= input.max_per_gap
                  ? `Rejected: gap already has ${input.max_per_gap} edge(s) this run.`
                  : (critique?.note ?? "no critique"),
            };
          });
      },
    });

    const rows = outcome.judged.map((item) => ({
      id: newId("mc"),
      run_id: ctx.run.id,
      gap_id: item.candidate.gap_id,
      tactic_id: item.candidate.tactic_id,
      score: item.candidate.score,
      confidence: item.score,
      rationale: item.candidate.rationale,
      verdict: item.verdict,
      committed: false,
      proposer: outcome.mode,
      created_at: nowIso(),
    }));
    if (rows.length > 0) await db().insert(mappingCandidates).values(rows);

    const committed: { gap_id: string; tactic_id: string }[] = [];
    if (!input.dry_run) {
      for (const edge of outcome.accepted) {
        try {
          await assignTacticToGap({
            gap_id: edge.gap_id,
            tactic_id: edge.tactic_id,
            actor_name: ctx.actor.name,
            actor_function: ctx.actor.function,
            note: `S4 mapping · confidence ${edge.confidence} · ${edge.rationale[0] ?? "scored edge"}`,
          });
          committed.push({ gap_id: edge.gap_id, tactic_id: edge.tactic_id });
        } catch (error) {
          ctx.run.note("commit:skipped", {
            edge: key(edge),
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    const toOut = (item: (typeof outcome.judged)[number]) => ({
      gap_id: item.candidate.gap_id,
      gap_name: item.candidate.gap_name,
      tactic_id: item.candidate.tactic_id,
      tactic_name: item.candidate.tactic_name,
      score: item.candidate.score,
      confidence: item.score,
      rationale: item.candidate.rationale,
      verdict: item.verdict,
    });
    const gapsWithEdge = new Set(outcome.accepted.map((edge) => edge.gap_id));
    const existingEdges = new Set(state.coverages.map(key));

    return {
      output: {
        mode: outcome.mode,
        proposed: outcome.proposed.length,
        accepted: outcome.judged.filter((item) => item.verdict === "accept").map(toOut),
        rejected: outcome.rejected.map(toOut),
        committed,
        graph: {
          gaps: gaps.length,
          tactics: tactics.length,
          edges: existingEdges.size + committed.length,
          gaps_with_no_edge: gaps.filter(
            (gap) =>
              !gapsWithEdge.has(gap.id) &&
              !state.coverages.some((coverage) => coverage.gap_id === gap.id),
          ).length,
        },
      },
      summary: `${outcome.accepted.length} of ${outcome.proposed.length} edge(s) accepted${
        input.dry_run ? " (dry run)" : `, ${committed.length} joined`
      }`,
      evals: [
        ...outcome.metrics,
        {
          name: "gap_coverage",
          value:
            gaps.length === 0
              ? 0
              : Number(
                  (
                    gaps.filter(
                      (gap) =>
                        gapsWithEdge.has(gap.id) ||
                        state.coverages.some((coverage) => coverage.gap_id === gap.id),
                    ).length / gaps.length
                  ).toFixed(3),
                ),
          unit: "ratio",
          target: 0.6,
        },
      ],
    };
  },
};

registerModule(kgMappingModule);

export async function listMappingCandidates(limit = 300) {
  await ensurePlatformSchema([MAPPING_CANDIDATES_DDL]);
  return db().select().from(mappingCandidates).orderBy(desc(mappingCandidates.created_at)).limit(limit);
}
