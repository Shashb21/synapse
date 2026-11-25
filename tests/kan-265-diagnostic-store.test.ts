import { expect, it } from "vitest";
import { sql } from "drizzle-orm";
import "@/modules";
import { createWorkspace } from "@/modules/workspaces/store";
import { runInWorkspace } from "@/modules/workspaces/context";
import { activeModule } from "@/modules/kernel/registry";
import { runOwnerDiagnostics } from "@/modules/kernel/hillclimb-loop";
import { listEvalRuns } from "@/modules/kernel/evals";
import { listHistoricalObservations, recordPromptBaseline } from "@/modules/kernel/baselines";
import { listDecisionExamples } from "@/modules/kernel/decision-examples";
import { db, sharedDb } from "@/modules/kernel/db";
import { runStage } from "@/modules/kernel/run";
import { resetDemoSetup } from "@/lib/iegp/store";

it("isolates actual extraction diagnostic and historical records from learning, live state and other workspaces", async () => {
  const work = await createWorkspace({
    name: "Fictional diagnostic " + crypto.randomUUID(),
    owner: "diagnostic-owner",
  });
  const other = await createWorkspace({
    name: "Fictional neighbour " + crypto.randomUUID(),
    owner: "diagnostic-owner",
  });
  const actor = { name: "Fixture owner", function: "medical_affairs" as const };
  const identity = { actor, role: "medical_affairs" as const };
  const inWork = <T>(fn: () => Promise<T>) => runInWorkspace({ workspace_id: work.id, schema: work.schema_name }, fn);
  await inWork(async () => {
    await resetDemoSetup();
    await runStage({ ...identity, stage: "S0", input: { demo_ids: ["heor-interview"] } });
    await runStage({ ...identity, stage: "S1", input: {} });
    const countLive = async () => {
      const results = [];
      for (const table of ["gap_candidates", "gaps", "needs", "module_runs", "edit_records", "hillclimb_signals"]) {
        results.push(await db().execute(sql.raw(`select count(*) from ${table}`)));
      }
      for (const table of ["decision_examples", "prompt_replay_snapshots"]) {
        results.push(
          await sharedDb().execute(sql`select count(*) from ${sql.identifier(table)} where workspace_id = ${work.id}`),
        );
      }
      return results;
    };
    await listDecisionExamples({ workspace_id: work.id, limit: 1 });
    // Rows from before workspace/lineage tracking survive, but neither list can display them.
    const legacy = crypto.randomUUID();
    await sharedDb().execute(sql`insert into eval_runs(id, at, stage, module_id, module_version, passed, metrics)
      values (${legacy}, '2020-01-01', 'S2', 'legacy', '1', true, '[]'::jsonb)`);
    await sharedDb()
      .execute(sql`insert into prompt_baselines(id, stage, prompt_version, module_id, module_version, metrics, composite, recorded_at)
      values (${legacy}, 'S2',${legacy},'legacy','1','[]'::jsonb,1,'2020-01-01')`);
    expect((await listEvalRuns()).some((row) => row.id === legacy)).toBe(false);
    expect(await listHistoricalObservations()).toEqual([]);
    const before = await countLive();
    const run = await runOwnerDiagnostics(await activeModule("S2"), identity, work.id, false);
    expect(run.variants[0]).toMatchObject({ passed: null, cases: 1 });
    expect(await countLive()).toEqual(before);
    const caseRows = await listEvalRuns({ kind: "harness_case" });
    const summaries = await listEvalRuns({ kind: "harness_summary" });
    expect(caseRows).toHaveLength(1);
    expect(caseRows[0]).toMatchObject({ group_id: run.group_id, lineage: { execution: "synthetic" } });
    expect(summaries).toHaveLength(1);
    expect(summaries[0].group_id).toBe(run.group_id);
    const lineage = {
      workspace_id: work.id,
      stage: "S2" as const,
      module_id: "fiction",
      module_version: "1",
      route_hash: "test-route",
      prompt_hash: "test-prompt",
      case_hash: "test-case",
    };
    const metrics = [{ name: "target", value: 0.5, target: 1 }];
    const write = (x: typeof lineage, value = 0.5) =>
      recordPromptBaseline(x, "v1.0-baseline", [{ ...metrics[0], value }], run.group_id);
    expect(await write(lineage)).toBeNull();
    expect(await write(lineage, 0.75)).toBe(0.25);
    for (const key of ["module_version", "route_hash", "case_hash", "prompt_hash"]) {
      expect(await write({ ...lineage, [key]: "changed" })).toBeNull();
    }
    expect(await listHistoricalObservations()).toHaveLength(6);
    await runInWorkspace({ workspace_id: other.id, schema: other.schema_name }, async () => {
      expect(await listEvalRuns()).toEqual([]);
      expect(await listHistoricalObservations()).toEqual([]);
      expect(await write({ ...lineage, workspace_id: other.id })).toBeNull();
    });
  });
}, 60_000);
