import { and, desc, eq, sql } from "drizzle-orm";
import { ensurePlatformSchema, sharedDb } from "./db";
import * as t from "./schema";
import { newId, nowIso } from "./ids";
import type { EvalScore, StageId } from "./contracts";
import { evidenceHash } from "./decision-replay";
import { evalWorkspace, validScores } from "./evals";
import type { PromptVersionId } from "./prompt-versions";

export type ComparisonLineage = {
  workspace_id: string;
  stage: StageId;
  module_id: string;
  module_version: string;
  route_hash: string;
  prompt_hash: string;
  case_hash: string;
};
export function comparisonKey(lineage: ComparisonLineage) {
  return evidenceHash({ protocol: 4, ...lineage });
}
export function compositeScore(metrics: EvalScore[]): number | null {
  if (!validScores(metrics)) return null;
  const targeted = metrics.filter((metric) => metric.target !== undefined);
  if (!targeted.length) return null;
  return Number((targeted.reduce((sum, metric) => sum + metric.value, 0) / targeted.length).toFixed(4));
}

/** Append the observation and return drift from the last matching historical observation. */
export async function recordPromptBaseline(
  lineage: ComparisonLineage,
  version: PromptVersionId,
  metrics: EvalScore[],
  group_id: string,
) {
  const composite = compositeScore(metrics);
  if (composite === null || (await evalWorkspace()) !== lineage.workspace_id)
    throw new Error("Invalid diagnostic comparison.");
  await ensurePlatformSchema();
  const key = comparisonKey(lineage);
  return sharedDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
    const [previous] = await tx
      .select({ id: t.promptBaselineObservations.id, composite: t.promptBaselineObservations.composite })
      .from(t.promptBaselineObservations)
      .where(
        and(
          eq(t.promptBaselineObservations.workspace_id, lineage.workspace_id),
          eq(t.promptBaselineObservations.comparison_key, key),
        ),
      )
      .orderBy(desc(t.promptBaselineObservations.recorded_at), desc(t.promptBaselineObservations.id))
      .limit(1);
    await tx.insert(t.promptBaselineObservations).values({
      id: newId("bl"),
      ...lineage,
      comparison_key: key,
      previous_id: previous?.id ?? null,
      group_id,
      prompt_version: version,
      metrics,
      composite: String(composite),
      recorded_at: nowIso(),
    });
    return previous ? Number((composite - Number(previous.composite)).toFixed(4)) : null;
  });
}

export async function listHistoricalObservations() {
  const workspace_id = await evalWorkspace();
  await ensurePlatformSchema();
  const tHistory = t.promptBaselineObservations;
  return sharedDb()
    .select({
      id: tHistory.id,
      recorded_at: tHistory.recorded_at,
      stage: tHistory.stage,
      prompt_version: tHistory.prompt_version,
      composite: tHistory.composite,
    })
    .from(tHistory)
    .where(eq(tHistory.workspace_id, workspace_id))
    .orderBy(desc(tHistory.recorded_at))
    .limit(6);
}
