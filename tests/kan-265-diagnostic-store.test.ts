import { expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { forgetSchemaBootstrap } from "@/lib/iegp/db";
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
import { editSourceBlock, sourceBlockMeta, sourceDroppedUnits, sourceStakeholderMeta } from "@/lib/iegp/source-blocks";
import { listExtractionDocuments } from "@/modules/stages/s1-parse/module";
import { parsedDocuments } from "@/modules/stages/s1-parse/schema";
import { withEvaluationIsolation } from "@/modules/kernel/evaluation-isolation";
import { resetDemo, resetDemoSetup } from "@/lib/iegp/store";

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

it("freezes current editor blocks for both extractors without pruning prior-generation rows", async () => {
  const work = await createWorkspace({ name: "Diagnostic source edits", owner: "diagnostic-owner" });
  const actor = { name: "Fixture owner", function: "medical_affairs" as const };
  const identity = { actor, role: "medical_affairs" as const };
  await runInWorkspace({ workspace_id: work.id, schema: work.schema_name }, async () => {
    const state = await resetDemo();
    const source = state.sources.find((row) => row.id === "SRC-INT-MED")!;
    const blocks = state.blocks.filter((row) => row.source_id === source.id).sort((a, b) => a.id.localeCompare(b.id));
    const [first, second] = blocks;
    const documentId = "diagnostic-source-document";
    const input = { document_ids: [documentId], dry_run: true };
    await db().insert(parsedDocuments).values({
      id: documentId,
      file_id: "diagnostic-source-file",
      source_id: source.id,
      parser: "local",
      parser_version: "test",
      blocks,
      quality: {},
      parsed_at: source.ingested_at,
      duration_ms: 0,
    });
    const modules = await Promise.all([activeModule("S2"), activeModule("S3")]);
    for (const implementation of modules) {
      const facts = await withEvaluationIsolation(() => implementation.freeze!(implementation.inputSchema.parse(input)));
      const [test] = await implementation.evals!.cases();
      expect(implementation.evals!.goldForCase!(test, facts)).toMatchObject({ source_id: source.id });
    }

    const edited = await editSourceBlock({
      block_id: first.id,
      text: `${first.text} Additional owner-reviewed content.`,
      rationale: "Add an owner-reviewed clarification.",
      actor,
    });
    await db().update(sourceBlockMeta).set({ position: 3 }).where(eq(sourceBlockMeta.block_id, first.id));
    const source_generation = "prior-generation";
    await db().insert(sourceBlockMeta).values({
      block_id: second.id,
      source_id: source.id,
      origin: "human",
      locked: true,
      position: 10,
      current_text: second.text,
      source_generation,
    });
    await db().insert(sourceDroppedUnits).values({
      id: "diagnostic-stale-unit", source_id: source.id, location: "fixture", reason: "prior parse",
      text: "Previous source generation", created_at: "2026-01-01", source_generation,
    });
    await db().insert(sourceStakeholderMeta).values({ source_id: source.id, source_generation });
    const staleRows = () => Promise.all([
      db().select().from(sourceBlockMeta).where(eq(sourceBlockMeta.source_generation, source_generation)),
      db().select().from(sourceDroppedUnits).where(eq(sourceDroppedUnits.source_generation, source_generation)),
      db().select().from(sourceStakeholderMeta).where(eq(sourceStakeholderMeta.source_generation, source_generation)),
    ]);
    const before = await staleRows();
    expect(before.map((rows) => rows.length)).toEqual([1, 1, 1]);
    const legacyId = "diagnostic-legacy-priority";
    const lock = { locked: true, actor_name: actor.name, actor_function: actor.function };
    await db().execute(sql`insert into priorities (id, residual_id, suggested_score, suggested_band, band, reasons, lock)
      values (${legacyId}, 'RES-PERSIST', 0, 'low', 'low', '[]'::jsonb, ${JSON.stringify(lock)}::jsonb)`);
    const legacyMarker = async () => (await db().execute(sql`select carried_over_at from priorities where id = ${legacyId}`))[0]?.carried_over_at;
    const placement = async () => (await db().execute(sql`select band from priority_placements where gap_id = 'GAP-PERSIST'`))[0]?.band;
    forgetSchemaBootstrap(work.schema_name);
    await withEvaluationIsolation(async () => {
      for (const implementation of modules) {
        const facts = await implementation.freeze!(implementation.inputSchema.parse(input));
        expect(facts.documents).toMatchObject([{ id: documentId, blocks: [second, edited] }]);
        const [test] = await implementation.evals!.cases();
        expect(implementation.evals!.goldForCase!(test, facts)).toBeUndefined();
        const run = await runOwnerDiagnostics(implementation, identity, work.id, false);
        expect(run.variants[0]).toMatchObject({ passed: null, cases: 1 });
        expect(await staleRows()).toEqual(before);
      }
      expect(await legacyMarker()).toBeNull();
      expect(await placement()).toBeUndefined();
    });
    expect(await listExtractionDocuments([documentId])).toMatchObject([{ id: documentId, blocks: [second, edited] }]);
    expect(await staleRows()).toEqual([[], [], []]);
    expect(await legacyMarker()).toEqual(expect.any(String));
    expect(await placement()).toBe("low");
  });
}, 60_000);
