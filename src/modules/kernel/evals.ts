import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { currentSchemaName, inWorkspaceTransaction } from "@/lib/iegp/db";
import { DEFAULT_WORKSPACE_ID, scopedWorkspaceId } from "@/modules/workspaces/context";
import { getWorkspace } from "@/modules/workspaces/store";
import { TrustedApplicationError } from "./stage-errors";
import { db, ensurePlatformSchema, sharedDb } from "./db";
import * as t from "./schema";
import { newId, nowIso } from "./ids";
import type { EvalScore, StageId } from "./contracts";

const kinds = ["live_diagnostic", "harness_case", "harness_summary", "sweep_case", "sweep_summary"] as const;
export type EvalKind = (typeof kinds)[number];
export type EvalExecution = "routed" | "synthetic" | "mechanical" | "mixed";
export type EvalEvidenceIssue = "missing_receipt" | "changed_system_retry";
export type EvalLineage = {
  execution: EvalExecution;
  route_hash: string | null;
  prompt_hash: string | null;
  first_prompt_hash?: string | null;
  transcript_hash?: string | null;
  evidence_issue?: EvalEvidenceIssue;
  case_hash: string | null;
  case_name?: string;
  variant?: string;
};
export async function evalWorkspace(): Promise<string> {
  const id = await scopedWorkspaceId();
  if (id) return id;
  // Outside a request, database operations use public. Invalid request cookies throw here.
  if ((await currentSchemaName()) === "public") return DEFAULT_WORKSPACE_ID;
  throw new Error("The evaluation workspace is unavailable.");
}

/** Read the authoritative workspace flag. A failed lookup cannot certify a diagnostic. */
export async function assertDiagnosticWorkspace(expected: string) {
  if ((await evalWorkspace()) !== expected) throw new TrustedApplicationError("The diagnostic workspace changed.");
  const workspace = await getWorkspace(expected);
  if (!workspace && expected === DEFAULT_WORKSPACE_ID && (await currentSchemaName()) === "public") return;
  if (
    !workspace ||
    workspace.id !== expected ||
    workspace.demo_mode ||
    workspace.schema_name !== (await currentSchemaName())
  )
    throw new TrustedApplicationError("Select a workspace with live routing for diagnostics.");
}

/** Recheck the workspace row at commit and serialize against client-demo mode changes. */
export async function lockDiagnosticWorkspace(expected: string, schema: string, tx: Pick<ReturnType<typeof sharedDb>, "execute">) {
  const [workspace] = await tx.execute(sql`select schema_name, demo_mode from public.workspaces where id = ${expected} for share`);
  if (!workspace && expected === DEFAULT_WORKSPACE_ID && schema === "public") return;
  if (!workspace || workspace.demo_mode !== false || workspace.schema_name !== schema)
    throw new TrustedApplicationError("Select a workspace with live routing for diagnostics.");
}

export function validScores(scores: EvalScore[]): boolean {
  return (
    scores.length > 0 &&
    new Set(scores.map((s) => s.name)).size === scores.length &&
    scores.every(
      (s) =>
        typeof s.name === "string" &&
        !!s.name.trim() &&
        Number.isFinite(s.value) &&
        (s.target === undefined ||
          (Number.isFinite(s.target) &&
            (s.unit !== "ratio" || (s.value >= 0 && s.value <= 1 && s.target >= 0 && s.target <= 1)))),
    )
  );
}

export function scoresPassed(scores: EvalScore[]): boolean {
  return (
    validScores(scores) &&
    scores.some((s) => s.target !== undefined) &&
    scores.every((s) => s.target === undefined || s.value >= s.target)
  );
}

export function aggregateCaseMetrics(cases: EvalScore[][]): EvalScore[] {
  const names = [...new Set(cases.flat().map((s) => s.name))];
  return names.flatMap((name) => {
    const observations = cases.flatMap((scores) => scores.filter((s) => s.name === name));
    if (observations.some((s) => !Number.isFinite(s.value))) return [];
    const first = observations[0];
    const targeted = cases.every(
      (scores) =>
        validScores(scores) &&
        scores.some((s) => s.name === name && s.target === first.target && s.unit === first.unit),
    );
    return [
      {
        name,
        value: Number((observations.reduce((n, s) => n + s.value, 0) / observations.length).toFixed(4)),
        target: targeted ? first.target : undefined,
        unit: first.unit,
        detail: `${observations.length}/${cases.length} cases`,
      },
    ];
  });
}

export async function recordEvalRun(args: {
  workspace_id: string;
  kind: EvalKind;
  group_id?: string;
  lineage: EvalLineage;
  stage: StageId;
  module_id: string;
  module_version: string;
  run_id?: string;
  metrics: EvalScore[];
  note?: string;
}) {
  if ((await evalWorkspace()) !== args.workspace_id) throw new Error("Evaluation workspace changed.");
  await ensurePlatformSchema();
  const assessed =
    args.kind !== "live_diagnostic" &&
    !!args.group_id &&
    !!args.lineage.route_hash &&
    !!args.lineage.case_hash &&
    !!args.lineage.prompt_hash &&
    args.lineage.execution === "routed" &&
    !args.lineage.evidence_issue &&
    validScores(args.metrics) &&
    args.metrics.some((s) => s.target !== undefined);
  const row = { ...args, id: newId("eval"), at: nowIso(), passed: assessed ? scoresPassed(args.metrics) : null };
  if (inWorkspaceTransaction()) {
    // Keep live diagnostics in the transaction that publishes their stage output.
    await db().execute(sql`insert into public.eval_runs
      (id, at, workspace_id, kind, group_id, stage, module_id, module_version, run_id, passed, metrics, note, lineage)
      values (${row.id}, ${row.at}, ${row.workspace_id}, ${row.kind}, ${row.group_id ?? null},
        ${row.stage}, ${row.module_id}, ${row.module_version}, ${row.run_id ?? null}, ${row.passed},
        ${JSON.stringify(row.metrics)}::jsonb, ${row.note ?? null}, ${JSON.stringify(row.lineage)}::jsonb)`);
  } else {
    await sharedDb().insert(t.evalRuns).values(row);
  }
  return row;
}

export async function listEvalRuns(args?: { stage?: StageId; kind?: EvalKind; run_id?: string; limit?: number }) {
  const workspace = await evalWorkspace();
  await ensurePlatformSchema();
  const rows = await sharedDb()
    .select()
    .from(t.evalRuns)
    .where(
      and(
        eq(t.evalRuns.workspace_id, workspace),
        isNotNull(t.evalRuns.lineage),
        args?.kind ? eq(t.evalRuns.kind, args.kind) : inArray(t.evalRuns.kind, [...kinds]),
        args?.stage ? eq(t.evalRuns.stage, args.stage) : undefined,
        args?.run_id ? eq(t.evalRuns.run_id, args.run_id) : undefined,
      ),
    )
    .orderBy(desc(t.evalRuns.at))
    .limit(args?.limit ?? 50);
  return rows.map((row) => ({ ...row, metrics: row.metrics as EvalScore[], lineage: row.lineage as EvalLineage }));
}
