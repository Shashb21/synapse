import { eq } from "drizzle-orm";
import { ensureCurrentSchemaTables } from "@/lib/iegp/db";
import { boolean, jsonb, pgTable, text } from "drizzle-orm/pg-core";
import { z } from "zod";
import { db, ensurePlatformSchema } from "@/modules/kernel/db";
import { nowIso } from "@/modules/kernel/ids";
import { registerModule } from "@/modules/kernel/registry";
import { isTestStub, requireLlm } from "@/modules/kernel/llm";
import { recordEdit, requireRationale } from "@/modules/kernel/edit-records";
import type { Actor, SynapseModule } from "@/modules/kernel/contracts";
import { eligibilityGapStatus, isLiveGap, requireOpenGap } from "@/lib/iegp/engine";
import { prioritizationContextFromState } from "@/lib/iegp/planning-context";
import { loadState, lockPriority } from "@/lib/iegp/store";
import type { IegpState } from "@/lib/iegp/types";
import {
  loadAxes,
  quadrantBand,
  scoreFromFavourability,
  type MatrixBand,
  type StoredAxes,
} from "./axes";
import { suggestPriorities, validateManualPriorityInput, manualPriorityInput, mergePrioritySuggestion, type PlanningContext } from "./scoring";
import { plural } from "@/lib/plural";

/**
 * The kernel's `priority_placements` table plus the human markers S8 owns:
 * `human_axes` lists the axis ids a person set (by drag or by typing a score)
 * and `human_band` says the working band is a person's. A re-run never
 * overwrites either; the model only refreshes its own suggestion.
 */
const placementsTable = pgTable("priority_placements", {
  gap_id: text("gap_id").primaryKey(),
  axis_scores: jsonb("axis_scores").notNull(),
  suggested_band: text("suggested_band").notNull(),
  suggested_rationale: text("suggested_rationale").notNull(),
  band: text("band"),
  validated: boolean("validated").notNull().default(false),
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
    requireLlm(ctx, "Prioritization");
    const [state, axesConfig] = await Promise.all([loadState(), loadAxes()]);
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
    const planningContext: PlanningContext = { ...prioritizationContextFromState(state), ...input.context };
    const openGaps = state.gaps.filter(
      (gap) =>
        isLiveGap(gap) &&
        eligibilityGapStatus(gap, state) === "validated_open" &&
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

    const outcome = await suggestPriorities({ gaps: openGaps, axes: scoredAxes, xAxis, yAxis,
      asset: state.asset, setting: input.setting, context: planningContext }, ctx);

    if (!input.dry_run) {
      await ensurePlacementSchema();
      const existing = await db().select().from(placementsTable);
      for (const placement of outcome.accepted) {
        const current = existing.find((row) => row.gap_id === placement.gap_id);
        const currentScores = (current?.axis_scores as Record<string, number> | undefined) ?? {};
        const humanAxes = humanAxesOf(current);
        const humanBand = current?.human_band ?? false;
        const placedAlready =
          typeof currentScores[xAxis.id] === "number" && typeof currentScores[yAxis.id] === "number";
        if (current && input.only_missing && placedAlready) continue;
        const values = { gap_id: placement.gap_id, ...mergePrioritySuggestion(current ? {
          ...current, axis_scores: currentScores, suggested_band: current.suggested_band as MatrixBand,
          band: current.band as MatrixBand | null, human_axes: humanAxes, human_band: humanBand,
        } : null, placement, pairChosen, nowIso()) };
        await db()
          .insert(placementsTable)
          .values(values)
          .onConflictDoUpdate({ target: placementsTable.gap_id, set: values });
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
  suggested_band: MatrixBand;
  /** Empty when no model has suggested a placement (a hand-placed gap). */
  suggested_rationale: string;
  /** "defer" is a deliberate, validated choice to leave the gap out of this cycle. */
  band: MatrixBand | null;
  validated: boolean;
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
    axis_scores: (row.axis_scores as Record<string, number>) ?? {},
    suggested_band: row.suggested_band as Band,
    suggested_rationale: row.suggested_rationale,
    band: (row.band as Band | null) ?? null,
    validated: row.validated,
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
  const open = state.gaps.filter((gap) => isLiveGap(gap) && eligibilityGapStatus(gap, state) === "validated_open");
  return { open: open.length, validated: open.filter((gap) => validated.has(gap.id)).length };
}

async function currentPlacement(gapId: string): Promise<PlacementRow | undefined> {
  const rows = await db().select().from(placementsTable).where(eq(placementsTable.gap_id, gapId)).limit(1);
  return rows[0];
}

/**
 * A row for a gap no model has placed. There is no suggestion yet, so the
 * suggested band mirrors the person's band and the suggested rationale stays
 * empty until a model run fills it in.
 */
async function insertManualPlacement(values: {
  gap_id: string;
  axis_scores: Record<string, number>;
  band: Band;
  validated: boolean;
  rationale: string | null;
  actor: Actor | null;
  human_axes: string[];
}): Promise<PlacementRow> {
  const row = {
    gap_id: values.gap_id,
    axis_scores: values.axis_scores,
    suggested_band: values.band,
    suggested_rationale: "",
    band: values.band,
    validated: values.validated,
    rationale: values.rationale,
    actor_name: values.actor?.name ?? null,
    actor_function: values.actor?.function ?? null,
    at: nowIso(),
    human_axes: values.human_axes,
    human_band: true,
  };
  await db().insert(placementsTable).values(row);
  return row;
}

async function mirrorLegacyBand(gapId: string, band: Band, rationale: string, actor: Actor) {
  // The legacy residual-keyed board has no Defer; it keeps its last band.
  if (band === "defer") return;
  // Keep the legacy residual-keyed board in step when the gap has a residual.
  const state = await loadState();
  const residual = state.residuals.find((row) => row.gap_id === gapId);
  if (!residual) return;
  try {
    await lockPriority({
      residual_id: residual.id,
      band,
      override_reason: rationale,
      actor_name: actor.name,
      actor_function: actor.function,
    });
  } catch {
    // The legacy board is a mirror; a mismatch there must not fail validation.
  }
}

/**
 * The S8 human gate: the user accepts or changes the suggested band with a
 * rationale, which is both the audit record and a hillclimb signal. A gap no
 * model has placed can be validated straight away: the person's band is the
 * placement.
 */
export async function validatePlacement(args: {
  gap_id: string;
  band: Band;
  rationale: string;
  actor: Actor;
  workspace_id?: string;
}): Promise<PlacementRecord> {
  await ensurePlacementSchema();
  // Rationale first: a band must not move before the reason for it is known good.
  const rationale = requireRationale(args.rationale);
  const current = await currentPlacement(args.gap_id);
  requireOpenGap(args.gap_id, await loadState());
  let row: PlacementRow;
  if (!current) {
    row = await insertManualPlacement({
      gap_id: args.gap_id,
      axis_scores: {},
      band: args.band,
      validated: true,
      rationale,
      actor: args.actor,
      human_axes: [],
    });
  } else {
    const values = {
      band: args.band,
      validated: true,
      rationale,
      actor_name: args.actor.name,
      actor_function: args.actor.function,
      at: nowIso(),
      human_band: true,
    };
    await db().update(placementsTable).set(values).where(eq(placementsTable.gap_id, args.gap_id));
    row = { ...current, ...values };
  }
  await recordEdit({
    workspace_id: args.workspace_id,
    stage: "S8",
    entity_type: "gap",
    entity_id: args.gap_id,
    field: "priority_band",
    action: !current ? "add" : current.suggested_band === args.band ? "accept" : "edit",
    before: current?.suggested_band ?? null,
    after: args.band,
    rationale,
    actor: args.actor,
  });
  await mirrorLegacyBand(args.gap_id, args.band, rationale, args.actor);
  return toRecord(row);
}

/**
 * A person places a gap by hand, with no model run: typed axis scores (raw
 * 0–100 on each axis's own scale), a band, or both. With both plotted axes
 * scored and no band given, the band is the quadrant. The scores and band are
 * marked as the person's, so a later S8 run keeps them. `validate` also locks
 * the band, as the validate gate does; otherwise a validated gap keeps its
 * validation only while its band is unchanged.
 */
export async function setPlacement(args: {
  gap_id: string;
  axis_scores?: Record<string, number>;
  x_axis?: string;
  y_axis?: string;
  band?: Band;
  validate?: boolean;
  rationale: string;
  actor: Actor;
  workspace_id?: string;
}): Promise<PlacementRecord> {
  await ensurePlacementSchema();
  const rationale = requireRationale(args.rationale);
  const axes = await loadAxes();
  validateManualPriorityInput({ ...args, axes: axes.axes });
  const current = await currentPlacement(args.gap_id);
  requireOpenGap(args.gap_id, await loadState());
  const { axis_scores, band, human_axes, validated } = manualPriorityInput({ ...args, axes: axes.axes }, current ? {
    ...current, axis_scores: current.axis_scores as Record<string, number>, suggested_band: current.suggested_band as Band,
    band: current.band as Band | null, human_axes: humanAxesOf(current),
  } : null);
  const before = current ? ((current.band ?? current.suggested_band) as Band) : null;

  let row: PlacementRow;
  if (!current) {
    row = await insertManualPlacement({
      gap_id: args.gap_id,
      axis_scores,
      band,
      validated,
      rationale,
      actor: args.actor,
      human_axes,
    });
  } else {
    const values = {
      axis_scores,
      band,
      validated,
      rationale,
      actor_name: args.actor.name,
      actor_function: args.actor.function,
      at: nowIso(),
      human_axes,
      human_band: true,
    };
    await db().update(placementsTable).set(values).where(eq(placementsTable.gap_id, args.gap_id));
    row = { ...current, ...values };
  }
  const scoreText = (scores: Record<string, number>) =>
    Object.entries(scores)
      .map(([id, value]) => `${id}=${value}`)
      .join(", ");
  await recordEdit({
    workspace_id: args.workspace_id,
    stage: "S8",
    entity_type: "gap",
    entity_id: args.gap_id,
    field: "placement",
    action: current ? "edit" : "add",
    before: current ? `${before} (${scoreText((current.axis_scores as Record<string, number>) ?? {})})` : null,
    after: `${band} (${scoreText(axis_scores)})${validated ? " validated" : ""}`,
    rationale,
    actor: args.actor,
  });
  if (validated) await mirrorLegacyBand(args.gap_id, band, rationale, args.actor);
  return toRecord(row);
}

/**
 * A drag on the matrix. The gap takes the band of the quadrant it lands in. A
 * validated gap dropped in a different band goes back to unvalidated — the
 * band a human locked is no longer the band on the board — while a nudge
 * inside the same quadrant keeps the validation. The two dragged axes and the
 * band become the person's, so a re-run does not move the gap back. A gap no
 * model has placed yet can be dropped on the matrix too.
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
  await ensurePlacementSchema();
  const axes = await loadAxes();
  const xAxis = axes.axes.find((axis) => axis.id === args.x_axis);
  const yAxis = axes.axes.find((axis) => axis.id === args.y_axis);
  if (!xAxis || !yAxis) throw new Error("Unknown matrix axis.");
  if (xAxis.id === yAxis.id) throw new Error("Pick two different axes for the matrix.");
  if (![args.x, args.y].every((value) => Number.isFinite(value))) {
    throw new Error("A matrix position needs two numbers.");
  }
  const current = await currentPlacement(args.gap_id);
  requireOpenGap(args.gap_id, await loadState());
  const axis_scores = {
    ...((current?.axis_scores as Record<string, number> | undefined) ?? {}),
    [xAxis.id]: scoreFromFavourability(xAxis, args.x),
    [yAxis.id]: scoreFromFavourability(yAxis, args.y),
  };
  const before = current ? ((current.band ?? current.suggested_band) as Band) : null;
  const band = quadrantBand({ xAxis, yAxis, scores: axis_scores });
  const human_axes = [...new Set([...humanAxesOf(current), xAxis.id, yAxis.id])];
  let row: PlacementRow;
  if (!current) {
    row = await insertManualPlacement({
      gap_id: args.gap_id,
      axis_scores,
      band,
      validated: false,
      rationale: null,
      actor: null,
      human_axes,
    });
  } else {
    const keepsValidation = current.validated && current.band === band;
    const values = {
      axis_scores,
      band,
      validated: keepsValidation,
      rationale: keepsValidation ? current.rationale : null,
      actor_name: keepsValidation ? current.actor_name : null,
      actor_function: keepsValidation ? current.actor_function : null,
      at: nowIso(),
      human_axes,
      human_band: true,
    };
    await db().update(placementsTable).set(values).where(eq(placementsTable.gap_id, args.gap_id));
    row = { ...current, ...values };
  }
  if (before !== band) {
    await recordEdit({
      workspace_id: args.workspace_id,
      stage: "S8",
      entity_type: "gap",
      entity_id: args.gap_id,
      field: "matrix_band",
      action: current ? "edit" : "add",
      before,
      after: band,
      rationale: `Moved on the ${xAxis.label} × ${yAxis.label} matrix`,
      actor: args.actor,
    });
  }
  return toRecord(row);
}

export type { StoredAxes };
