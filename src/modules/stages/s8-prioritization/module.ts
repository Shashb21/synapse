import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, ensurePlatformSchema } from "@/modules/kernel/db";
import * as t from "@/modules/kernel/schema";
import { nowIso } from "@/modules/kernel/ids";
import { registerModule } from "@/modules/kernel/registry";
import { PROPOSER_CRITIC_EXCHANGES, runAgenticCycle } from "@/modules/kernel/agentic";
import { canPrompt } from "@/modules/kernel/routing";
import { NoRouteError } from "@/modules/llm/provider";
import { recordEdit, requireRationale } from "@/modules/kernel/edit-records";
import type { Actor, ModuleContext, SynapseModule } from "@/modules/kernel/contracts";
import { displayedGapStatus, isLiveGap } from "@/lib/iegp/engine";
import { prioritizationContextFromState } from "@/lib/iegp/planning-context";
import { loadState, lockPriority } from "@/lib/iegp/store";
import type { IegpState } from "@/lib/iegp/types";
import {
  loadAxes,
  quadrantBand,
  quadrantScore,
  scoreFromFavourability,
  type PriorityAxis,
  type StoredAxes,
} from "./axes";

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
  suggested_band: z.enum(["high", "medium", "low"]),
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

Score each given axis from 0 to 100 for each gap, where 0 is the axis's "low" end and 100 its "high" end, using the gap, the asset, treatment setting, company context and any reviewer corrections. Score the axis as described — for a cost-style axis a high score means high cost. Do not assign the band yourself; the tool derives it from the quadrant and the user validates it. Keep each rationale to one or two sentences naming what drove the scores.

When a gap carries a previous placement and a critic objection, answer the objection: move the scores it names, or keep them and say why in the rationale.

Score every gap you are given on every axis you are given.

Return JSON only: {"gaps":[{"gap_id":"","scores":{"<axis_id>":0},"rationale":""}]}`;

const CRITIC_SYSTEM = `You review suggested placements of open evidence gaps on a two-axis prioritization matrix for a pharma Integrated Evidence Generation Plan.

For each gap, judge whether each axis score is defensible given the gap statement, the axis definition, the asset, treatment setting, company context and any reviewer corrections. Challenge scores that the gap text does not support, that ignore the context, or that contradict a reviewer correction.

verdict is "keep" when the placement is defensible and "revise" when any score should move. A gap is never dropped. confidence is 0–100 that the placement is right. note names the axis, the direction it should move and why; for "keep" say briefly why it holds.

Review every gap you are given.

Return JSON only: {"reviews":[{"gap_id":"","verdict":"keep","confidence":0,"note":""}]}`;

/** Re-asks for rows a model left out before the stage gives up. */
const COMPLETION_ATTEMPTS = 3;

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

/**
 * Asks the model once per attempt for the rows still missing, and keeps what
 * each answer completes. A row the model never completes fails the stage:
 * nothing is filled in on its behalf.
 */
async function completeAll<T>(args: {
  ids: string[];
  what: string;
  ask: (missing: string[], attempt: number) => Promise<Map<string, T>>;
  describe: (id: string) => string;
}): Promise<Map<string, T>> {
  const done = new Map<string, T>();
  for (let attempt = 1; attempt <= COMPLETION_ATTEMPTS; attempt += 1) {
    const missing = args.ids.filter((id) => !done.has(id));
    if (missing.length === 0) break;
    const answer = await args.ask(missing, attempt);
    for (const id of missing) {
      const row = answer.get(id);
      if (row !== undefined) done.set(id, row);
    }
  }
  const unanswered = args.ids.filter((id) => !done.has(id));
  if (unanswered.length > 0) {
    throw new Error(
      `The model did not return a complete ${args.what} for ${unanswered
        .map(args.describe)
        .join(", ")} after ${COMPLETION_ATTEMPTS} attempts. Nothing was saved; run prioritization again or switch the S8 route in /control.`,
    );
  }
  return done;
}

function promptContext(args: {
  asset: IegpState["asset"];
  setting?: string;
  context: PlanningContext;
  axes: PriorityAxis[];
  hints: string;
}) {
  return {
    reviewer_corrections: args.hints || undefined,
    asset: {
      name: args.asset.name,
      inn: args.asset.inn,
      indication: args.asset.indication,
      geography: args.asset.geography,
    },
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

/** Vitest and Playwright only: the kernel runs the local proposer instead of a model. */
function testStub(): boolean {
  return process.env.SYNAPSE_TEST_STUB_LLM === "1";
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
  async run(input, ctx) {
    if (!testStub() && !canPrompt(ctx.route)) {
      throw new NoRouteError(
        ctx.route.reason ??
          "Prioritization needs a connected LLM. Log in at /control (Grok, Claude, or another provider) and run it again.",
      );
    }
    const [state, axesConfig] = await Promise.all([loadState(), loadAxes()]);
    const axisById = (id: string | undefined) => axesConfig.axes.find((axis) => axis.id === id);
    const xAxis = axisById(input.x_axis) ?? axisById(axesConfig.x_axis) ?? axesConfig.axes[0]!;
    const yAxis =
      axisById(input.y_axis) ?? axisById(axesConfig.y_axis) ?? axesConfig.axes.find((axis) => axis !== xAxis)!;
    if (xAxis.id === yAxis.id) throw new Error("Pick two different axes for the matrix.");
    const pairOnly = Boolean(input.x_axis && input.y_axis);
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
          mode: testStub() ? "deterministic" : "llm",
          axes: scoredAxes.map((axis) => ({ id: axis.id, label: axis.label, weight: axis.weight })),
          placements: [],
          skipped: 0,
        },
        summary: "No open gaps to prioritize",
      };
    }

    const gapById = new Map(openGaps.map((gap) => [gap.id, gap]));
    const describeGap = (id: string) => gapById.get(id)?.name ?? id;
    // The kernel hands reviewer corrections to the proposer; the critic weighs them too.
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
          if (!testStub()) throw new NoRouteError("Prioritization has no rule-based fallback.");
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
        if (testStub()) {
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
    });

    if (!input.dry_run) {
      const existing = await db().select().from(t.priorityPlacements);
      for (const placement of outcome.accepted) {
        const current = existing.find((row) => row.gap_id === placement.gap_id);
        const currentScores = (current?.axis_scores as Record<string, number> | undefined) ?? {};
        const locked = current?.validated ?? false;
        const placedAlready =
          typeof currentScores[xAxis.id] === "number" && typeof currentScores[yAxis.id] === "number";
        if (current && input.only_missing && placedAlready) continue;
        // Once a human has validated a band, the suggestion they judged is kept:
        // losing it would erase the suggestion-versus-validation delta. A
        // validated gap only gains scores on axes it was never placed on, so it
        // has a spot on a matrix drawn on new axes. The new suggestion is still
        // in this run's output and trace.
        const values = locked
          ? {
              gap_id: placement.gap_id,
              axis_scores: { ...placement.axis_scores, ...currentScores },
              suggested_band: current!.suggested_band,
              suggested_rationale: current!.suggested_rationale,
              band: current!.band,
              validated: true,
              rationale: current!.rationale,
              actor_name: current!.actor_name,
              actor_function: current!.actor_function,
              at: current!.at,
            }
          : {
              gap_id: placement.gap_id,
              axis_scores: { ...currentScores, ...placement.axis_scores },
              suggested_band: placement.suggested_band,
              suggested_rationale: placement.rationale,
              // The working band: the quadrant until someone drags or validates it.
              band: placement.suggested_band,
              validated: false,
              rationale: null,
              actor_name: null,
              actor_function: null,
              at: nowIso(),
            };
        await db()
          .insert(t.priorityPlacements)
          .values(values)
          .onConflictDoUpdate({ target: t.priorityPlacements.gap_id, set: values });
      }
    }

    return {
      output: {
        mode: outcome.mode,
        axes: scoredAxes.map((axis) => ({ id: axis.id, label: axis.label, weight: axis.weight })),
        placements: outcome.accepted,
        skipped: outcome.rejected.length,
      },
      summary: `${outcome.accepted.length} open gap(s) placed on ${xAxis.label} × ${yAxis.label}${
        input.dry_run ? " (dry run)" : ""
      }`,
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
  axis_scores: Record<string, number>;
  suggested_band: "high" | "medium" | "low";
  suggested_rationale: string;
  band: "high" | "medium" | "low" | null;
  validated: boolean;
  rationale: string | null;
  actor_name: string | null;
  at: string;
};

export async function listPlacements(): Promise<PlacementRecord[]> {
  await ensurePlatformSchema();
  const rows = await db().select().from(t.priorityPlacements);
  return rows.map((row) => ({
    gap_id: row.gap_id,
    axis_scores: (row.axis_scores as Record<string, number>) ?? {},
    suggested_band: row.suggested_band as PlacementRecord["suggested_band"],
    suggested_rationale: row.suggested_rationale,
    band: (row.band as PlacementRecord["band"]) ?? null,
    validated: row.validated,
    rationale: row.rationale,
    actor_name: row.actor_name,
    at: row.at,
  }));
}

/**
 * The S8 human gate: the user accepts or changes the suggested band with a
 * rationale, which is both the audit record and a hillclimb signal.
 */
export async function validatePlacement(args: {
  gap_id: string;
  band: "high" | "medium" | "low";
  rationale: string;
  actor: Actor;
  workspace_id?: string;
}): Promise<PlacementRecord> {
  await ensurePlatformSchema();
  // Rationale first: a band must not move before the reason for it is known good.
  const rationale = requireRationale(args.rationale);
  const rows = await db()
    .select()
    .from(t.priorityPlacements)
    .where(eq(t.priorityPlacements.gap_id, args.gap_id))
    .limit(1);
  const current = rows[0];
  if (!current) throw new Error(`${args.gap_id} has no suggested placement yet. Run S8 first.`);
  const values = {
    band: args.band,
    validated: true,
    rationale,
    actor_name: args.actor.name,
    actor_function: args.actor.function,
    at: nowIso(),
  };
  await db().update(t.priorityPlacements).set(values).where(eq(t.priorityPlacements.gap_id, args.gap_id));
  await recordEdit({
    workspace_id: args.workspace_id,
    stage: "S8",
    entity_type: "gap",
    entity_id: args.gap_id,
    field: "priority_band",
    action: current.suggested_band === args.band ? "accept" : "edit",
    before: current.suggested_band,
    after: args.band,
    rationale,
    actor: args.actor,
  });
  // Keep the legacy residual-keyed board in step when the gap has a residual.
  const state = await loadState();
  const residual = state.residuals.find((row) => row.gap_id === args.gap_id);
  if (residual) {
    try {
      await lockPriority({
        residual_id: residual.id,
        band: args.band,
        override_reason: rationale,
        actor_name: args.actor.name,
        actor_function: args.actor.function,
      });
    } catch {
      // The legacy board is a mirror; a mismatch there must not fail validation.
    }
  }
  return {
    gap_id: args.gap_id,
    axis_scores: (current.axis_scores as Record<string, number>) ?? {},
    suggested_band: current.suggested_band as PlacementRecord["suggested_band"],
    suggested_rationale: current.suggested_rationale,
    band: args.band,
    validated: true,
    rationale: values.rationale,
    actor_name: args.actor.name,
    at: values.at,
  };
}

/**
 * A drag on the matrix. The gap takes the band of the quadrant it lands in. A
 * validated gap dropped in a different band goes back to unvalidated — the
 * band a human locked is no longer the band on the board — while a nudge
 * inside the same quadrant keeps the validation.
 */
export async function movePlacement(args: {
  gap_id: string;
  x_axis: string;
  y_axis: string;
  /** Favourable-scale position, 0–100: 100 is the priority end of each axis. */
  x: number;
  y: number;
  actor: Actor;
  workspace_id?: string;
}): Promise<PlacementRecord> {
  await ensurePlatformSchema();
  const axes = await loadAxes();
  const xAxis = axes.axes.find((axis) => axis.id === args.x_axis);
  const yAxis = axes.axes.find((axis) => axis.id === args.y_axis);
  if (!xAxis || !yAxis) throw new Error("Unknown matrix axis.");
  if (xAxis.id === yAxis.id) throw new Error("Pick two different axes for the matrix.");
  if (![args.x, args.y].every((value) => Number.isFinite(value))) {
    throw new Error("A matrix position needs two numbers.");
  }
  const rows = await db()
    .select()
    .from(t.priorityPlacements)
    .where(eq(t.priorityPlacements.gap_id, args.gap_id))
    .limit(1);
  const current = rows[0];
  if (!current) throw new Error(`${args.gap_id} is not on the matrix yet.`);
  const axis_scores = {
    ...((current.axis_scores as Record<string, number>) ?? {}),
    [xAxis.id]: scoreFromFavourability(xAxis, args.x),
    [yAxis.id]: scoreFromFavourability(yAxis, args.y),
  };
  const before = (current.band ?? current.suggested_band) as PlacementRecord["suggested_band"];
  const band = quadrantBand({ xAxis, yAxis, scores: axis_scores });
  const keepsValidation = current.validated && current.band === band;
  const values = {
    axis_scores,
    band,
    validated: keepsValidation,
    rationale: keepsValidation ? current.rationale : null,
    actor_name: keepsValidation ? current.actor_name : null,
    actor_function: keepsValidation ? current.actor_function : null,
    at: nowIso(),
  };
  await db().update(t.priorityPlacements).set(values).where(eq(t.priorityPlacements.gap_id, args.gap_id));
  if (before !== band) {
    await recordEdit({
      workspace_id: args.workspace_id,
      stage: "S8",
      entity_type: "gap",
      entity_id: args.gap_id,
      field: "matrix_band",
      action: "edit",
      before,
      after: band,
      rationale: `Moved on the ${xAxis.label} × ${yAxis.label} matrix`,
      actor: args.actor,
    });
  }
  return {
    gap_id: args.gap_id,
    axis_scores,
    suggested_band: current.suggested_band as PlacementRecord["suggested_band"],
    suggested_rationale: current.suggested_rationale,
    band,
    validated: keepsValidation,
    rationale: values.rationale,
    actor_name: values.actor_name,
    at: values.at,
  };
}

export type { StoredAxes };
