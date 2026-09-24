import { desc } from "drizzle-orm";
import { z } from "zod";
import { db, ensurePlatformSchema } from "@/modules/kernel/db";
import { newId, nowIso } from "@/modules/kernel/ids";
import { registerModule } from "@/modules/kernel/registry";
import { PROPOSER_CRITIC_EXCHANGES, runAgenticCycle, type Critique } from "@/modules/kernel/agentic";
import { completeAll, isTestStub, requireLlm } from "@/modules/kernel/llm";
import { NoRouteError } from "@/modules/llm/provider";
import type { ModuleContext, SynapseModule } from "@/modules/kernel/contracts";
import { assignTacticToGap, humanRejectedPairs, loadState } from "@/lib/iegp/store";
import { gapEligibleForMapping, tacticEligibleForMapping } from "@/lib/iegp/engine";
import { COVERAGE_DIMENSIONS, DIMENSION_VALUES, OVERALL_COVERAGE } from "@/lib/iegp/enums";
import { MAPPING_SCORE_FLOOR, scoreGapTacticMapping } from "@/lib/iegp/mapping";
import type { IegpState } from "@/lib/iegp/types";
import { MAPPING_CANDIDATES_DDL, mappingCandidates } from "./schema";

export const mappingStatusSchema = z.enum(["open", "addressed", "partially_addressed"]);
export type MappingStatus = z.infer<typeof mappingStatusSchema>;

const inputSchema = z.object({
  gap_ids: z.array(z.string()).optional(),
  tactic_ids: z.array(z.string()).optional(),
  /** Maximum tactics assigned per gap row. */
  max_per_gap: z.number().int().min(1).max(20).default(6),
  dry_run: z.boolean().default(false),
});

const coverageSchema = z.enum(OVERALL_COVERAGE);
const dimensionValueSchema = z.enum(DIMENSION_VALUES);
const dimensionsSchema = z.object(
  Object.fromEntries(COVERAGE_DIMENSIONS.map((dimension) => [dimension, dimensionValueSchema])) as Record<
    (typeof COVERAGE_DIMENSIONS)[number],
    typeof dimensionValueSchema
  >,
);

/** The model's verdict on one gap ↔ tactic pair. */
const tacticMappingSchema = z.object({
  tactic_id: z.string(),
  tactic_name: z.string(),
  /** How much of the gap this tactic covers, in the workspace coverage vocabulary. */
  coverage: coverageSchema,
  confidence: z.number(),
  rationale: z.string(),
  /** Per-dimension coverage; null when the model judged the tactic not relevant. */
  dimensions: dimensionsSchema.nullable(),
});

const reviewSchema = z.object({
  verdict: z.enum(["keep", "revise", "drop"]),
  confidence: z.number(),
  note: z.string(),
  mappings: z.array(z.object({ tactic_id: z.string(), verdict: z.enum(["keep", "revise", "drop"]), note: z.string() })),
});

const rowSchema = z.object({
  gap_id: z.string(),
  gap_name: z.string(),
  /** Tactics the model judged to bear on the gap (coverage other than not_relevant). */
  tactic_ids: z.array(z.string()),
  tactic_names: z.array(z.string()),
  /** The model's gap-level verdict. */
  mapping_status: mappingStatusSchema,
  confidence: z.number(),
  rationale: z.array(z.string()),
  /** One verdict per tactic the model assessed for this gap. */
  mappings: z.array(tacticMappingSchema),
  /** The model critic's last review of this row. */
  review: reviewSchema.nullable(),
  verdict: z.string().optional(),
  /** The model judge's reason for accepting or rejecting the row. */
  verdict_note: z.string().optional(),
});

const outputSchema = z.object({
  mode: z.enum(["llm", "deterministic"]),
  proposed: z.number(),
  rows: z.array(rowSchema),
  accepted: z.array(rowSchema),
  rejected: z.array(rowSchema),
  /** Rows the model critic dropped during the dialogue; they never reached the judge. */
  withdrawn: z.array(z.object({ gap_id: z.string(), note: z.string() })),
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
export type TacticMapping = z.infer<typeof tacticMappingSchema>;
export const mappingTableRowSchema = rowSchema;

type Row = Omit<MappingTableRow, "verdict" | "verdict_note">;
type Review = z.infer<typeof reviewSchema>;
type JudgeVerdict = { verdict: "accept" | "reject"; confidence: number; reason: string };

const DIMENSION_KEYS = COVERAGE_DIMENSIONS.join(", ");
const REMEDY = "run S4 again or switch the S4 route in /control.";

const MAPPING_TABLE_PROPOSER_SYSTEM = `You produce a gap ↔ tactic mapping TABLE for a pharma Integrated Evidence Generation Plan.

Each TABLE ROW is one evidence gap. For each gap you are given, decide which tactics bear on it and how much of it they cover:
- mappings: one entry per tactic you assessed for the gap. coverage is "full" (the tactic fully covers the gap), "partial" (covers some of it), "limited" (bears on it but thinly, e.g. population or endpoints too narrow) or "not_relevant" (you considered it and it does not apply). Each mapping needs a confidence (0-100), a one-sentence rationale naming what overlaps or is missing (population, comparator, outcome, timing), and, unless coverage is "not_relevant", a value for every dimension (${DIMENSION_KEYS}) of "yes", "partial", "no" or "unknown". For "not_relevant" set dimensions to null.
- mapping_status: "open" (no tactic bears on the gap), "addressed" (the tactics together fully close it) or "partially_addressed" (they cover part of it).
- confidence (0-100) and a one-sentence rationale for the row as a whole.

At most max_tactics_per_gap mappings per gap may have coverage other than "not_relevant". Do not map dissemination-only tactics unless the gap is about dissemination. Tactics already assigned to a gap are listed on it; judge them like any other. A gap may list human_rejected_tactic_ids: a reviewer rejected or removed those tactics for that gap, so never map them to it.

When a gap carries a previous row and a critic objection, answer the objection: change the mappings or status it names, or keep them and say why in the rationale.

Return a row for every gap you are given.

Return JSON only: {"rows":[{"gap_id":"","mapping_status":"open|addressed|partially_addressed","confidence":0,"rationale":"","mappings":[{"tactic_id":"","coverage":"full|partial|limited|not_relevant","confidence":0,"rationale":"","dimensions":{"relevance":"yes"}}]}]}`;

const MAPPING_CRITIC_SYSTEM = `You independently review a proposed gap ↔ tactic mapping table for a pharma Integrated Evidence Generation Plan.

For each row, judge whether each mapping's coverage and dimensions are defensible from the gap statement and the tactic's evidence question, population, comparator and outcomes; whether a tactic in the library that bears on the gap was left out; and whether the row's mapping_status follows from its mappings. Weigh any reviewer corrections.

verdict is "keep" when the row is right, "revise" when a mapping, a coverage value or the status should change, and "drop" when the row cannot be salvaged and should be withdrawn this run. confidence is 0-100 that the row is right. note names what should change and why; for "keep" say briefly why it holds. Give a verdict and note for every mapping in the row under mappings; a "keep" row has only "keep" mappings.

Review every row you are given.

Return JSON only: {"reviews":[{"gap_id":"","verdict":"keep|revise|drop","confidence":0,"note":"","mappings":[{"tactic_id":"","verdict":"keep|revise|drop","note":""}]}]}`;

const MAPPING_JUDGE_SYSTEM = `You are the final judge of a gap ↔ tactic mapping table for a pharma Integrated Evidence Generation Plan. Accepted rows are written into the workspace as tactic assignments that a human then reviews.

For each row, decide "accept" when its mappings, coverage values and status are defensible from the gap and tactic text, or "reject" when they are not. You see the critic's last review; a row marked revised_after_review changed after that review, so judge the row as it stands. confidence is 0-100 in your verdict. reason is one or two sentences.

Judge every row you are given.

Return JSON only: {"verdicts":[{"gap_id":"","verdict":"accept|reject","confidence":0,"reason":""}]}`;

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

type Gap = ReturnType<typeof candidateSets>["gaps"][number];
type TacticRow = ReturnType<typeof candidateSets>["tactics"][number];

const bearsOnGap = (mapping: TacticMapping) => mapping.coverage !== "not_relevant";

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Pairs S4 must leave alone: a person rejected or removed the tactic for the
 * gap. (A pair already assigned, including one whose coverage a person set, is
 * never rewritten: assignTacticToGap refuses an existing pair.)
 */
function blockedPairs(state: IegpState): Set<string> {
  return humanRejectedPairs(state);
}

const pairKey = (gap_id: string, tactic_id: string) => `${gap_id}::${tactic_id}`;

/**
 * Test stub only (SYNAPSE_TEST_STUB_LLM=1). Every row says no model ran, so a
 * stub mapping cannot pass for a judgement.
 */
function localTableRows(state: IegpState, input: MappingInput): Row[] {
  if (!isTestStub()) throw new NoRouteError("Mapping has no rule-based fallback.");
  const { gaps, tactics } = candidateSets(state, input);
  const covered = new Set(state.coverages.map((c) => pairKey(c.gap_id, c.tactic_id)));
  const blocked = blockedPairs(state);
  return gaps.map((gap) => {
    const scored = tactics
      .filter((tactic) => !covered.has(pairKey(gap.id, tactic.id)) && !blocked.has(pairKey(gap.id, tactic.id)))
      .map((tactic) => ({ tactic, result: scoreGapTacticMapping(gap, tactic, {}) }))
      .filter((item) => item.result.score >= MAPPING_SCORE_FLOOR)
      .sort((a, b) => b.result.score - a.result.score)
      .slice(0, input.max_per_gap);
    const mappings: TacticMapping[] = scored.map(({ tactic, result }) => ({
      tactic_id: tactic.id,
      tactic_name: tactic.name,
      coverage: "partial",
      confidence: 50,
      rationale: `Test stub: no model was called (${result.reasons.slice(0, 2).join("; ")}).`,
      dimensions: Object.fromEntries(COVERAGE_DIMENSIONS.map((dimension) => [dimension, "unknown"])) as TacticMapping["dimensions"],
    }));
    return {
      gap_id: gap.id,
      gap_name: gap.name,
      tactic_ids: mappings.map((mapping) => mapping.tactic_id),
      tactic_names: mappings.map((mapping) => mapping.tactic_name),
      mapping_status: mappings.length ? "partially_addressed" : "open",
      confidence: 50,
      rationale: ["Test stub: no model was called."],
      mappings,
      review: null,
    };
  });
}

type RawMapping = {
  tactic_id?: unknown;
  coverage?: unknown;
  confidence?: unknown;
  rationale?: unknown;
  dimensions?: unknown;
};

type RawRow = {
  gap_id?: unknown;
  mapping_status?: unknown;
  confidence?: unknown;
  rationale?: unknown;
  mappings?: unknown;
};

/**
 * Schema check of one model row. Anything missing, out of vocabulary or
 * inconsistent returns null so the row is asked for again; nothing is filled in.
 */
function parseProposedRow(
  raw: RawRow,
  gap: Gap,
  tactics: TacticRow[],
  maxPerGap: number,
  blocked: Set<string> = new Set(),
): Row | null {
  const status = mappingStatusSchema.safeParse(raw.mapping_status);
  if (!status.success) return null;
  if (!finiteNumber(raw.confidence)) return null;
  const rationale = typeof raw.rationale === "string" ? raw.rationale.trim() : "";
  if (!rationale) return null;
  if (!Array.isArray(raw.mappings)) return null;
  const mappings: TacticMapping[] = [];
  for (const item of raw.mappings as RawMapping[]) {
    const tactic = tactics.find((candidate) => candidate.id === item?.tactic_id);
    if (!tactic || mappings.some((mapping) => mapping.tactic_id === tactic.id)) return null;
    // A person rejected or removed this pair: it is left out, never proposed again.
    if (blocked.has(pairKey(gap.id, tactic.id))) continue;
    const coverage = coverageSchema.safeParse(item.coverage);
    if (!coverage.success || !finiteNumber(item.confidence)) return null;
    const note = typeof item.rationale === "string" ? item.rationale.trim() : "";
    if (!note) return null;
    let dimensions: TacticMapping["dimensions"] = null;
    if (coverage.data !== "not_relevant") {
      const parsed = dimensionsSchema.safeParse(item.dimensions);
      if (!parsed.success) return null;
      dimensions = parsed.data;
    }
    mappings.push({
      tactic_id: tactic.id,
      tactic_name: tactic.name,
      coverage: coverage.data,
      confidence: clampScore(item.confidence),
      rationale: note,
      dimensions,
    });
  }
  const bearing = mappings.filter(bearsOnGap);
  if (bearing.length > maxPerGap) return null;
  // The status must agree with the mappings the model gave: open means none bear on the gap.
  if ((status.data === "open") !== (bearing.length === 0)) return null;
  return {
    gap_id: gap.id,
    gap_name: gap.name,
    tactic_ids: bearing.map((mapping) => mapping.tactic_id),
    tactic_names: bearing.map((mapping) => mapping.tactic_name),
    mapping_status: status.data,
    confidence: clampScore(raw.confidence),
    rationale: [rationale],
    mappings,
    review: null,
  };
}

function promptTactics(tactics: TacticRow[]) {
  return tactics.map((tactic) => ({
    id: tactic.id,
    name: tactic.name,
    type: tactic.type,
    status: tactic.status,
    evidence_question: tactic.evidence_question,
    population: tactic.population,
    comparator: tactic.comparator,
    outcomes: tactic.outcomes,
  }));
}

function promptRow(row: Row) {
  return {
    mapping_status: row.mapping_status,
    confidence: row.confidence,
    rationale: row.rationale[0] ?? "",
    mappings: row.mappings.map((mapping) => ({
      tactic_id: mapping.tactic_id,
      coverage: mapping.coverage,
      confidence: mapping.confidence,
      rationale: mapping.rationale,
      dimensions: mapping.dimensions,
    })),
  };
}

function objectionOf(critique: Critique, review: Review | undefined): string {
  const mappingNotes = (review?.mappings ?? [])
    .filter((mapping) => mapping.verdict !== "keep")
    .map((mapping) => `${mapping.tactic_id} (${mapping.verdict}): ${mapping.note}`);
  return [critique.note, ...mappingNotes].join("\n");
}

type Shared = {
  ctx: ModuleContext;
  state: IegpState;
  input: MappingInput;
  gapById: Map<string, Gap>;
  tactics: TacticRow[];
  hints: string;
  /** Pairs a person rejected or removed. */
  blocked: Set<string>;
};

function rejectedFor(shared: Shared, gapId: string): string[] | undefined {
  const ids = shared.tactics.map((tactic) => tactic.id).filter((id) => shared.blocked.has(pairKey(gapId, id)));
  return ids.length ? ids : undefined;
}

function promptGap(shared: Shared, gapId: string) {
  const gap = shared.gapById.get(gapId)!;
  return {
    id: gap.id,
    name: gap.name,
    statement: gap.statement,
    domain: gap.domain,
    assigned_tactic_ids: shared.state.coverages.filter((c) => c.gap_id === gap.id).map((c) => c.tactic_id),
    human_rejected_tactic_ids: rejectedFor(shared, gap.id),
  };
}

async function llmProposals(
  shared: Shared,
  args: { gapIds: string[]; previous: Map<string, Row>; objections: Map<string, string>; retry: boolean },
): Promise<Map<string, Row>> {
  const payload = (await shared.ctx.complete({
    system: MAPPING_TABLE_PROPOSER_SYSTEM,
    user: JSON.stringify({
      reviewer_corrections: shared.hints || undefined,
      note: args.retry
        ? "An earlier answer left these gaps without a complete, valid row (missing fields, unknown tactic ids, values outside the vocabulary, too many tactics, or a status that does not match the mappings). Return a complete row for each."
        : undefined,
      gaps: args.gapIds.map((id) => {
        const previous = args.previous.get(id);
        return {
          ...promptGap(shared, id),
          previous: previous ? promptRow(previous) : undefined,
          objection: args.objections.get(id),
        };
      }),
      tactics: promptTactics(shared.tactics),
      max_tactics_per_gap: shared.input.max_per_gap,
    }),
    purpose: "mapping-table-proposer",
  })) as { rows?: RawRow[] } | null;
  const map = new Map<string, Row>();
  for (const raw of payload?.rows ?? []) {
    const gap = typeof raw?.gap_id === "string" ? shared.gapById.get(raw.gap_id) : undefined;
    if (!gap || !args.gapIds.includes(gap.id)) continue;
    const row = parseProposedRow(raw, gap, shared.tactics, shared.input.max_per_gap, shared.blocked);
    if (row) map.set(gap.id, row);
  }
  return map;
}

async function llmReviews(
  shared: Shared,
  args: { rows: Row[]; round: number; retry: boolean },
): Promise<Map<string, Review>> {
  const payload = (await shared.ctx.complete({
    system: MAPPING_CRITIC_SYSTEM,
    user: JSON.stringify({
      reviewer_corrections: shared.hints || undefined,
      exchange: `${args.round} of ${PROPOSER_CRITIC_EXCHANGES}`,
      note: args.retry
        ? "An earlier answer left these rows unreviewed or gave no verdict for some of their mappings. Review each row and every mapping in it."
        : undefined,
      rows: args.rows.map((row) => ({ gap: promptGap(shared, row.gap_id), ...promptRow(row) })),
      tactics: promptTactics(shared.tactics),
      max_tactics_per_gap: shared.input.max_per_gap,
    }),
    purpose: "mapping-table-critic",
  })) as {
    reviews?: {
      gap_id?: unknown;
      verdict?: unknown;
      confidence?: unknown;
      note?: unknown;
      mappings?: { tactic_id?: unknown; verdict?: unknown; note?: unknown }[];
    }[];
  } | null;
  const verdicts = reviewSchema.shape.verdict;
  const map = new Map<string, Review>();
  for (const raw of payload?.reviews ?? []) {
    const row = args.rows.find((candidate) => candidate.gap_id === raw?.gap_id);
    if (!row) continue;
    const verdict = verdicts.safeParse(raw.verdict);
    if (!verdict.success || !finiteNumber(raw.confidence)) continue;
    const note = typeof raw.note === "string" ? raw.note.trim() : "";
    if (!note) continue;
    const mappings: Review["mappings"] = [];
    let valid = Array.isArray(raw.mappings) || row.mappings.length === 0;
    for (const item of raw.mappings ?? []) {
      const mappingVerdict = verdicts.safeParse(item?.verdict);
      const mappingNote = typeof item?.note === "string" ? item.note.trim() : "";
      const known = row.mappings.some((mapping) => mapping.tactic_id === item?.tactic_id);
      if (!known || !mappingVerdict.success || !mappingNote) {
        valid = false;
        break;
      }
      mappings.push({ tactic_id: item.tactic_id as string, verdict: mappingVerdict.data, note: mappingNote });
    }
    // Every mapping in the row needs its own verdict, and a kept row cannot object to one.
    if (!valid || row.mappings.some((mapping) => !mappings.some((item) => item.tactic_id === mapping.tactic_id))) continue;
    if (verdict.data === "keep" && mappings.some((item) => item.verdict !== "keep")) continue;
    map.set(row.gap_id, { verdict: verdict.data, confidence: clampScore(raw.confidence), note, mappings });
  }
  return map;
}

async function llmVerdicts(
  shared: Shared,
  args: { rows: Row[]; revised: Set<string>; retry: boolean },
): Promise<Map<string, JudgeVerdict>> {
  const payload = (await shared.ctx.complete({
    system: MAPPING_JUDGE_SYSTEM,
    user: JSON.stringify({
      reviewer_corrections: shared.hints || undefined,
      note: args.retry ? "An earlier answer left these rows without a verdict. Judge each." : undefined,
      rows: args.rows.map((row) => ({
        gap: promptGap(shared, row.gap_id),
        ...promptRow(row),
        last_review: row.review ? { verdict: row.review.verdict, note: row.review.note, mappings: row.review.mappings } : undefined,
        revised_after_review: args.revised.has(row.gap_id),
      })),
      tactics: promptTactics(shared.tactics),
    }),
    purpose: "mapping-table-judge",
  })) as { verdicts?: { gap_id?: unknown; verdict?: unknown; confidence?: unknown; reason?: unknown }[] } | null;
  const map = new Map<string, JudgeVerdict>();
  for (const raw of payload?.verdicts ?? []) {
    if (typeof raw?.gap_id !== "string" || !args.rows.some((row) => row.gap_id === raw.gap_id)) continue;
    if (raw.verdict !== "accept" && raw.verdict !== "reject") continue;
    if (!finiteNumber(raw.confidence)) continue;
    const reason = typeof raw.reason === "string" ? raw.reason.trim() : "";
    if (!reason) continue;
    map.set(raw.gap_id, { verdict: raw.verdict, confidence: clampScore(raw.confidence), reason });
  }
  return map;
}

export const kgMappingModule: SynapseModule<MappingInput, MappingOutput> = {
  manifest: {
    id: "s4-kg-mapping.scored-pcj",
    stage: "S4",
    version: "3.0.0",
    title: "LLM mapping table (proposer ↔ critic ×3 → judge)",
    summary:
      "A model proposes one row per gap with a coverage verdict, confidence and rationale for each tactic; a model critic challenges each row over three exchanges and a model judge accepts or rejects it. Needs a connected LLM.",
    contract: 1,
    agentic: true,
    capabilities: ["mapping-table", "llm-proposer", "llm-critic", "llm-judge", "hillclimb-hints"],
  },
  inputSchema,
  outputSchema,
  migrations: [MAPPING_CANDIDATES_DDL],
  async run(input, ctx) {
    requireLlm(ctx, "Mapping");
    const state = await loadState();
    const { gaps, tactics } = candidateSets(state, input);
    const gapById = new Map(gaps.map((gap) => [gap.id, gap]));
    const describeGap = (id: string) => gapById.get(id)?.name ?? id;
    // The kernel hands reviewer corrections to the proposer; the critic and judge weigh them too.
    const shared: Shared = { ctx, state, input, gapById, tactics, hints: "", blocked: blockedPairs(state) };
    const reviewByGap = new Map<string, Review>();
    const judgeVerdicts = new Map<string, JudgeVerdict>();

    const outcome = await runAgenticCycle<Row>(ctx, "S4", {
      subjectOf,
      proposer: {
        local: ({ round, previous }) => (round === 1 ? localTableRows(state, input) : previous),
        llm: async ({ hints, round, critiques, previous }) => {
          shared.hints = hints;
          if (round === 1) {
            const ids = gaps.map((gap) => gap.id);
            const rows = await completeAll({
              ids,
              what: "mapping row",
              describe: describeGap,
              remedy: REMEDY,
              ask: (missing, attempt) =>
                llmProposals(shared, { gapIds: missing, previous: new Map(), objections: new Map(), retry: attempt > 1 }),
            });
            return ids.map((id) => rows.get(id)!);
          }
          // The critic is a model: its drops are conceded and its revisions answered.
          const dropped = new Set(critiques.filter((c) => c.verdict === "drop").map((c) => c.subject));
          const kept = previous
            .filter((row) => !dropped.has(row.gap_id))
            .map((row) => ({ ...row, review: reviewByGap.get(row.gap_id) ?? row.review }));
          const objections = new Map(
            critiques
              .filter((c) => c.verdict === "revise" && kept.some((row) => row.gap_id === c.subject))
              .map((c) => [c.subject, objectionOf(c, reviewByGap.get(c.subject))]),
          );
          let next = kept;
          if (objections.size > 0) {
            const byId = new Map(kept.map((row) => [row.gap_id, row]));
            const revisions = await completeAll({
              ids: [...objections.keys()],
              what: "mapping row",
              describe: describeGap,
              remedy: REMEDY,
              ask: (missing, attempt) =>
                llmProposals(shared, { gapIds: missing, previous: byId, objections, retry: attempt > 1 }),
            });
            next = kept.map((row) => {
              const revised = revisions.get(row.gap_id);
              return revised ? { ...revised, review: row.review } : row;
            });
          }
          // The kernel's judge step is synchronous, so the model judge rules on the
          // final rows here, right after the last revision, and the judge reads it.
          if (round === PROPOSER_CRITIC_EXCHANGES + 1 && next.length > 0) {
            const revised = new Set(objections.keys());
            const verdicts = await completeAll({
              ids: next.map((row) => row.gap_id),
              what: "judge verdict",
              describe: describeGap,
              remedy: REMEDY,
              ask: (missing, attempt) =>
                llmVerdicts(shared, {
                  rows: next.filter((row) => missing.includes(row.gap_id)),
                  revised,
                  retry: attempt > 1,
                }),
            });
            for (const [id, verdict] of verdicts) judgeVerdicts.set(id, verdict);
            ctx.run.note("judge:model", [...verdicts].map(([gap_id, verdict]) => ({ gap_id, ...verdict })));
          }
          return next;
        },
      },
      critic: async (rows, round) => {
        if (isTestStub()) {
          return rows.map((row) => ({
            subject: subjectOf(row),
            verdict: "keep" as const,
            note: "Test stub: no model critic was called.",
            score: 50,
          }));
        }
        const reviews = await completeAll({
          ids: rows.map(subjectOf),
          what: "review",
          describe: describeGap,
          remedy: REMEDY,
          ask: (missing, attempt) =>
            llmReviews(shared, { rows: rows.filter((row) => missing.includes(row.gap_id)), round, retry: attempt > 1 }),
        });
        return rows.map((row) => {
          const review = reviews.get(row.gap_id)!;
          reviewByGap.set(row.gap_id, review);
          return {
            subject: subjectOf(row),
            verdict: review.verdict,
            note: review.note,
            score: review.confidence,
            issues: review.mappings
              .filter((mapping) => mapping.verdict !== "keep")
              .map((mapping) => `${mapping.verdict}:${mapping.tactic_id}`),
          };
        });
      },
      /** Carries the model judge's verdict; no rule decides acceptance. */
      judge: ({ candidates }) =>
        candidates.map((row) => {
          if (isTestStub()) {
            return {
              candidate: row,
              subject: subjectOf(row),
              verdict: "accept" as const,
              score: 50,
              note: "Test stub: no model judge was called.",
            };
          }
          const verdict = judgeVerdicts.get(row.gap_id);
          if (!verdict) throw new Error(`The model judge gave no verdict for ${describeGap(row.gap_id)}.`);
          return {
            candidate: row,
            subject: subjectOf(row),
            verdict: verdict.verdict,
            score: verdict.confidence,
            note: verdict.reason,
          };
        }),
    });

    const created_at = nowIso();
    const rows = outcome.judged.flatMap((item) => {
      const base = {
        run_id: ctx.run.id,
        gap_id: item.candidate.gap_id,
        score: item.score,
        verdict: item.verdict,
        committed: false,
        proposer: outcome.mode,
        created_at,
      };
      const rowNote = [`status:${item.candidate.mapping_status}`, `row:${item.candidate.rationale[0] ?? ""}`, `judge:${item.note}`];
      if (item.candidate.mappings.length === 0) {
        return [{ ...base, id: newId("mc"), tactic_id: "", confidence: item.candidate.confidence, rationale: rowNote }];
      }
      return item.candidate.mappings.map((mapping) => ({
        ...base,
        id: newId("mc"),
        tactic_id: mapping.tactic_id,
        confidence: mapping.confidence,
        rationale: [mapping.rationale, `coverage:${mapping.coverage}`, ...rowNote],
      }));
    });
    if (rows.length > 0) await db().insert(mappingCandidates).values(rows);

    const committed: { gap_id: string; tactic_ids: string[] }[] = [];
    if (!input.dry_run) {
      for (const row of outcome.accepted) {
        const joined: string[] = [];
        for (const mapping of row.mappings.filter(bearsOnGap)) {
          if (shared.blocked.has(pairKey(row.gap_id, mapping.tactic_id))) continue;
          try {
            await assignTacticToGap({
              gap_id: row.gap_id,
              tactic_id: mapping.tactic_id,
              actor_name: ctx.actor.name,
              actor_function: ctx.actor.function,
              note: `S4 mapping table · ${row.mapping_status} · ${mapping.coverage} · ${mapping.rationale}`,
              // The model's verdict is the coverage; the store no longer invents one.
              coverage: mapping.coverage,
              dimensions: mapping.dimensions,
            });
            joined.push(mapping.tactic_id);
          } catch (error) {
            ctx.run.note("commit:skipped", {
              gap_id: row.gap_id,
              tactic_id: mapping.tactic_id,
              reason: error instanceof Error ? error.message : String(error),
            });
          }
        }
        if (joined.length > 0) committed.push({ gap_id: row.gap_id, tactic_ids: joined });
      }
    }

    const toOut = (item: (typeof outcome.judged)[number]): MappingTableRow => ({
      ...item.candidate,
      verdict: item.verdict,
      verdict_note: item.note,
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
        withdrawn: outcome.withdrawn.map((item) => ({ gap_id: item.subject, note: item.note })),
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
