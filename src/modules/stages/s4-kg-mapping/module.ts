import { desc } from "drizzle-orm";
import { z } from "zod";
import { db, ensurePlatformSchema } from "@/modules/kernel/db";
import { newId, nowIso } from "@/modules/kernel/ids";
import { registerModule } from "@/modules/kernel/registry";
import {
  PROPOSER_CRITIC_EXCHANGES,
  hasIssue,
  runAgenticCycle,
  type Critique,
} from "@/modules/kernel/agentic";
import { canPrompt } from "@/modules/kernel/routing";
import type { ModuleContext, SynapseModule } from "@/modules/kernel/contracts";
import { assignTacticToGap, loadState } from "@/lib/iegp/store";
import { gapEligibleForMapping, tacticEligibleForMapping } from "@/lib/iegp/engine";
import { MAPPING_SCORE_FLOOR, scoreGapTacticMapping } from "@/lib/iegp/mapping";
import type { IegpState } from "@/lib/iegp/types";
import { MAPPING_CANDIDATES_DDL, mappingCandidates } from "./schema";

const mappingStatusSchema = z.enum(["open", "addressed", "partially_addressed"]);

const inputSchema = z.object({
  gap_ids: z.array(z.string()).optional(),
  tactic_ids: z.array(z.string()).optional(),
  /** Maximum tactics assigned per gap row. */
  max_per_gap: z.number().int().min(1).max(20).default(6),
  dry_run: z.boolean().default(false),
});

const rowSchema = z.object({
  gap_id: z.string(),
  gap_name: z.string(),
  tactic_ids: z.array(z.string()),
  tactic_names: z.array(z.string()),
  mapping_status: mappingStatusSchema,
  confidence: z.number(),
  rationale: z.array(z.string()),
  verdict: z.string().optional(),
});

const outputSchema = z.object({
  mode: z.enum(["llm", "deterministic"]),
  proposed: z.number(),
  rows: z.array(rowSchema),
  accepted: z.array(rowSchema),
  rejected: z.array(rowSchema),
  committed: z.array(z.object({ gap_id: z.string(), tactic_ids: z.array(z.string()) })),
  table: z.object({
    gaps: z.number(),
    tactics: z.number(),
    rows_accepted: z.number(),
    gaps_still_open: z.number(),
  }),
});

export type MappingInput = z.infer<typeof inputSchema>;
export type MappingOutput = z.infer<typeof outputSchema>;
export type MappingTableRow = z.infer<typeof rowSchema>;

type Row = {
  gap_id: string;
  gap_name: string;
  tactic_ids: string[];
  tactic_names: string[];
  mapping_status: z.infer<typeof mappingStatusSchema>;
  confidence: number;
  rationale: string[];
};

const MAPPING_TABLE_PROPOSER_SYSTEM = `You produce a gap ↔ tactic mapping TABLE for an Integrated Evidence Generation Plan.

After gap and tactic extraction, each TABLE ROW is one evidence gap with:
- assigned tactic id(s) that bear on the gap (many-to-many across the table)
- mapping_status: "open" (no tactics), "addressed" (tactics fully close the gap), or "partially_addressed" (tactics cover part of the gap)

Do not map dissemination-only tactics unless the gap is about dissemination. Every row needs a one-sentence rationale naming what overlaps (population, comparator, outcome, timing). Confidence is 0-100.

Return JSON only: {"rows":[{"gap_id":"","tactic_ids":[],"mapping_status":"open|addressed|partially_addressed","confidence":0,"rationale":""}]}`;

function subjectOf(row: Row): string {
  return row.gap_id;
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

function statusFromEdges(edgeCount: number, topScore: number): Row["mapping_status"] {
  if (edgeCount === 0) return "open";
  if (topScore >= 75) return "addressed";
  return "partially_addressed";
}

/** Test-only stub when SYNAPSE_TEST_STUB_LLM=1; production runs use the LLM proposer only. */
function localTableRows(state: IegpState, input: MappingInput): Row[] {
  const { gaps, tactics } = candidateSets(state, input);
  const covered = new Set(state.coverages.map((c) => `${c.gap_id}::${c.tactic_id}`));
  const out: Row[] = [];
  for (const gap of gaps) {
    const scored = tactics
      .map((tactic) => {
        const pair = { gap_id: gap.id, tactic_id: tactic.id };
        if (covered.has(`${pair.gap_id}::${pair.tactic_id}`)) return null;
        const result = scoreGapTacticMapping(gap, tactic, {});
        if (result.score < MAPPING_SCORE_FLOOR) return null;
        return { tactic, score: result.score, reasons: result.reasons };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null)
      .sort((a, b) => b.score - a.score)
      .slice(0, input.max_per_gap);
    const mapping_status = statusFromEdges(scored.length, scored[0]?.score ?? 0);
    out.push({
      gap_id: gap.id,
      gap_name: gap.name,
      tactic_ids: scored.map((item) => item.tactic.id),
      tactic_names: scored.map((item) => item.tactic.name),
      mapping_status,
      confidence: scored.length ? Math.round(scored[0]!.score) : 0,
      rationale: scored.length
        ? scored.flatMap((item) => item.reasons).slice(0, 3)
        : ["No tactic clears the mapping floor for this gap."],
    });
  }
  return out;
}

async function llmTableRows(
  ctx: ModuleContext,
  state: IegpState,
  input: MappingInput,
  hints: string,
): Promise<Row[]> {
  const { gaps, tactics } = candidateSets(state, input);
  if (gaps.length === 0) return [];
  const payload = (await ctx.complete({
    system: MAPPING_TABLE_PROPOSER_SYSTEM,
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
      max_tactics_per_gap: input.max_per_gap,
    }),
    purpose: "mapping-table-proposer",
  })) as {
    rows?: {
      gap_id?: string;
      tactic_ids?: string[];
      mapping_status?: string;
      confidence?: number;
      rationale?: string;
    }[];
  };
  const out: Row[] = [];
  for (const raw of payload.rows ?? []) {
    const gap = gaps.find((candidate) => candidate.id === raw.gap_id);
    if (!gap) continue;
    const tactic_ids = (raw.tactic_ids ?? []).filter((id) => tactics.some((t) => t.id === id)).slice(0, input.max_per_gap);
    const mapping_status = mappingStatusSchema.safeParse(raw.mapping_status).success
      ? (raw.mapping_status as Row["mapping_status"])
      : statusFromEdges(tactic_ids.length, raw.confidence ?? 50);
    const tactic_names = tactic_ids.map((id) => tactics.find((t) => t.id === id)?.name ?? id);
    out.push({
      gap_id: gap.id,
      gap_name: gap.name,
      tactic_ids,
      tactic_names,
      mapping_status,
      confidence: Math.max(0, Math.min(100, Math.round(raw.confidence ?? 50))),
      rationale: [(raw.rationale ?? "").trim() || "Model proposed this row", ...tactic_names.map((n) => `Tactic: ${n}`)],
    });
  }
  for (const gap of gaps) {
    if (!out.some((row) => row.gap_id === gap.id)) {
      out.push({
        gap_id: gap.id,
        gap_name: gap.name,
        tactic_ids: [],
        tactic_names: [],
        mapping_status: "open",
        confidence: 0,
        rationale: ["No row returned for this gap; treating as open."],
      });
    }
  }
  return out;
}

function reviseRows(args: { previous: Row[]; critiques: Critique[]; maxPerGap: number }): Row[] {
  return args.previous
    .filter((row) => {
      const critique = args.critiques.find((item) => item.subject === subjectOf(row));
      if (critique?.verdict === "drop") return false;
      if (hasIssue(critique, "no_rationale")) return false;
      if (hasIssue(critique, "status_mismatch")) return false;
      return true;
    })
    .map((row) => {
      const critique = args.critiques.find((item) => item.subject === subjectOf(row));
      if (critique?.verdict !== "revise") return row;
      const trimmed = row.tactic_ids.slice(0, args.maxPerGap);
      return {
        ...row,
        tactic_ids: trimmed,
        tactic_names: row.tactic_names.slice(0, trimmed.length),
        mapping_status:
          trimmed.length === 0
            ? "open"
            : row.mapping_status === "open" && trimmed.length > 0
              ? "partially_addressed"
              : row.mapping_status,
        rationale: [...row.rationale, `Revised after critique: ${critique.note}`],
      };
    });
}

function mappingRevisionBrief(args: { round: number; critiques: Critique[] }): string {
  const objections = args.critiques.filter((critique) => critique.verdict !== "keep");
  if (objections.length === 0) {
    return `Exchange ${args.round} of ${PROPOSER_CRITIC_EXCHANGES}: every row was kept. Sharpen rationales only.`;
  }
  return [
    `Exchange ${args.round} of ${PROPOSER_CRITIC_EXCHANGES}. The critic objected to these rows. Fix status/tactic assignments or withdraw rows you cannot justify:`,
    ...objections.map(
      (critique) => `- ${critique.subject} (${critique.verdict}, ${critique.score}/100): ${critique.note}`,
    ),
  ].join("\n");
}

function statusMatchesTactics(row: Row): boolean {
  if (row.tactic_ids.length === 0) return row.mapping_status === "open";
  if (row.mapping_status === "open") return false;
  return true;
}

export const kgMappingModule: SynapseModule<MappingInput, MappingOutput> = {
  manifest: {
    id: "s4-kg-mapping.scored-pcj",
    stage: "S4",
    version: "2.0.0",
    title: "LLM mapping table (proposer ↔ critic ×3 → judge)",
    summary:
      "Proposes one table row per gap with assigned tactics and mapping status; user accepts or edits rows with rationale for hillclimb.",
    contract: 1,
    agentic: true,
    capabilities: ["mapping-table", "llm-proposer", "hillclimb-hints"],
  },
  inputSchema,
  outputSchema,
  migrations: [MAPPING_CANDIDATES_DDL],
  async run(input, ctx) {
    const state = await loadState();
    const { gaps, tactics } = candidateSets(state, input);

    const outcome = await runAgenticCycle<Row>(ctx, "S4", {
      subjectOf,
      proposer: {
        local: ({ round, previous, critiques }) =>
          round === 1
            ? localTableRows(state, input)
            : reviseRows({ previous, critiques, maxPerGap: input.max_per_gap }),
        llm: canPrompt(ctx.route)
          ? ({ hints, round, critiques }) =>
              llmTableRows(
                ctx,
                state,
                input,
                round === 1
                  ? hints
                  : [hints, mappingRevisionBrief({ round, critiques })].filter(Boolean).join("\n\n"),
              )
          : undefined,
      },
      critic: (rows) =>
        rows.map((row) => {
          const notes: string[] = [];
          const issues: string[] = [];
          if (row.rationale.length === 0 || !row.rationale[0]?.trim()) {
            notes.push("no rationale");
            issues.push("no_rationale");
          }
          if (row.tactic_ids.length > input.max_per_gap) {
            notes.push("too many tactics on this row");
            issues.push("over_budget");
          }
          if (!statusMatchesTactics(row)) {
            notes.push("mapping_status does not match tactic assignment");
            issues.push("status_mismatch");
          }
          if (row.confidence < 35 && row.tactic_ids.length > 0) {
            notes.push("low confidence");
            issues.push("low_confidence");
          }
          const blended = row.confidence;
          return {
            subject: subjectOf(row),
            verdict: blended >= 60 && issues.length === 0 ? ("keep" as const) : blended >= 40 ? ("revise" as const) : ("drop" as const),
            note: notes.length ? notes.join("; ") : row.rationale.slice(0, 2).join("; "),
            score: blended,
            issues,
          };
        }),
      judge: ({ candidates, critiques }) =>
        candidates.map((row) => {
          const critique = critiques.find((item) => item.subject === subjectOf(row));
          const score = critique?.score ?? row.confidence;
          const accept =
            critique?.verdict !== "drop" &&
            score >= 45 &&
            !hasIssue(critique, "status_mismatch") &&
            row.tactic_ids.length <= input.max_per_gap;
          return {
            candidate: row,
            subject: subjectOf(row),
            verdict: accept ? ("accept" as const) : ("reject" as const),
            score,
            note: critique?.note ?? "no critique",
          };
        }),
    });

    const rows = outcome.judged.map((item) => ({
      id: newId("mc"),
      run_id: ctx.run.id,
      gap_id: item.candidate.gap_id,
      tactic_id: item.candidate.tactic_ids[0] ?? "",
      score: item.score,
      confidence: item.candidate.confidence,
      rationale: [...item.candidate.rationale, `status:${item.candidate.mapping_status}`, `tactics:${item.candidate.tactic_ids.join(",")}`],
      verdict: item.verdict,
      committed: false,
      proposer: outcome.mode,
      created_at: nowIso(),
    }));
    if (rows.length > 0) await db().insert(mappingCandidates).values(rows);

    const committed: { gap_id: string; tactic_ids: string[] }[] = [];
    if (!input.dry_run) {
      for (const row of outcome.accepted) {
        const joined: string[] = [];
        for (const tactic_id of row.tactic_ids) {
          try {
            await assignTacticToGap({
              gap_id: row.gap_id,
              tactic_id,
              actor_name: ctx.actor.name,
              actor_function: ctx.actor.function,
              note: `S4 mapping table · ${row.mapping_status} · ${row.rationale[0] ?? "LLM row"}`,
            });
            joined.push(tactic_id);
          } catch (error) {
            ctx.run.note("commit:skipped", {
              gap_id: row.gap_id,
              tactic_id,
              reason: error instanceof Error ? error.message : String(error),
            });
          }
        }
        if (joined.length > 0) committed.push({ gap_id: row.gap_id, tactic_ids: joined });
      }
    }

    const toOut = (item: (typeof outcome.judged)[number]): MappingTableRow => ({
      gap_id: item.candidate.gap_id,
      gap_name: item.candidate.gap_name,
      tactic_ids: item.candidate.tactic_ids,
      tactic_names: item.candidate.tactic_names,
      mapping_status: item.candidate.mapping_status,
      confidence: item.candidate.confidence,
      rationale: item.candidate.rationale,
      verdict: item.verdict,
    });

    const acceptedRows = outcome.judged.filter((item) => item.verdict === "accept").map(toOut);
    const gapsWithTactics = new Set(
      acceptedRows.filter((row) => row.tactic_ids.length > 0).map((row) => row.gap_id),
    );

    return {
      output: {
        mode: outcome.mode,
        proposed: outcome.proposed.length,
        rows: outcome.judged.map(toOut),
        accepted: acceptedRows,
        rejected: outcome.rejected.map(toOut),
        committed,
        table: {
          gaps: gaps.length,
          tactics: tactics.length,
          rows_accepted: acceptedRows.length,
          gaps_still_open: gaps.filter(
            (gap) =>
              !gapsWithTactics.has(gap.id) && !state.coverages.some((coverage) => coverage.gap_id === gap.id),
          ).length,
        },
      },
      summary: `${acceptedRows.length} of ${outcome.proposed.length} mapping row(s) accepted${
        input.dry_run ? " (dry run)" : `, ${committed.length} gap row(s) joined`
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
                        gapsWithTactics.has(gap.id) ||
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
  evals: {
    async cases() {
      return [{ name: "workspace", input: { max_per_gap: 6, dry_run: true } }];
    },
    score({ output }) {
      const withRationale = output.accepted.filter((row) => row.rationale.length > 0).length;
      if (output.accepted.length === 0) {
        return [
          { name: "rows_with_rationale", value: 0, unit: "ratio", detail: "no new rows" },
          { name: "selectivity", value: 0, unit: "ratio", detail: "no new rows" },
          { name: "gaps_left_unmapped", value: output.table.gaps_still_open, unit: "count" },
        ];
      }
      const judged = output.accepted.length + output.rejected.length;
      return [
        {
          name: "rows_with_rationale",
          value: Number((withRationale / output.accepted.length).toFixed(3)),
          unit: "ratio",
          target: 1,
        },
        {
          name: "selectivity",
          value: judged === 0 ? 0 : Number((output.accepted.length / judged).toFixed(3)),
          unit: "ratio",
        },
        {
          name: "gaps_left_unmapped",
          value: output.table.gaps_still_open,
          unit: "count",
        },
      ];
    },
  },
};

registerModule(kgMappingModule);

export async function listMappingCandidates(limit = 300) {
  await ensurePlatformSchema([MAPPING_CANDIDATES_DDL]);
  return db().select().from(mappingCandidates).orderBy(desc(mappingCandidates.created_at)).limit(limit);
}
