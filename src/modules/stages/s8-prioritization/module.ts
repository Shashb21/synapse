import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { ensureCurrentSchemaTables } from "@/lib/iegp/db";
import { boolean, jsonb, pgTable, text } from "drizzle-orm/pg-core";
import { z } from "zod";
import { db, ensurePlatformSchema } from "@/modules/kernel/db";
import { nowIso } from "@/modules/kernel/ids";
import { registerModule } from "@/modules/kernel/registry";
import { PROPOSER_CRITIC_EXCHANGES, runAgenticCycle } from "@/modules/kernel/agentic";
import { completeAll, isTestStub, requireLlm } from "@/modules/kernel/llm";
import { NoRouteError } from "@/modules/llm/provider";
import { recordEdit } from "@/modules/kernel/edit-records";
import type { Actor, ModuleContext, SynapseModule } from "@/modules/kernel/contracts";
import { displayedGapStatus, isLiveGap } from "@/lib/iegp/engine";
import { enteredAssetDetails } from "@/lib/iegp/asset";
import { prioritizationContextFromState } from "@/lib/iegp/planning-context";
import { gaps } from "@/lib/iegp/schema";
import { loadState } from "@/lib/iegp/store";
import type { EvidenceGap, IegpState } from "@/lib/iegp/types";
import {
  loadAxes,
  quadrantBand,
  quadrantScore,
  scoreFromFavourability,
  type MatrixBand,
  type PriorityAxis,
  type StoredAxes,
} from "./axes";
import { plural } from "@/lib/plural";
import { captureBandDecision } from "@/lib/iegp/learning-capture";

/**
 * The kernel's `priority_placements` table plus the human markers S8 owns:
 * `human_axes` lists the axis ids a person set (by drag or by typing a score)
 * and `human_band` says the working band is a person's. A re-run never
 * overwrites either; the model only refreshes its own suggestion.
 */
const placementsTable = pgTable("priority_placements", {
  gap_id: text("gap_id").primaryKey(),
  run_id: text("run_id"),
  axis_scores: jsonb("axis_scores").notNull(),
  suggested_band: text("suggested_band").notNull(),
  suggested_rationale: text("suggested_rationale").notNull(),
  band: text("band"),
  validated: boolean("validated").notNull().default(false),
  needs_review: boolean("needs_review").notNull().default(false),
  review_reason: text("review_reason"),
  review_event_id: text("review_event_id"),
  rationale: text("rationale"),
  actor_name: text("actor_name"),
  actor_function: text("actor_function"),
  at: text("at").notNull(),
  human_axes: jsonb("human_axes").$type<string[]>().notNull().default([]),
  human_band: boolean("human_band").notNull().default(false),
});

/**
 * The placement columns (human_axes, human_band) are part of every workspace
 * schema's tables (workspace-tables.ts), created once per schema.
 */
async function ensurePlacementSchema() {
  await ensurePlatformSchema();
  await ensureCurrentSchemaTables();
  await db().execute(sql.raw("ALTER TABLE priority_placements ADD COLUMN IF NOT EXISTS run_id text"));
}

const humanAxesOf = (row: { human_axes: unknown } | undefined): string[] =>
  Array.isArray(row?.human_axes) ? (row.human_axes as unknown[]).map(String) : [];

const inputSchema = z.object({
  gap_ids: z.array(z.string()).optional(),
  /**
   * The two axes the user picked for this matrix. Only these are scored, and
   * the band is the quadrant they put the gap in. Without them every configured
   * axis is scored and the saved default pair decides the quadrant.
   */
  x_axis: z.string().optional(),
  y_axis: z.string().optional(),
  /** The treatment setting being prioritized, as context for the suggester. */
  setting: z.string().optional(),
  /** Leave gaps that already have scores on both plotted axes where they are. */
  only_missing: z.boolean().optional(),
  /** Asset and company context the suggestion should weigh. */
  context: z
    .object({
      key_decision: z.string().optional(),
      decision_date: z.string().optional(),
      competitor_pressure: z.string().optional(),
      launch_timeline: z.string().optional(),
      company_situation: z.string().optional(),
      lifecycle_stage: z.string().optional(),
      strategic_importance: z.number().min(1).max(5).optional(),
    })
    .optional(),
  dry_run: z.boolean().default(false),
});

const placementSchema = z.object({
  gap_id: z.string(),
  gap_name: z.string(),
  axis_scores: z.record(z.string(), z.number()),
  score: z.number(),
  suggested_band: z.enum(["high", "medium", "low", "defer"]),
  rationale: z.string(),
});

const outputSchema = z.object({
  mode: z.enum(["llm", "deterministic"]),
  axes: z.array(z.object({ id: z.string(), label: z.string(), weight: z.number() })),
  placements: z.array(placementSchema),
  skipped: z.number(),
});

export type PrioritizationInput = z.infer<typeof inputSchema>;
export type PrioritizationOutput = z.infer<typeof outputSchema>;

type Placement = z.infer<typeof placementSchema>;

const PRIORITY_SYSTEM = `You place open evidence gaps from a pharma Integrated Evidence Generation Plan on a two-axis prioritization matrix.

Score each given axis from 0 to 100 for each gap, where 0 is the axis's "low" end and 100 its "high" end, using the gap, the asset, treatment setting, company context, and any worked_examples of similar past reviewer decisions (examples, not rules). Score the axis as described — for a cost-style axis a high score means high cost. Do not assign the band yourself; the tool derives it from the quadrant and the user validates it. Keep each rationale to one or two sentences naming what drove the scores.

When a gap carries a previous placement and a critic objection, answer the objection: move the scores it names, or keep them and say why in the rationale.

Score every gap you are given on every axis you are given.

Return JSON only: {"gaps":[{"gap_id":"","scores":{"<axis_id>":0},"rationale":""}]}`;

const CRITIC_SYSTEM = `You review suggested placements of open evidence gaps on a two-axis prioritization matrix for a pharma Integrated Evidence Generation Plan.

For each gap, judge whether each axis score is defensible given the gap statement, the axis definition, the asset, treatment setting, company context and any worked_examples of similar past reviewer decisions (examples, not rules). Challenge scores that the gap text does not support or that ignore the context.

verdict is "keep" when the placement is defensible and "revise" when any score should move. A gap is never dropped. confidence is 0–100 that the placement is right. note names the axis, the direction it should move and why; for "keep" say briefly why it holds.

Review every gap you are given.

Return JSON only: {"reviews":[{"gap_id":"","verdict":"keep","confidence":0,"note":""}]}`;

const REMEDY = "run prioritization again or switch the S8 route in /admin/control.";

type PlanningContext = PrioritizationInput["context"] & {
  launch_timeline?: string;
  company_situation?: string;
  lifecycle_stage?: string;
  strategic_importance?: number;
};

type Suggestion = { scores: Record<string, number>; rationale: string };
type Review = { verdict: "keep" | "revise"; confidence: number; note: string };

type PromptGap = {
  id: string;
  name: string;
  statement: string;
  domain: string;
  previous?: { scores: Record<string, number>; rationale: string };
  objection?: string;
};

function promptContext(args: {
  asset: IegpState["asset"];
  setting?: string;
  context: PlanningContext;
  axes: PriorityAxis[];
  hints: string;
}) {
  return {
    worked_examples: args.hints || undefined,
    // Only what setup has entered: a blank plan sends no asset rather than empty strings.
    asset: enteredAssetDetails(args.asset),
    setting: args.setting || "All treatment settings",
    context: args.context,
    axes: args.axes.map((axis) => ({
      id: axis.id,
      label: axis.label,
      description: axis.description,
      low: axis.low_label,
      high: axis.high_label,
    })),
  };
}

async function llmScores(
  ctx: ModuleContext,
  args: Parameters<typeof promptContext>[0] & { gaps: PromptGap[]; retry: boolean },
): Promise<Map<string, Suggestion>> {
  const payload = (await ctx.complete({
    system: PRIORITY_SYSTEM,
    user: JSON.stringify({
      ...promptContext(args),
      note: args.retry
        ? "An earlier answer left these gaps unscored or without a rationale. Score every axis for each."
        : undefined,
      gaps: args.gaps,
    }),
    purpose: "priority-suggester",
  })) as {
    gaps?: { gap_id?: string; scores?: Record<string, unknown>; rationale?: string }[];
  };
  const map = new Map<string, Suggestion>();
  for (const row of payload?.gaps ?? []) {
    if (!row.gap_id) continue;
    const scores: Record<string, number> = {};
    for (const axis of args.axes) {
      const value = row.scores?.[axis.id];
      if (typeof value === "number" && Number.isFinite(value)) {
        scores[axis.id] = Math.max(0, Math.min(100, Math.round(value)));
      }
    }
    const rationale = (row.rationale ?? "").trim();
    // Incomplete rows are left out so the caller asks again for them.
    if (!rationale || args.axes.some((axis) => typeof scores[axis.id] !== "number")) continue;
    map.set(row.gap_id, { scores, rationale });
  }
  return map;
}

async function llmReviews(
  ctx: ModuleContext,
  args: Parameters<typeof promptContext>[0] & {
    round: number;
    placements: { gap_id: string; name: string; statement: string; domain: string; scores: Record<string, number>; rationale: string }[];
    retry: boolean;
  },
): Promise<Map<string, Review>> {
  const payload = (await ctx.complete({
    system: CRITIC_SYSTEM,
    user: JSON.stringify({
      ...promptContext(args),
      exchange: `${args.round} of ${PROPOSER_CRITIC_EXCHANGES}`,
      note: args.retry ? "An earlier answer left these gaps unreviewed. Review each." : undefined,
      placements: args.placements,
    }),
    purpose: "priority-critic",
  })) as {
    reviews?: { gap_id?: string; verdict?: string; confidence?: unknown; note?: string }[];
  };
  const map = new Map<string, Review>();
  for (const row of payload?.reviews ?? []) {
    if (!row.gap_id) continue;
    if (row.verdict !== "keep" && row.verdict !== "revise") continue;
    if (typeof row.confidence !== "number" || !Number.isFinite(row.confidence)) continue;
    const note = (row.note ?? "").trim();
    if (!note) continue;
    map.set(row.gap_id, {
      verdict: row.verdict,
      confidence: Math.max(0, Math.min(100, Math.round(row.confidence))),
      note,
    });
  }
  return map;
}

export const prioritizationModule: SynapseModule<PrioritizationInput, PrioritizationOutput> = {
  manifest: {
    id: "s8-prioritization.axes",
    stage: "S8",
    version: "2.0.0",
    title: "Prioritization on configurable axes",
    summary:
      "A model scores every open gap on the matrix axes and a model critic challenges each score over three exchanges; the band is the quadrant and the user validates it. Needs a connected LLM.",
    contract: 1,
    agentic: true,
    capabilities: ["configurable-axes", "llm-suggester", "llm-critic", "matrix-placement"],
  },
  inputSchema,
  outputSchema,
  freeze: freezeFacts,
  async run(input, ctx) {
    requireLlm(ctx, "Prioritization");
    const { state, axesConfig } = (ctx.replay?.facts as Awaited<ReturnType<typeof freezeFacts>> | undefined) ?? await freezeFacts(input);
    const axisById = (id: string | undefined) => axesConfig.axes.find((axis) => axis.id === id);
    const xAxis = axisById(input.x_axis) ?? axisById(axesConfig.x_axis) ?? axesConfig.axes[0]!;
    const yAxis =
      axisById(input.y_axis) ?? axisById(axesConfig.y_axis) ?? axesConfig.axes.find((axis) => axis !== xAxis)!;
    if (xAxis.id === yAxis.id) throw new Error("Pick two different axes for the matrix.");
    const pairOnly = Boolean(input.x_axis && input.y_axis);
    // A pair a person picked (in this run or saved), or only the catalog's
    // fallback? With no chosen pair the model still scores every axis, but its
    // quadrant on an unchosen pair never becomes the working band (KAN-16).
    const pairChosen = pairOnly || axesConfig.updated_by !== "default";
    const scoredAxes = pairOnly ? [xAxis, yAxis] : axesConfig.axes;
    const place = (scores: Record<string, number>) => ({
      score: quadrantScore({ xAxis, yAxis, scores }),
      suggested_band: quadrantBand({ xAxis, yAxis, scores }),
    });
    const planningContext: PlanningContext = { ...prioritizationContextFromState(state), ...input.context };
    const openGaps = state.gaps.filter(
      (gap) =>
        isLiveGap(gap) &&
        displayedGapStatus(gap) === "validated_open" &&
        (!input.gap_ids?.length || input.gap_ids.includes(gap.id)),
    );
    if (openGaps.length === 0) {
      return {
        output: {
          mode: isTestStub() ? "deterministic" : "llm",
          axes: scoredAxes.map((axis) => ({ id: axis.id, label: axis.label, weight: axis.weight })),
          placements: [],
          skipped: 0,
        },
        summary: "No open gaps to prioritize",
      };
    }

    const gapById = new Map(openGaps.map((gap) => [gap.id, gap]));
    const describeGap = (id: string) => gapById.get(id)?.name ?? id;
    // The kernel hands similar past reviewer decisions (worked examples, KAN-79) to the proposer; the critic sees them too.
    let reviewerHints = "";
    const shared = () => ({
      asset: state.asset,
      setting: input.setting,
      context: planningContext,
      axes: scoredAxes,
      hints: reviewerHints,
    });
    const toPlacement = (gapId: string, suggestion: Suggestion): Placement => ({
      gap_id: gapId,
      gap_name: describeGap(gapId),
      axis_scores: suggestion.scores,
      ...place(suggestion.scores),
      rationale: suggestion.rationale,
    });

    const outcome = await runAgenticCycle<Placement>(ctx, "S8", {
      subjectOf: (placement) => placement.gap_id,
      proposer: {
        /**
         * Test stub only: the kernel calls this when SYNAPSE_TEST_STUB_LLM is set
         * and never otherwise. Every axis sits at the midpoint and the rationale
         * says no model ran, so a stub placement cannot pass for a judgement.
         */
        local: ({ round, previous }) => {
          if (!isTestStub()) throw new NoRouteError("Prioritization has no rule-based fallback.");
          if (round > 1) return previous;
          return openGaps.map((gap) =>
            toPlacement(gap.id, {
              scores: Object.fromEntries(scoredAxes.map((axis) => [axis.id, 50])),
              rationale: "Test stub: no model was called.",
            }),
          );
        },
        llm: async ({ hints, round, critiques, previous }) => {
          reviewerHints = hints;
          const objections = new Map(
            critiques
              .filter((critique) => critique.verdict !== "keep")
              .map((critique) => [critique.subject, critique.note]),
          );
          // Revisions only re-score what the critic objected to.
          const targets = round === 1 ? openGaps.map((gap) => gap.id) : [...objections.keys()];
          if (round > 1 && targets.length === 0) return previous;
          const byId = new Map(previous.map((placement) => [placement.gap_id, placement]));
          const suggestions = await completeAll({
            ids: targets,
            what: "score",
            describe: describeGap,
            remedy: REMEDY,
            ask: (missing, attempt) =>
              llmScores(ctx, {
                ...shared(),
                retry: attempt > 1,
                gaps: missing.map((id) => {
                  const gap = gapById.get(id)!;
                  const before = byId.get(id);
                  return {
                    id,
                    name: gap.name,
                    statement: gap.statement,
                    domain: gap.domain,
                    previous: before ? { scores: before.axis_scores, rationale: before.rationale } : undefined,
                    objection: objections.get(id),
                  };
                }),
              }),
          });
          if (round === 1) return targets.map((id) => toPlacement(id, suggestions.get(id)!));
          return previous.map((placement) => {
            const revised = suggestions.get(placement.gap_id);
            return revised ? toPlacement(placement.gap_id, revised) : placement;
          });
        },
      },
      critic: async (placements, round) => {
        if (isTestStub()) {
          return placements.map((placement) => ({
            subject: placement.gap_id,
            verdict: "keep" as const,
            note: "Test stub: no model critic was called.",
            score: 50,
          }));
        }
        const reviews = await completeAll({
          ids: placements.map((placement) => placement.gap_id),
          what: "review",
          describe: describeGap,
          remedy: REMEDY,
          ask: (missing, attempt) =>
            llmReviews(ctx, {
              ...shared(),
              round,
              retry: attempt > 1,
              placements: placements
                .filter((placement) => missing.includes(placement.gap_id))
                .map((placement) => {
                  const gap = gapById.get(placement.gap_id)!;
                  return {
                    gap_id: placement.gap_id,
                    name: gap.name,
                    statement: gap.statement,
                    domain: gap.domain,
                    scores: placement.axis_scores,
                    rationale: placement.rationale,
                  };
                }),
            }),
        });
        return placements.map((placement) => {
          const review = reviews.get(placement.gap_id)!;
          return {
            subject: placement.gap_id,
            verdict: review.verdict,
            note: review.note,
            score: review.confidence,
          };
        });
      },
      /**
       * Every open gap needs a spot on the matrix, and the human who validates
       * the band is the judge. The judge only carries the critic's last
       * confidence and note forward; it does not filter.
       */
      judge: ({ candidates, critiques }) =>
        candidates.map((placement) => {
          const critique = critiques.find((item) => item.subject === placement.gap_id);
          return {
            candidate: placement,
            subject: placement.gap_id,
            verdict: "accept" as const,
            score: critique?.score ?? 0,
            note: critique?.note ?? "not reviewed",
          };
        }),
    }, { kinds: ["s8_band"], text: openGaps.map((gap) => `${gap.name} ${gap.statement}`).join(" ") });

    if (!ctx.replay?.evaluation && !input.dry_run) {
      await ensurePlacementSchema();
      for (const placement of outcome.accepted) {
        await db().transaction(async (tx) => {
          await tx.execute(sql`SELECT id FROM gaps WHERE id = ${placement.gap_id} FOR UPDATE`);
          const current = await currentPlacement(placement.gap_id);
          const currentScores = (current?.axis_scores as Record<string, number> | undefined) ?? {};
          const locked = Boolean(current?.validated || current?.needs_review);
          const humanAxes = humanAxesOf(current);
          const humanBand = current?.human_band ?? false;
          const placedAlready =
            typeof currentScores[xAxis.id] === "number" && typeof currentScores[yAxis.id] === "number";
          if (current && input.only_missing && placedAlready) return;
          // Once a human has validated a band, the suggestion they judged is kept:
          // losing it would erase the suggestion-versus-validation delta. A
          // validated gap only gains scores on axes it was never placed on, so it
          // has a spot on a matrix drawn on new axes. The new suggestion is still
          // in this run's output and trace.
          //
          // An unvalidated gap takes the new suggestion, except where a person
          // already put it: axes they set keep their score, and a band they set
          // stays the working band. The model's own suggested band and rationale
          // are refreshed either way, so the delta stays visible.
          const humanScores = Object.fromEntries(
            humanAxes.filter((id) => typeof currentScores[id] === "number").map((id) => [id, currentScores[id]!]),
          );
          const values = locked
            ? {
                gap_id: placement.gap_id,
                run_id: current?.run_id ?? null,
                axis_scores: { ...placement.axis_scores, ...currentScores },
                suggested_band: current!.suggested_band,
                suggested_rationale: current!.suggested_rationale,
                band: current!.band,
                validated: current!.validated,
                needs_review: current!.needs_review,
                review_reason: current!.review_reason,
                review_event_id: current!.review_event_id,
                rationale: current!.rationale,
                actor_name: current!.actor_name,
                actor_function: current!.actor_function,
                at: current!.at,
                human_axes: humanAxes,
                human_band: humanBand,
              }
            : {
                gap_id: placement.gap_id,
                run_id: ctx.run.id,
                axis_scores: { ...currentScores, ...placement.axis_scores, ...humanScores },
                suggested_band: placement.suggested_band,
                suggested_rationale: placement.rationale,
                // The working band: the quadrant until someone drags, sets or validates it.
                band:
                  humanBand && current?.band
                    ? current.band
                    : pairChosen
                      ? placement.suggested_band
                      : (current?.band ?? null),
                validated: false,
                rationale: humanBand ? (current?.rationale ?? null) : null,
                actor_name: humanBand ? (current?.actor_name ?? null) : null,
                actor_function: humanBand ? (current?.actor_function ?? null) : null,
                at: humanBand && current ? current.at : nowIso(),
                human_axes: humanAxes,
                human_band: humanBand && Boolean(current?.band),
              };
          await db()
            .insert(placementsTable)
            .values(values)
            .onConflictDoUpdate({ target: placementsTable.gap_id, set: values });
        });
      }
    }

    return {
      output: {
        mode: outcome.mode,
        axes: scoredAxes.map((axis) => ({ id: axis.id, label: axis.label, weight: axis.weight })),
        placements: outcome.accepted,
        skipped: outcome.rejected.length,
      },
      summary: `${plural(outcome.accepted.length, "open gap")} ${
        pairChosen
          ? `placed on ${xAxis.label} × ${yAxis.label}`
          : `scored on every axis; no axis pair was chosen, so no working band was set (suggestion shown on ${xAxis.label} × ${yAxis.label})`
      }${input.dry_run ? " (dry run)" : ""}`,
      evals: [
        ...outcome.metrics,
        {
          name: "high_share",
          value:
            outcome.accepted.length === 0
              ? 0
              : Number(
                  (
                    outcome.accepted.filter((placement) => placement.suggested_band === "high").length /
                    outcome.accepted.length
                  ).toFixed(3),
                ),
          unit: "ratio",
        },
      ],
    };
  },
  evals: {
    async reserveGold(facts, subject_ids) {
      const source = facts as Awaited<ReturnType<typeof freezeFacts>>;
      const gaps = source.state.gaps.filter(gap => subject_ids.includes(gap.id) && isLiveGap(gap) && displayedGapStatus(gap) === "validated_open");
      // S8 consumes asset/objective planning context and gap text only. Remove all
      // other subject collections so unrelated human answers cannot enter gold facts.
      const state = Object.fromEntries(Object.entries(source.state).map(([key, value]) =>
        [key, key === "gaps" ? gaps : key === "asset" || key === "objectives" ? value : Array.isArray(value) ? [] : value],
      )) as typeof source.state;
      const ids = gaps.map(gap => gap.id);
      return {
        facts: { state, axesConfig: structuredClone(source.axesConfig) }, subject_ids: ids,
        // Completeness/explanation ratios and band spread retain their definitions,
        // now measured only on the explicitly reserved open-gap subset.
        cases: ids.length ? [{ name: "heldout-open-list", input: { gap_ids: ids, dry_run: true } }] : [],
      };
    },
    async cases() {
      return [{ name: "open-list", input: { dry_run: true } }];
    },
    score({ output }) {
      const placements = output.placements;
      const complete = placements.filter(
        (placement) => output.axes.every((axis) => typeof placement.axis_scores[axis.id] === "number"),
      ).length;
      const explained = placements.filter((placement) => placement.rationale.trim().length > 0).length;
      return [
        {
          name: "axis_scores_complete",
          value: placements.length === 0 ? 0 : Number((complete / placements.length).toFixed(3)),
          unit: "ratio",
          target: 1,
        },
        {
          name: "suggestions_explained",
          value: placements.length === 0 ? 0 : Number((explained / placements.length).toFixed(3)),
          unit: "ratio",
          target: 1,
        },
        {
          name: "band_spread",
          value: new Set(placements.map((placement) => placement.suggested_band)).size,
          unit: "count",
        },
      ];
    },
  },
};

registerModule(prioritizationModule);

export type PlacementRecord = {
  gap_id: string;
  /** Opaque snapshot token; send null only for a previously unset judgement. */
  version: string;
  axis_scores: Record<string, number>;
  suggested_band: MatrixBand;
  /** Empty when no model has suggested a placement (a hand-placed gap). */
  suggested_rationale: string;
  /** "defer" is a deliberate, validated choice to leave the gap out of this cycle. */
  band: MatrixBand | null;
  validated: boolean;
  needs_review?: boolean;
  review_reason?: string | null;
  review_event_id?: string | null;
  rationale: string | null;
  actor_name: string | null;
  at: string;
  /** Axis ids a person set; a re-run keeps these scores. */
  human_axes?: string[];
  /** True when the working band is a person's; a re-run keeps it. */
  human_band?: boolean;
};

type Band = PlacementRecord["suggested_band"];
type PlacementRow = typeof placementsTable.$inferSelect;

function toRecord(row: PlacementRow): PlacementRecord {
  return {
    gap_id: row.gap_id,
    version: placementVersion(row),
    axis_scores: (row.axis_scores as Record<string, number>) ?? {},
    suggested_band: row.suggested_band as Band,
    suggested_rationale: row.suggested_rationale,
    band: (row.band as Band | null) ?? null,
    validated: row.validated,
    needs_review: row.needs_review,
    review_reason: row.review_reason,
    review_event_id: row.review_event_id,
    rationale: row.rationale,
    actor_name: row.actor_name,
    at: row.at,
    human_axes: humanAxesOf(row),
    human_band: row.human_band,
  };
}

export async function listPlacements(): Promise<PlacementRecord[]> {
  await ensurePlacementSchema();
  const rows = await db().select().from(placementsTable);
  return rows.map(toRecord);
}

/**
 * Puts a gap's validated band back to draft (KAN-75): its question changed, so the
 * band a person validated was for different wording. Scores, the band and any
 * human markers stay as they were; only the validation is withdrawn. Returns
 * whether there was a validated band to reset.
 */
export async function resetPlacementValidation(gapId: string): Promise<boolean> {
  await ensurePlacementSchema();
  const current = await currentPlacement(gapId);
  if (!current?.validated) return false;
  await db().update(placementsTable).set({ validated: false, at: nowIso() }).where(eq(placementsTable.gap_id, gapId));
  return true;
}

/**
 * Consequence of an audited context edit. Join its transaction, lock the same
 * gap as manual reviews/S8, and re-read its live status before withdrawing
 * confirmation. Gap statement/assignment edits reuse this owner.
 */
export async function requirePriorityContextReview(args: {
  gap_id: string; reason: string; actor: Actor; event_id: string;
}): Promise<boolean> {
  await ensurePlacementSchema();
  return db().transaction(async tx => {
    const [gap] = await tx.select().from(gaps).where(eq(gaps.id, args.gap_id)).for("update");
    if (!gap) return false;
    const context = {
      status: gap.status as EvidenceGap["status"], retired: gap.retired, parked_at: gap.parked_at,
      computed_status: gap.computed_status as EvidenceGap["computed_status"],
      status_override: gap.status_override as EvidenceGap["status_override"],
    };
    if (!isLiveGap(context) || displayedGapStatus(context) !== "validated_open") return false;
    // The audited context revision exists independently of a judgement. An
    // unplaced gap must reject an old first decision without creating a fake placement.
    await tx.update(gaps).set({ priority_context_version: args.event_id }).where(eq(gaps.id, args.gap_id));
    const [current] = await tx.select().from(placementsTable).where(eq(placementsTable.gap_id, args.gap_id)).for("update");
    if (!current) return false;
    const at = new Date(Math.max(Date.now(), Date.parse(current.at) + 1)).toISOString();
    await tx.update(placementsTable).set({
      validated: false, needs_review: true, review_reason: args.reason,
      review_event_id: args.event_id, at,
    }).where(eq(placementsTable.gap_id, args.gap_id));
    await recordEdit({
      stage: "S8", entity_type: "gap", entity_id: args.gap_id, field: "priority_context", action: "edit",
      before: current.validated ? "Priority confirmed" : current.needs_review ? "Needs priority review" : "Priority not confirmed",
      after: `Needs priority review · context change ${args.event_id}`,
      rationale: args.reason, actor: args.actor,
    }, tx);
    return true;
  });
}

/** Gaps whose band a person validated: a new source on one is flagged for a look (KAN-74). */
export async function validatedPlacementGapIds(): Promise<string[]> {
  return (await listPlacements()).filter((row) => row.validated).map((row) => row.gap_id);
}

/**
 * How far Prioritize has got: the Open gaps (the ones the matrix places) and
 * how many of them have a validated band. The same count the Prioritize
 * footer shows.
 */
export async function prioritizationProgress(state: IegpState): Promise<{ validated: number; open: number }> {
  const validated = new Set((await listPlacements()).filter((row) => row.validated).map((row) => row.gap_id));
  const open = state.gaps.filter((gap) => isLiveGap(gap) && displayedGapStatus(gap) === "validated_open");
  return { open: open.length, validated: open.filter((gap) => validated.has(gap.id)).length };
}

async function currentPlacement(gapId: string): Promise<PlacementRow | undefined> {
  const rows = await db().select().from(placementsTable).where(eq(placementsTable.gap_id, gapId)).limit(1);
  return rows[0];
}

/** A hand-placed gap must be a live Open gap, the same set S8 places. */
async function requireOpenGap(gapId: string) {
  const state = await loadState();
  const gap = state.gaps.find((row) => row.id === gapId);
  if (!gap || !isLiveGap(gap)) throw new Error(`Unknown gap ${gapId}.`);
  if (displayedGapStatus(gap) !== "validated_open") {
    throw new Error(`${gapId} is not an Open gap; only Open gaps are prioritized.`);
  }
  return gap;
}

/** A snapshot token also changes when a model supplies new scores on other axes. */
function placementVersion(row: PlacementRow): string {
  return createHash("sha256").update(JSON.stringify(Object.entries({
    ...row, axis_scores: Object.entries((row.axis_scores ?? {}) as Record<string, number>).sort(([a], [b]) => a.localeCompare(b)),
  }).sort(([a], [b]) => a.localeCompare(b)))).digest("hex");
}

type ManualDecision = {
  gap_id: string;
  actor: Actor;
  workspace_id?: string;
  /** Separate from the retained priority rationale. Required for every decision. */
  reason: string;
  expected_version: string | null;
  /** For a first decision, the gap's context snapshot. Null means context never changed. */
  expected_context_version?: string | null;
  /** Omit to retain the priority rationale; an explicit empty value clears it. */
  rationale?: string;
};

function requireDecisionReason(reason: string | undefined): string {
  const value = (reason ?? "").trim();
  if (value.length < 3) throw new Error("A meaningful reason is required for every priority decision.");
  return value;
}

/** The shared save owner for scores, overrides, drags and intentional reconfirmations. */
async function saveManualDecision(args: ManualDecision, decide: (current: PlacementRow | undefined) => {
  band: Band; axis_scores: Record<string, number>; human_axes: string[]; validated: boolean;
}, confirm: boolean): Promise<PlacementRecord> {
  const reason = requireDecisionReason(args.reason);
  await ensurePlacementSchema();
  const result = await db().transaction(async (tx) => {
    // Lock the gap even when it has no placement yet. S8 reruns use this same lock.
    await tx.execute(sql`SELECT id FROM gaps WHERE id = ${args.gap_id} FOR UPDATE`);
    const gap = await requireOpenGap(args.gap_id);
    const [current] = await tx.select().from(placementsTable).where(eq(placementsTable.gap_id, args.gap_id)).for("update");
    if (args.expected_version === undefined || args.expected_version !== (current ? placementVersion(current) : null)) {
      throw new Error("Priority changed or its version is missing. Your values and reason have not been saved. Close this dialog, refresh the page and review the latest priority, then retry with your reason.");
    }
    if (!current && (args.expected_context_version ?? null) !== (gap.priority_context_version ?? null)) {
      throw new Error("Priority context changed. Your values and reason have not been saved. Close this dialog, refresh the page and review the current context before making the first priority decision.");
    }
    const decision = decide(current);
    const rationale = args.rationale === undefined ? current?.rationale ?? null : args.rationale.trim() || null;
    // Saving the same scores/band/rationale is not a decision. Explicit confirmation always is.
    const sameScores = current && JSON.stringify(Object.entries(current.axis_scores as Record<string, number>).sort()) === JSON.stringify(Object.entries(decision.axis_scores).sort());
    if (!confirm && current && sameScores && current.band === decision.band && current.rationale === rationale && current.validated === decision.validated) {
      return { row: current, current, eventId: null };
    }
    const row: PlacementRow = {
      gap_id: args.gap_id, run_id: current?.run_id ?? null,
      suggested_band: current?.suggested_band ?? decision.band,
      suggested_rationale: current?.suggested_rationale ?? "",
      ...decision, rationale, human_band: true,
      needs_review: confirm ? false : current?.needs_review ?? false,
      review_reason: confirm ? null : current?.review_reason ?? null,
      review_event_id: confirm ? null : current?.review_event_id ?? null,
      actor_name: args.actor.name, actor_function: args.actor.function, at: nowIso(),
    };
    // Every intentional confirmation must change its concurrency token, even in the same millisecond.
    if (current && Date.parse(row.at) <= Date.parse(current.at)) row.at = new Date(Date.parse(current.at) + 1).toISOString();
    await tx.insert(placementsTable).values(row).onConflictDoUpdate({ target: placementsTable.gap_id, set: row });
    const snapshot = (value: PlacementRow) => JSON.stringify({
      band: value.band, axis_scores: value.axis_scores, rationale: value.rationale,
      confirmed: value.validated, suggested_band: value.suggested_band, suggested_rationale: value.suggested_rationale,
      actor_name: value.actor_name, actor_function: value.actor_function, at: value.at,
      human_axes: humanAxesOf(value), human_band: value.human_band, run_id: value.run_id,
    });
    const edit = await recordEdit({
      workspace_id: args.workspace_id, stage: "S8", entity_type: "gap", entity_id: args.gap_id,
      field: "placement", action: confirm ? "validate" : current ? "edit" : "add",
      before: current ? snapshot(current) : null, after: snapshot(row), rationale: reason, actor: args.actor,
    }, tx);
    return { row, current, eventId: edit.id };
  });
  if (confirm && result.eventId) {
    await captureValidatedBand(result.current, result.row.band as Band, reason, args.actor, result.eventId, args.workspace_id);
  }
  return toRecord(result.row);
}

/** Confirmation and reconfirmation retain the previous rationale unless explicitly edited. */
export async function validatePlacement(args: ManualDecision & { band: Band }): Promise<PlacementRecord> {
  return saveManualDecision(args, (current) => ({
    band: args.band, axis_scores: (current?.axis_scores as Record<string, number>) ?? {},
    human_axes: humanAxesOf(current), validated: true,
  }), true);
}

/** Both validation surfaces observe the same proven model origin and saved event. */
async function captureValidatedBand(current: PlacementRow | null | undefined, band: Band, rationale: string, actor: Actor, eventId: string, workspace_id?: string) {
  if (current?.suggested_band && current.run_id) {
    const gap = (await loadState().catch(() => null))?.gaps.find((candidate) => candidate.id === current.gap_id);
    if (gap) {
      await captureBandDecision({
        gap: { id: gap.id, name: gap.name, statement: gap.statement },
        run_id: current.run_id,
        capture_key: eventId,
        actor,
        suggested_band: current.suggested_band,
        suggested_rationale: current.suggested_rationale,
        band,
        rationale,
        workspace_id,
      });
    }
  }
}

/**
 * A person places a gap by hand, with no model run: typed axis scores (raw
 * 0–100 on each axis's own scale), a band, or both. With both plotted axes
 * scored and no band given, the band is the quadrant. The scores and band are
 * marked as the person's, so a later S8 run keeps them. `validate` also locks
 * the band, as the validate gate does; otherwise a validated gap keeps its
 * validation only while its band is unchanged.
 */
export async function setPlacement(args: ManualDecision & {
  axis_scores?: Record<string, number>; x_axis?: string; y_axis?: string; band?: Band; validate?: boolean;
}): Promise<PlacementRecord> {
  requireDecisionReason(args.reason);
  const axes = await loadAxes();
  const typed: Record<string, number> = {};
  for (const [id, value] of Object.entries(args.axis_scores ?? {})) {
    const axis = axes.axes.find((candidate) => candidate.id === id);
    if (!axis) throw new Error(`Unknown matrix axis ${id}.`);
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
      throw new Error(`${axis.label} score must be a number from 0 to 100.`);
    }
    typed[id] = Math.round(value);
  }
  const xAxis = args.x_axis ? axes.axes.find((axis) => axis.id === args.x_axis) : undefined;
  const yAxis = args.y_axis ? axes.axes.find((axis) => axis.id === args.y_axis) : undefined;
  if ((args.x_axis && !xAxis) || (args.y_axis && !yAxis)) throw new Error("Unknown matrix axis.");
  if (xAxis && yAxis && xAxis.id === yAxis.id) throw new Error("Pick two different axes for the matrix.");
  if (Object.keys(typed).length === 0 && !args.band) throw new Error("Give an axis score or a band to place the gap.");
  return saveManualDecision(args, (current) => {
    const axis_scores = { ...((current?.axis_scores as Record<string, number>) ?? {}), ...typed };
    const quadrant = xAxis && yAxis && typeof axis_scores[xAxis.id] === "number" && typeof axis_scores[yAxis.id] === "number"
      ? quadrantBand({ xAxis, yAxis, scores: axis_scores }) : null;
    const band = args.band ?? quadrant ?? ((current?.band ?? current?.suggested_band) as Band | null);
    if (!band) throw new Error("Give a band, or score both plotted axes so the quadrant sets it.");
    return { band, axis_scores, human_axes: [...new Set([...humanAxesOf(current), ...Object.keys(typed)])],
      validated: Boolean(args.validate) || Boolean(current?.validated && current.band === band) };
  }, Boolean(args.validate));
}

/** A drag is a reasoned score edit through the same audited owner as typed scores. */
export async function movePlacement(args: ManualDecision & {
  x_axis: string; y_axis: string; x: number; y: number;
}): Promise<PlacementRecord> {
  requireDecisionReason(args.reason);
  const axes = await loadAxes();
  const xAxis = axes.axes.find((axis) => axis.id === args.x_axis);
  const yAxis = axes.axes.find((axis) => axis.id === args.y_axis);
  if (!xAxis || !yAxis) throw new Error("Unknown matrix axis.");
  if (xAxis.id === yAxis.id) throw new Error("Pick two different axes for the matrix.");
  if (![args.x, args.y].every((value) => Number.isFinite(value) && value >= 0 && value <= 100)) {
    throw new Error("A matrix position needs two numbers from 0 to 100.");
  }
  return setPlacement({ ...args, axis_scores: {
    [xAxis.id]: scoreFromFavourability(xAxis, args.x), [yAxis.id]: scoreFromFavourability(yAxis, args.y),
  } });
}

export type { StoredAxes };

/** Freeze the source facts this stage consumes, before any proposal or human decision. */
async function freezeFacts(input: z.infer<typeof inputSchema>) {
  const [state, axesConfig] = await Promise.all([loadState(), loadAxes()]); return { state, axesConfig };
}
