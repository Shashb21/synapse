import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, ensurePlatformSchema } from "@/modules/kernel/db";
import * as t from "@/modules/kernel/schema";
import { nowIso } from "@/modules/kernel/ids";
import type { PriorityAxis } from "./axis-math";

export {
  favourability,
  favourableLabel,
  quadrantBand,
  quadrantScore,
  scoreFromFavourability,
  unfavourableLabel,
} from "./axis-math";

export type { PriorityAxis };

export type AxesConfig = {
  axes: PriorityAxis[];
  /** Which axes the matrix plots. Any axis can be moved onto an edge. */
  x_axis: string;
  y_axis: string;
  /** Legacy thresholds from the weighted-score band; the band is now the quadrant. */
  bands: { high: number; medium: number };
};

export const DEFAULT_AXES: AxesConfig = {
  axes: [
    {
      id: "decision_impact",
      label: "Decision impact",
      description: "How much a cross-functional decision changes if this gap stays open.",
      weight: 1,
      low_label: "Informative",
      high_label: "Blocks a decision",
    },
    {
      id: "time_pressure",
      label: "Time pressure",
      description: "How soon the evidence must exist for the decision it supports.",
      weight: 1,
      low_label: "Later cycle",
      high_label: "This cycle",
    },
    {
      id: "external_scrutiny",
      label: "External scrutiny",
      description: "How exposed the gap is to HTA bodies, competitors and KOL challenge.",
      weight: 0.6,
      low_label: "Internal only",
      high_label: "Externally challenged",
    },
    {
      id: "feasibility",
      label: "Feasibility",
      description: "How readily an evidence tactic could close it with existing capability.",
      weight: 0.4,
      low_label: "Hard to run",
      high_label: "Readily runnable",
    },
    {
      id: "effort_cost",
      label: "Effort & cost",
      description: "How much time, budget and operational effort closing the gap would take.",
      weight: 0,
      low_label: "Low effort",
      high_label: "High effort",
      higher_is_priority: false,
    },
    {
      id: "patient_impact",
      label: "Patient impact",
      description: "How much closing the gap could change outcomes or care for patients.",
      weight: 0,
      low_label: "Marginal",
      high_label: "Changes patient care",
    },
    {
      id: "payer_value",
      label: "Payer / HTA relevance",
      description: "How directly the gap bears on access, reimbursement and value arguments.",
      weight: 0,
      low_label: "Not access-relevant",
      high_label: "Core to access",
    },
    {
      id: "strategic_fit",
      label: "Strategic fit",
      description: "How central the gap is to the brand strategy and lifecycle plan.",
      weight: 0,
      low_label: "Peripheral",
      high_label: "Core to strategy",
    },
  ],
  x_axis: "decision_impact",
  y_axis: "time_pressure",
  bands: { high: 62, medium: 42 },
};

const ROW_ID = "default";

/**
 * A saved axis configuration predates axes added to the catalog later, so any
 * default axis it lacks is appended; saved edits to existing axes win.
 */
function withCatalogDefaults(saved: PriorityAxis[] | undefined): PriorityAxis[] {
  if (!saved?.length) return DEFAULT_AXES.axes;
  const ids = new Set(saved.map((axis) => axis.id));
  return [...saved, ...DEFAULT_AXES.axes.filter((axis) => !ids.has(axis.id))];
}

export type StoredAxes = AxesConfig & { updated_by: string; updated_at: string };

export async function loadAxes(): Promise<StoredAxes> {
  await ensurePlatformSchema();
  const rows = await db().select().from(t.priorityAxes).where(eq(t.priorityAxes.id, ROW_ID)).limit(1);
  const row = rows[0];
  if (!row) return { ...DEFAULT_AXES, updated_by: "default", updated_at: "—" };
  const config = row.config as AxesConfig;
  return {
    axes: withCatalogDefaults(config.axes),
    x_axis: config.x_axis ?? DEFAULT_AXES.x_axis,
    y_axis: config.y_axis ?? DEFAULT_AXES.y_axis,
    bands: config.bands ?? DEFAULT_AXES.bands,
    updated_by: row.updated_by,
    updated_at: row.updated_at,
  };
}

/** Shape of a saved axis configuration. Semantic rules live in `validateAxes`. */
export const axesConfigSchema = z.object({
  axes: z
    .array(
      z.object({
        id: z
          .string()
          .min(1)
          .regex(/^[a-z0-9_]+$/, "axis ids use lowercase letters, digits and underscores"),
        label: z.string().min(1),
        description: z.string().default(""),
        weight: z.number().min(0).max(5),
        low_label: z.string().min(1),
        high_label: z.string().min(1),
        higher_is_priority: z.boolean().optional(),
      }),
    )
    .min(2),
  x_axis: z.string().min(1),
  y_axis: z.string().min(1),
  bands: z.object({
    high: z.number().min(1).max(100),
    medium: z.number().min(0).max(99),
  }),
});

export function parseAxesConfig(value: unknown): AxesConfig {
  const parsed = axesConfigSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `The axis configuration is malformed: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"} ${issue.message}`)
        .join("; ")}`,
    );
  }
  return parsed.data;
}

export function validateAxes(config: AxesConfig): AxesConfig {
  if (config.axes.length < 2) throw new Error("At least two axes are required.");
  const ids = new Set(config.axes.map((axis) => axis.id));
  if (ids.size !== config.axes.length) throw new Error("Axis ids must be unique.");
  if (!ids.has(config.x_axis) || !ids.has(config.y_axis)) {
    throw new Error("The matrix axes must reference configured axes.");
  }
  if (config.x_axis === config.y_axis) throw new Error("Pick two different axes for the matrix.");
  if (config.bands.high <= config.bands.medium) {
    throw new Error("The High threshold must sit above the Medium threshold.");
  }
  return config;
}

export async function saveAxes(args: { config: unknown; actor_name: string }): Promise<StoredAxes> {
  await ensurePlatformSchema();
  const config = validateAxes(parseAxesConfig(args.config));
  const values = {
    id: ROW_ID,
    config,
    updated_by: args.actor_name,
    updated_at: nowIso(),
  };
  await db()
    .insert(t.priorityAxes)
    .values(values)
    .onConflictDoUpdate({ target: t.priorityAxes.id, set: values });
  return { ...config, updated_by: values.updated_by, updated_at: values.updated_at };
}

/**
 * Prioritize is scoped: one treatment setting at a time, or every Open gap.
 * Each scope remembers the two axes it was prioritized on.
 */
export const ALL_SETTINGS_SCOPE = "all";

export type ScopeAxes = { x_axis: string; y_axis: string; updated_by: string; updated_at: string };

function scopeRowId(scope: string): string {
  return `scope:${scope.trim().toLowerCase()}`;
}

export async function loadScopeAxes(scope: string): Promise<ScopeAxes | null> {
  await ensurePlatformSchema();
  const rows = await db()
    .select()
    .from(t.priorityAxes)
    .where(eq(t.priorityAxes.id, scopeRowId(scope)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const config = row.config as { x_axis?: string; y_axis?: string };
  if (!config.x_axis || !config.y_axis) return null;
  return {
    x_axis: config.x_axis,
    y_axis: config.y_axis,
    updated_by: row.updated_by,
    updated_at: row.updated_at,
  };
}

export async function saveScopeAxes(args: {
  scope: string;
  x_axis: string;
  y_axis: string;
  actor_name: string;
}): Promise<ScopeAxes> {
  const catalog = await loadAxes();
  const ids = new Set(catalog.axes.map((axis) => axis.id));
  if (!ids.has(args.x_axis) || !ids.has(args.y_axis)) {
    throw new Error("Pick both axes from the list.");
  }
  if (args.x_axis === args.y_axis) throw new Error("Pick two different axes for the matrix.");
  const values = {
    id: scopeRowId(args.scope),
    config: { x_axis: args.x_axis, y_axis: args.y_axis },
    updated_by: args.actor_name,
    updated_at: nowIso(),
  };
  await db()
    .insert(t.priorityAxes)
    .values(values)
    .onConflictDoUpdate({ target: t.priorityAxes.id, set: values });
  return { x_axis: args.x_axis, y_axis: args.y_axis, updated_by: args.actor_name, updated_at: values.updated_at };
}
