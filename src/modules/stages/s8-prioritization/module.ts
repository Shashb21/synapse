import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, ensurePlatformSchema } from "@/modules/kernel/db";
import * as t from "@/modules/kernel/schema";
import { nowIso } from "@/modules/kernel/ids";
import { registerModule } from "@/modules/kernel/registry";
import { runAgenticCycle } from "@/modules/kernel/agentic";
import { canPrompt } from "@/modules/kernel/routing";
import { recordEdit } from "@/modules/kernel/edit-records";
import type { Actor, ModuleContext, SynapseModule } from "@/modules/kernel/contracts";
import { displayedGapStatus, isLiveGap } from "@/lib/iegp/engine";
import { loadState, lockPriority } from "@/lib/iegp/store";
import type { IegpState } from "@/lib/iegp/types";
import { bandFor, loadAxes, weightedScore, type PriorityAxis, type StoredAxes } from "./axes";

const inputSchema = z.object({
  gap_ids: z.array(z.string()).optional(),
  /** Asset and company context the suggestion should weigh. */
  context: z
    .object({
      key_decision: z.string().optional(),
      decision_date: z.string().optional(),
      competitor_pressure: z.string().optional(),
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

const PRIORITY_SYSTEM = `You suggest High / Medium / Low priority for open evidence gaps in a pharma Integrated Evidence Generation Plan.

Score each configured axis from 0 to 100 for each gap, using the asset and company context. Do not assign the band yourself; the tool derives it from the axis scores and the user validates it.

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
    context: PrioritizationInput["context"];
    asset: IegpState["asset"];
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
    const importance = state.objectives[0]?.strategic_importance ?? 3;
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
          axes: axesConfig.axes.map((axis) => ({ id: axis.id, label: axis.label, weight: axis.weight })),
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
          axes: axesConfig.axes,
          importance,
        });
        const score = weightedScore(scores, axesConfig.axes);
        return {
          gap_id: gap.id,
          gap_name: gap.name,
          axis_scores: scores,
          score,
          suggested_band: bandFor(score, axesConfig.bands),
          rationale,
        };
      });

    const outcome = await runAgenticCycle<Placement>(ctx, "S8", {
      subjectOf: (placement) => placement.gap_id,
      proposer: {
        local,
        llm: canPrompt(ctx.route)
          ? async ({ hints }) => {
              const remote = await llmScores(ctx, {
                gaps: openGaps.map((gap) => ({
                  id: gap.id,
                  name: gap.name,
                  statement: gap.statement,
                  domain: gap.domain,
                })),
                axes: axesConfig.axes,
                context: input.context,
                asset: state.asset,
                hints,
              });
              return local().map((placement) => {
                const suggestion = remote.get(placement.gap_id);
                if (!suggestion) return placement;
                const merged = { ...placement.axis_scores, ...suggestion.scores };
                const score = weightedScore(merged, axesConfig.axes);
                return {
                  ...placement,
                  axis_scores: merged,
                  score,
                  suggested_band: bandFor(score, axesConfig.bands),
                  rationale: suggestion.rationale,
                };
              });
            }
          : undefined,
      },
      critic: (placements) =>
        placements.map((placement) => {
          const notes: string[] = [];
          let score = 70;
          const missing = axesConfig.axes.filter(
            (axis) => typeof placement.axis_scores[axis.id] !== "number",
          );
          if (missing.length > 0) {
            score -= 15 * missing.length;
            notes.push(`missing scores for ${missing.map((axis) => axis.label).join(", ")}`);
          }
          if (!placement.rationale.trim()) {
            score -= 20;
            notes.push("no rationale for the suggestion");
          }
          if (placement.suggested_band === "high" && placement.score < axesConfig.bands.high) {
            score -= 25;
            notes.push("band does not follow from the axis scores");
          }
          return {
            subject: placement.gap_id,
            verdict: score >= 60 ? ("keep" as const) : score >= 35 ? ("revise" as const) : ("drop" as const),
            note: notes.length ? notes.join("; ") : "axis scores and band are consistent",
            score: Math.max(0, Math.min(100, score)),
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
        const locked = current?.validated ?? false;
        const values = {
          gap_id: placement.gap_id,
          axis_scores: placement.axis_scores,
          // Once a human has validated a band, the suggestion they judged is kept:
          // losing it would erase the suggestion-versus-validation delta. The new
          // suggestion is still in this run's output and trace.
          suggested_band: locked ? current!.suggested_band : placement.suggested_band,
          suggested_rationale: locked ? current!.suggested_rationale : placement.rationale,
          band: locked ? current!.band : null,
          validated: locked,
          rationale: locked ? current!.rationale : null,
          actor_name: locked ? current!.actor_name : null,
          actor_function: locked ? current!.actor_function : null,
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
        axes: axesConfig.axes.map((axis) => ({ id: axis.id, label: axis.label, weight: axis.weight })),
        placements: outcome.accepted,
        skipped: outcome.rejected.length,
      },
      summary: `${outcome.accepted.length} open gap(s) placed on ${axesConfig.axes.length} axes${
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
    rationale: args.rationale.trim(),
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
    rationale: args.rationale,
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
        override_reason: args.rationale,
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

export type { StoredAxes };
