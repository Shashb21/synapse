import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, ensurePlatformSchema } from "@/modules/kernel/db";
import * as t from "@/modules/kernel/schema";
import { nowIso } from "@/modules/kernel/ids";

export type PriorityAxis = {
  id: string;
  label: string;
  description: string;
  /** Relative contribution to the suggested band. 0 keeps an axis visible but non-scoring. */
  weight: number;
  low_label: string;
  high_label: string;
  /** Phrases that raise this axis for a gap. Editable by the user. */
  cues: string[];
};

export type AxesConfig = {
  axes: PriorityAxis[];
  /** Which axes the matrix plots. Any axis can be moved onto an edge. */
  x_axis: string;
  y_axis: string;
  /** Thresholds on the weighted 0–100 score. */
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
      cues: [
        "hta",
        "reimbursement",
        "payer",
        "label",
        "regulatory",
        "launch",
        "guideline",
        "formulary",
        "submission",
      ],
    },
    {
      id: "time_pressure",
      label: "Time pressure",
      description: "How soon the evidence must exist for the decision it supports.",
      weight: 1,
      low_label: "Later cycle",
      high_label: "This cycle",
      cues: ["q1", "q2", "q3", "q4", "before launch", "deadline", "dossier", "urgent", "next year"],
    },
    {
      id: "external_scrutiny",
      label: "External scrutiny",
      description: "How exposed the gap is to HTA bodies, competitors and KOL challenge.",
      weight: 0.6,
      low_label: "Internal only",
      high_label: "Externally challenged",
      cues: ["competitor", "kol", "congress", "publication", "comparative", "versus", "standard of care"],
    },
    {
      id: "feasibility",
      label: "Feasibility",
      description: "How readily an evidence tactic could close it with existing capability.",
      weight: 0.4,
      low_label: "Hard to run",
      high_label: "Readily runnable",
      cues: ["registry", "chart review", "claims", "secondary analysis", "existing data", "survey"],
    },
  ],
  x_axis: "decision_impact",
  y_axis: "time_pressure",
  bands: { high: 62, medium: 42 },
};

const ROW_ID = "default";

export type StoredAxes = AxesConfig & { updated_by: string; updated_at: string };

export async function loadAxes(): Promise<StoredAxes> {
  await ensurePlatformSchema();
  const rows = await db().select().from(t.priorityAxes).where(eq(t.priorityAxes.id, ROW_ID)).limit(1);
  const row = rows[0];
  if (!row) return { ...DEFAULT_AXES, updated_by: "default", updated_at: "—" };
  const config = row.config as AxesConfig;
  return {
    axes: config.axes?.length ? config.axes : DEFAULT_AXES.axes,
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
        cues: z.array(z.string()).default([]),
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

export function bandFor(score: number, bands: AxesConfig["bands"]): "high" | "medium" | "low" {
  if (score >= bands.high) return "high";
  if (score >= bands.medium) return "medium";
  return "low";
}

export function weightedScore(scores: Record<string, number>, axes: PriorityAxis[]): number {
  const totalWeight = axes.reduce((sum, axis) => sum + axis.weight, 0);
  if (totalWeight === 0) return 0;
  const sum = axes.reduce((acc, axis) => acc + (scores[axis.id] ?? 0) * axis.weight, 0);
  return Math.round(sum / totalWeight);
}
