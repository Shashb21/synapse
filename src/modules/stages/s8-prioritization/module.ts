import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, ensurePlatformSchema } from "@/modules/kernel/db";
import * as t from "@/modules/kernel/schema";
import { nowIso } from "@/modules/kernel/ids";
import { registerModule } from "@/modules/kernel/registry";
import {
  PROPOSER_CRITIC_EXCHANGES,
  hasIssue,
  runAgenticCycle,
  type Critique,
} from "@/modules/kernel/agentic";
import { canPrompt } from "@/modules/kernel/routing";
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

Score each given axis from 0 to 100 for each gap, where 0 is the axis's "low" end and 100 its "high" end, using the asset, treatment setting and company context. Score the axis as described — for a cost-style axis a high score means high cost. Do not assign the band yourself; the tool derives it from the quadrant and the user validates it. Keep each rationale to one or two sentences naming what drove both scores.

Return JSON only: {"gaps":[{"gap_id":"","scores":{"<axis_id>":0},"rationale":""}]}`;

function heuristicScores(args: {
  gap: { name: string; statement: string; domain: string };
  axes: PriorityAxis[];
  importance: number;
}): { scores: Record<string, number>; rationale: string } {
  const hay = `${args.gap.name} ${args.gap.statement} ${args.gap.domain}`.toLowerCase();
  const scores: Record<string, number> = {};
  const hits: string[] = [];
  for (const axis of args.axes) {
    const matched = axis.cues.filter((cue) => hay.includes(cue.toLowerCase()));
    const base = 38 + Math.min(4, matched.length) * 11;
    const importanceBump = axis.id === "decision_impact" ? (args.importance - 3) * 6 : 0;
    scores[axis.id] = Math.max(0, Math.min(100, Math.round(base + importanceBump)));
    if (matched.length > 0) hits.push(`${axis.label}: ${matched.slice(0, 3).join(", ")}`);
  }
  return {
    scores,
    rationale: hits.length
      ? `Signals in the gap text — ${hits.join("; ")}.`
      : "No axis cues found in the gap text; scored at the neutral baseline.",
  };
}

async function llmScores(
  ctx: ModuleContext,
  args: {
    gaps: { id: string; name: string; statement: string; domain: string }[];
    axes: PriorityAxis[];
    context: PrioritizationInput["context"] & {
      launch_timeline?: string;
      company_situation?: string;
      lifecycle_stage?: string;
      strategic_importance?: number;
    };
    asset: IegpState["asset"];
    setting?: string;
    hints: string;
  },
): Promise<Map<string, { scores: Record<string, number>; rationale: string }>> {
  const payload = (await ctx.complete({
    system: PRIORITY_SYSTEM,
    user: JSON.stringify({
      hints: args.hints || undefined,
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
      gaps: args.gaps,
    }),
    purpose: "priority-suggester",
  })) as {
    gaps?: { gap_id?: string; scores?: Record<string, number>; rationale?: string }[];
  };
  const map = new Map<string, { scores: Record<string, number>; rationale: string }>();
  for (const row of payload.gaps ?? []) {
    if (!row.gap_id) continue;
    const scores: Record<string, number> = {};
    for (const axis of args.axes) {
      const value = row.scores?.[axis.id];
      if (typeof value === "number") scores[axis.id] = Math.max(0, Math.min(100, Math.round(value)));
    }
    map.set(row.gap_id, { scores, rationale: (row.rationale ?? "").trim() || "model suggestion" });
  }
  return map;
}

export const prioritizationModule: SynapseModule<PrioritizationInput, PrioritizationOutput> = {
  manifest: {
    id: "s8-prioritization.axes",
    stage: "S8",
    version: "1.0.0",
    title: "Prioritization on configurable axes",
    summary:
      "Scores every open gap on the configured axes, derives a suggested High / Medium / Low band, and places it on the matrix. The user validates.",
    contract: 1,
    agentic: true,
    capabilities: ["configurable-axes", "llm-suggester", "matrix-placement"],
  },
  inputSchema,
  outputSchema,
  async run(input, ctx) {
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
    const planningContext = { ...prioritizationContextFromState(state), ...input.context };
    const importance =
      planningContext.strategic_importance ?? state.objectives[0]?.strategic_importance ?? 3;
    const openGaps = state.gaps.filter(
      (gap) =>
        isLiveGap(gap) &&
        displayedGapStatus(gap) === "validated_open" &&
        (!input.gap_ids?.length || input.gap_ids.includes(gap.id)),
    );
    if (openGaps.length === 0) {
      return {
        output: {
          mode: "deterministic",
          axes: scoredAxes.map((axis) => ({ id: axis.id, label: axis.label, weight: axis.weight })),
          placements: [],
          skipped: 0,
        },
        summary: "No open gaps to prioritize",
      };
    }

    const local = (): Placement[] =>
      openGaps.map((gap) => {
        const { scores, rationale } = heuristicScores({
          gap: { name: gap.name, statement: gap.statement, domain: gap.domain },
          axes: scoredAxes,
          importance,
        });
        return {
          gap_id: gap.id,
          gap_name: gap.name,
          axis_scores: scores,
          ...place(scores),
          rationale,
        };
      });

    /**
     * A gap cannot be dropped from prioritization, so the proposer repairs: fill
     * the axes it left blank from the heuristic, then re-derive score and band so
     * the suggestion follows its own numbers.
     */
    const revisePlacements = (args: { previous: Placement[]; critiques: Critique[] }): Placement[] =>
      args.previous.map((placement) => {
        const critique = args.critiques.find((item) => item.subject === placement.gap_id);
        const gap = openGaps.find((row) => row.id === placement.gap_id);
        let axis_scores = placement.axis_scores;
        if (hasIssue(critique, "missing_scores") && gap) {
          const fallback = heuristicScores({
            gap: { name: gap.name, statement: gap.statement, domain: gap.domain },
            axes: scoredAxes,
            importance,
          }).scores;
          axis_scores = { ...fallback, ...axis_scores };
        }
        const rationale = placement.rationale.trim()
          ? placement.rationale
          : `Scored from the axis cues in the gap text; no model rationale was returned.`;
        return { ...placement, axis_scores, ...place(axis_scores), rationale };
      });

    const outcome = await runAgenticCycle<Placement>(ctx, "S8", {
      subjectOf: (placement) => placement.gap_id,
      proposer: {
        local: ({ round, previous, critiques }) =>
          round === 1 ? local() : revisePlacements({ previous, critiques }),
        llm: canPrompt(ctx.route)
          ? async ({ hints, round, critiques, previous }) => {
              const brief =
                round === 1
                  ? hints
                  : [
                      hints,
                      `Exchange ${round} of ${PROPOSER_CRITIC_EXCHANGES}. The critic objected: ${critiques
                        .filter((critique) => critique.verdict !== "keep")
                        .map((critique) => `${critique.subject} — ${critique.note}`)
                        .join("; ")}. Re-score the gaps it named.`,
                    ]
                      .filter(Boolean)
                      .join("\n\n");
              const remote = await llmScores(ctx, {
                gaps: openGaps.map((gap) => ({
                  id: gap.id,
                  name: gap.name,
                  statement: gap.statement,
                  domain: gap.domain,
                })),
                axes: scoredAxes,
                context: planningContext,
                asset: state.asset,
                setting: input.setting,
                hints: brief,
              });
              const basis = round === 1 ? local() : previous;
              return basis.map((placement) => {
                const suggestion = remote.get(placement.gap_id);
                if (!suggestion) return placement;
                const merged = { ...placement.axis_scores, ...suggestion.scores };
                return {
                  ...placement,
                  axis_scores: merged,
                  ...place(merged),
                  rationale: suggestion.rationale,
                };
              });
            }
          : undefined,
      },
      critic: (placements) =>
        placements.map((placement) => {
          const notes: string[] = [];
          const issues: string[] = [];
          let score = 70;
          const missing = scoredAxes.filter(
            (axis) => typeof placement.axis_scores[axis.id] !== "number",
          );
          if (missing.length > 0) {
            score -= 15 * missing.length;
            notes.push(`missing scores for ${missing.map((axis) => axis.label).join(", ")}`);
            issues.push("missing_scores");
          }
          if (!placement.rationale.trim()) {
            score -= 20;
            notes.push("no rationale for the suggestion");
            issues.push("no_rationale");
          }
          const expected = place(placement.axis_scores);
          if (expected.suggested_band !== placement.suggested_band) {
            score -= 25;
            notes.push("band does not follow from the quadrant");
            issues.push("band_mismatch");
          }
          if (placement.score !== expected.score) {
            score -= 15;
            notes.push("weighted score is stale against the axis scores");
            issues.push("stale_score");
          }
          return {
            subject: placement.gap_id,
            verdict: score >= 60 ? ("keep" as const) : score >= 35 ? ("revise" as const) : ("drop" as const),
            note: notes.length ? notes.join("; ") : "axis scores and band are consistent",
            score: Math.max(0, Math.min(100, score)),
            issues,
          };
        }),
      judge: ({ candidates, critiques }) =>
        candidates.map((placement) => {
          const critique = critiques.find((item) => item.subject === placement.gap_id);
          const score = critique?.score ?? 50;
          return {
            candidate: placement,
            subject: placement.gap_id,
            verdict: score >= 35 ? ("accept" as const) : ("reject" as const),
            score,
            note: critique?.note ?? "no critique",
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
