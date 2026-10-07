/** S8-owned scoring boundary: normalized facts in, bounded suggestions out; no plan state or placement IO. */
import { PROPOSER_CRITIC_EXCHANGES, runAgenticCycle } from "@/modules/kernel/agentic";
import { completeAll, isTestStub, requireLlm } from "@/modules/kernel/llm";
import { NoRouteError } from "@/modules/llm/provider";
import type { ModuleContext } from "@/modules/kernel/contracts";
import { enteredAssetDetails } from "@/lib/iegp/asset";
import type { AssetDetails } from "@/lib/iegp/asset";
import { quadrantBand, quadrantScore, type MatrixBand, type PriorityAxis } from "./axis-math";

export type PriorityConsiderations = Record<string, { state: "supported" | "missing"; text: string; references: {source_file_id: string; block_id: string; quote: string}[] }>;
export type PrioritySuggestion = { gap_id: string; gap_name: string; axis_scores: Record<string, number>; score: number; suggested_band: MatrixBand; rationale: string };
type Placement = PrioritySuggestion;
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

const REMEDY = "run prioritization again or switch the S8 route in /admin/control.";

export type PlanningContext = {
  key_decision?: string;
  decision_date?: string;
  competitor_pressure?: string;
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
  evidence?: unknown;
  previous?: { scores: Record<string, number>; rationale: string };
  objection?: string;
};

function promptContext(args: {
  asset?: Partial<AssetDetails>;
  setting?: string;
  context: PlanningContext;
  axes: PriorityAxis[];
  hints: string;
  considerations?: PriorityConsiderations;
}) {
  return {
    reviewer_corrections: args.hints || undefined,
    // Only what setup has entered: a blank plan sends no asset rather than empty strings.
    asset: args.asset ? enteredAssetDetails(args.asset) : undefined,
    setting: args.setting || "All treatment settings",
    context: args.context,
    considerations: args.considerations,
    evidence_policy: args.considerations ? "Missing considerations have no supporting evidence. Do not invent supporting facts; state relevant limitations." : undefined,
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
    placements: { gap_id: string; name: string; statement: string; domain: string; evidence?: unknown; scores: Record<string, number>; rationale: string }[];
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

export function placementFromScores(xAxis: PriorityAxis, yAxis: PriorityAxis, scores: Record<string, number>) {
  if ([xAxis, yAxis].some(axis => !Number.isFinite(scores[axis.id]) || scores[axis.id] < 0 || scores[axis.id] > 100)) {
    throw new Error("Both plotted axes require finite scores from 0 to 100.");
  }
  return { score: quadrantScore({ xAxis, yAxis, scores }), suggested_band: quadrantBand({ xAxis, yAxis, scores }) };
}
export async function suggestPriorities(args: {
  gaps: Omit<PromptGap, "previous" | "objection">[];
  axes: PriorityAxis[]; xAxis: PriorityAxis; yAxis: PriorityAxis;
  asset?: Partial<AssetDetails>; setting?: string; context: PlanningContext;
  considerations?: PriorityConsiderations; reviewerHints?: string;
}, ctx: ModuleContext) {
  requireLlm(ctx, "Prioritization");
  const openGaps = args.gaps, scoredAxes = args.axes;
  const place = (scores: Record<string, number>) => placementFromScores(args.xAxis, args.yAxis, scores);
    const gapById = new Map(openGaps.map((gap) => [gap.id, gap]));
    const describeGap = (id: string) => gapById.get(id)?.name ?? id;
    // The kernel hands reviewer corrections to the proposer; the critic weighs them too.
    let reviewerHints = "";
    const shared = () => ({
      asset: args.asset,
      setting: args.setting,
      context: args.context,
      considerations: args.considerations,
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

    return runAgenticCycle<Placement>(ctx, "S8", {
      reviewerHints: args.reviewerHints,
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
                    evidence: gap.evidence,
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
                    evidence: gap.evidence,
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

}

/** Shared typed-score and band transition validation. Stores supply eligibility and audit. */
export function validateManualPriorityInput(args: {
  axes: PriorityAxis[]; axis_scores?: Record<string, number>; x_axis?: string; y_axis?: string;
  band?: MatrixBand; validate?: boolean;
}) {
  const typed: Record<string, number> = {};
  for (const [id, value] of Object.entries(args.axis_scores ?? {})) {
    const axis = args.axes.find(axis => axis.id === id);
    if (!axis) throw new Error(`Unknown matrix axis ${id}.`);
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) throw new Error(`${axis.label} score must be a number from 0 to 100.`);
    typed[id] = Math.round(value);
  }
  const xAxis = args.axes.find(axis => axis.id === args.x_axis), yAxis = args.axes.find(axis => axis.id === args.y_axis);
  if ((args.x_axis && !xAxis) || (args.y_axis && !yAxis)) throw new Error("Unknown matrix axis.");
  if (xAxis && yAxis && xAxis.id === yAxis.id) throw new Error("Pick two different axes for the matrix.");
  if (args.band && !["high", "medium", "low", "defer"].includes(args.band)) throw new Error("Unknown priority band.");
  if (!Object.keys(typed).length && !args.band) throw new Error("Give an axis score or a band to place the gap.");
  return { typed, xAxis, yAxis };
}
export function manualPriorityInput(args: {
  axes: PriorityAxis[]; axis_scores?: Record<string, number>; x_axis?: string; y_axis?: string;
  band?: MatrixBand; validate?: boolean;
}, current?: { axis_scores: Record<string, number>; band: MatrixBand | null; suggested_band: MatrixBand; validated: boolean; human_axes?: string[] } | null) {
  const { typed, xAxis, yAxis } = validateManualPriorityInput(args);
  const axis_scores = { ...current?.axis_scores, ...typed };
  const quadrant = xAxis && yAxis && typeof axis_scores[xAxis.id] === "number" && typeof axis_scores[yAxis.id] === "number"
    ? quadrantBand({ xAxis, yAxis, scores: axis_scores }) : null;
  const band = args.band ?? quadrant ?? current?.band ?? current?.suggested_band;
  if (!band) throw new Error("Give a band, or score both plotted axes so the quadrant sets it.");
  return { axis_scores, band, human_axes: [...new Set([...(current?.human_axes ?? []), ...Object.keys(typed)])],
    human_band: true, validated: Boolean(args.validate) || Boolean(current?.validated && current.band === band) };
}

export type WorkingPriority = {
  axis_scores: Record<string, number>; suggested_band: MatrixBand; suggested_rationale: string;
  band: MatrixBand | null; validated: boolean; human_axes?: string[]; human_band?: boolean;
  rationale: string | null; actor_name: string | null; actor_function?: string | null; at: string;
};
/** Keep the suggestion judged by a current human; acquire only previously missing axes. */
export function mergePrioritySuggestion(current: WorkingPriority | null, suggestion: PrioritySuggestion, pairChosen: boolean, at: string): WorkingPriority {
  const scores = current?.axis_scores ?? {}, human_axes = current?.human_axes ?? [], human_band = current?.human_band ?? false;
  if (current?.validated) return { ...current, axis_scores: { ...suggestion.axis_scores, ...scores }, human_axes, human_band };
  const humanScores = Object.fromEntries(human_axes.filter(id => typeof scores[id] === "number").map(id => [id, scores[id]]));
  return { axis_scores: { ...scores, ...suggestion.axis_scores, ...humanScores }, suggested_band: suggestion.suggested_band,
    suggested_rationale: suggestion.rationale, band: human_band && current?.band ? current.band : pairChosen ? suggestion.suggested_band : current?.band ?? null,
    validated: false, rationale: human_band ? current?.rationale ?? null : null, actor_name: human_band ? current?.actor_name ?? null : null,
    actor_function: human_band ? current?.actor_function ?? null : null, at: human_band && current ? current.at : at,
    human_axes, human_band: human_band && Boolean(current?.band) };
}
