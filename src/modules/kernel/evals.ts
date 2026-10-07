import { desc, eq } from "drizzle-orm";
import { ensurePlatformSchema, sharedDb } from "./db";
import * as t from "./schema";
import { newId, nowIso } from "./ids";
import type { EvalScore, StageId, SynapseModule } from "./contracts";

export type EvalRunRecord = {
  id: string;
  at: string;
  stage: StageId;
  module_id: string;
  module_version: string;
  run_id: string | null;
  passed: boolean;
  metrics: EvalScore[];
  note: string | null;
};

export function scoresPassed(scores: EvalScore[]): boolean {
  return scores.every((score) => score.target === undefined || score.value >= score.target);
}

export async function recordEvalRun(args: {
  stage: StageId;
  module_id: string;
  module_version: string;
  run_id?: string | null;
  metrics: EvalScore[];
  note?: string;
}): Promise<EvalRunRecord> {
  await ensurePlatformSchema();
  const record: EvalRunRecord = {
    id: newId("eval"),
    at: nowIso(),
    stage: args.stage,
    module_id: args.module_id,
    module_version: args.module_version,
    run_id: args.run_id ?? null,
    passed: scoresPassed(args.metrics),
    metrics: args.metrics,
    note: args.note ?? null,
  };
  await sharedDb().insert(t.evalRuns).values({
    id: record.id,
    at: record.at,
    stage: record.stage,
    module_id: record.module_id,
    module_version: record.module_version,
    run_id: record.run_id,
    passed: record.passed,
    metrics: record.metrics,
    note: record.note,
  });
  return record;
}

export async function listEvalRuns(args?: { stage?: StageId; limit?: number }): Promise<EvalRunRecord[]> {
  await ensurePlatformSchema();
  const limit = args?.limit ?? 50;
  const query = sharedDb().select().from(t.evalRuns);
  const rows = args?.stage
    ? await query.where(eq(t.evalRuns.stage, args.stage)).orderBy(desc(t.evalRuns.at)).limit(limit)
    : await query.orderBy(desc(t.evalRuns.at)).limit(limit);
  return rows.map((row) => ({
    id: row.id,
    at: row.at,
    stage: row.stage as StageId,
    module_id: row.module_id,
    module_version: row.module_version,
    run_id: row.run_id,
    passed: row.passed,
    metrics: (row.metrics as EvalScore[]) ?? [],
    note: row.note,
  }));
}

/**
 * Runs a module's own gold cases through its own scorer. Each stage owns its
 * harness, so a stage can hillclimb without touching sibling stages.
 */
export async function runStageEvals<I, O>(
  module: SynapseModule<I, O>,
  execute: (input: I) => Promise<O>,
): Promise<{ metrics: EvalScore[]; cases: number }> {
  if (!module.evals) return { metrics: [], cases: 0 };
  const cases = await module.evals.cases();
  const perCase: EvalScore[][] = [];
  for (const testCase of cases) {
    const output = await execute(testCase.input);
    perCase.push(module.evals.score({ case: testCase, output }));
  }
  const names = [...new Set(perCase.flat().map((score) => score.name))];
  const metrics = names.map<EvalScore>((name) => {
    const scores = perCase.flat().filter((score) => score.name === name);
    const value = scores.reduce((sum, score) => sum + score.value, 0) / scores.length;
    return {
      name,
      value: Number(value.toFixed(4)),
      target: scores[0]?.target,
      unit: scores[0]?.unit,
      detail: `${scores.length} case(s)`,
    };
  });
  return { metrics, cases: cases.length };
}
