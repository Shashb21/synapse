import { eq } from "drizzle-orm";
import { ensurePlatformSchema, sharedDb } from "./db";
import * as t from "./schema";
import { newId, nowIso } from "./ids";
import type { EvalScore, StageId } from "./contracts";
import type { PromptVersionId } from "./prompt-versions";

export type PromptBaseline = {
  id: string;
  stage: StageId;
  prompt_version: PromptVersionId;
  module_id: string;
  module_version: string;
  metrics: EvalScore[];
  composite: number;
  recorded_at: string;
  note: string | null;
};

export const PROMPT_BASELINES_DDL = `
CREATE TABLE IF NOT EXISTS prompt_baselines (
  id text PRIMARY KEY,
  stage text NOT NULL,
  prompt_version text NOT NULL,
  module_id text NOT NULL,
  module_version text NOT NULL,
  metrics jsonb NOT NULL,
  composite numeric NOT NULL,
  recorded_at text NOT NULL,
  note text
);
CREATE UNIQUE INDEX IF NOT EXISTS prompt_baselines_stage_version
  ON prompt_baselines(stage, prompt_version);
`;

function compositeScore(metrics: EvalScore[]): number {
  const targeted = metrics.filter((metric) => metric.target !== undefined);
  if (targeted.length === 0) {
    const values = metrics.map((metric) => metric.value);
    return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
  }
  const ratios = targeted.map((metric) =>
    metric.target === 0 ? metric.value : Math.min(1, metric.value / (metric.target ?? 1)),
  );
  return Number((ratios.reduce((a, b) => a + b, 0) / ratios.length).toFixed(4));
}

export async function recordPromptBaseline(args: {
  stage: StageId;
  prompt_version: PromptVersionId;
  module_id: string;
  module_version: string;
  metrics: EvalScore[];
  note?: string;
}): Promise<PromptBaseline> {
  await ensurePlatformSchema([PROMPT_BASELINES_DDL]);
  const composite = compositeScore(args.metrics);
  const record: PromptBaseline = {
    id: newId("bl"),
    stage: args.stage,
    prompt_version: args.prompt_version,
    module_id: args.module_id,
    module_version: args.module_version,
    metrics: args.metrics,
    composite,
    recorded_at: nowIso(),
    note: args.note ?? null,
  };
  await sharedDb()
    .insert(t.promptBaselines)
    .values({
      id: record.id,
      stage: record.stage,
      prompt_version: record.prompt_version,
      module_id: record.module_id,
      module_version: record.module_version,
      metrics: record.metrics,
      composite: String(record.composite),
      recorded_at: record.recorded_at,
      note: record.note,
    })
    .onConflictDoUpdate({
      target: [t.promptBaselines.stage, t.promptBaselines.prompt_version],
      set: {
        module_id: record.module_id,
        module_version: record.module_version,
        metrics: record.metrics,
        composite: String(record.composite),
        recorded_at: record.recorded_at,
        note: record.note,
      },
    });
  return record;
}

export async function baselineFor(
  stage: StageId,
  prompt_version: PromptVersionId,
): Promise<PromptBaseline | null> {
  await ensurePlatformSchema([PROMPT_BASELINES_DDL]);
  const rows = await sharedDb()
    .select()
    .from(t.promptBaselines)
    .where(eq(t.promptBaselines.stage, stage))
    .limit(50);
  const row = rows.find((candidate) => candidate.prompt_version === prompt_version);
  if (!row) return null;
  return {
    id: row.id,
    stage: row.stage as StageId,
    prompt_version: row.prompt_version as PromptVersionId,
    module_id: row.module_id,
    module_version: row.module_version,
    metrics: (row.metrics as EvalScore[]) ?? [],
    composite: Number(row.composite),
    recorded_at: row.recorded_at,
    note: row.note,
  };
}

export async function listBaselines(stage?: StageId): Promise<PromptBaseline[]> {
  await ensurePlatformSchema([PROMPT_BASELINES_DDL]);
  const rows = stage
    ? await sharedDb().select().from(t.promptBaselines).where(eq(t.promptBaselines.stage, stage))
    : await sharedDb().select().from(t.promptBaselines);
  return rows.map((row) => ({
    id: row.id,
    stage: row.stage as StageId,
    prompt_version: row.prompt_version as PromptVersionId,
    module_id: row.module_id,
    module_version: row.module_version,
    metrics: (row.metrics as EvalScore[]) ?? [],
    composite: Number(row.composite),
    recorded_at: row.recorded_at,
    note: row.note,
  }));
}

export { compositeScore };
