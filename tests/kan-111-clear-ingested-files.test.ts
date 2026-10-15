/** Selective clear regressions run only in newly created disposable schemas. */
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
// Two real concurrent requests must reach PostgreSQL to exercise the try-lock.
const previousPoolMax = vi.hoisted(() => {
  const previous = process.env.DATABASE_POOL_MAX;
  process.env.DATABASE_POOL_MAX = "2";
  return previous;
});
afterAll(() => {
  if (previousPoolMax === undefined) delete process.env.DATABASE_POOL_MAX;
  else process.env.DATABASE_POOL_MAX = previousPoolMax;
});
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
import "@/modules";
import { clearIngestedFiles } from "@/modules/workspaces/clear-ingested-files";
import { advanceIngest } from "@/app/api/iegp/ingest-pipeline";
import { db } from "@/modules/kernel/db";
import { currentSchemaName } from "@/lib/iegp/db";
import { runInWorkspace } from "@/modules/workspaces/context";
import { commitExtractedRecords, createGap, loadState, recordMissedTactic } from "@/lib/iegp/store";
import * as guard from "@/modules/auth/api-guard";
import { assignTacticToGap } from "@/lib/iegp/store";
import { POST } from "@/app/api/iegp/route";
import { POST as modulePost } from "@/app/api/modules/route";
import { kgMappingModule } from "@/modules/stages/s4-kg-mapping/module";
const actor = { name: "Clear test", function: "medical_affairs" } as const;
const file = { filename: "clear.txt", title: "Clear test", source_type: "advisory_board", stakeholder_function: "market_access", text: "Payers need comparative evidence versus standard of care. A registry study will collect real-world persistence data." } as const;
async function isolated(test: (pg: ReturnType<typeof postgres>, schema: string) => Promise<void>) {
  const pg = postgres(process.env.DATABASE_URL!, { max: 1, connection: { client_min_messages: "warning" } });
  const schema = `ws_clear_${randomBytes(8).toString("hex")}`;
  try { await runInWorkspace({ workspace_id: schema, schema }, async () => { await currentSchemaName(); await test(pg, schema); }); }
  finally { await pg.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await pg.end(); }
}
async function ingest() {
  let step = await advanceIngest({ files: [file], actor, role: "medical_affairs" });
  while (!step.done) step = await advanceIngest({ job_id: step.job_id, actor, role: "medical_affairs" });
  // Persist deterministic judged rows through the real store: LLM stub output
  // may legitimately contain zero propositions for a blank setup.
  const state = await loadState();
  const runs = await db().execute(sql`select id, stage from module_runs where status = 'ok' and stage in ('S2', 'S3')`);
  const source_id = state.sources[0].id;
  const committed = await commitExtractedRecords({
    source_id, title: file.title, stakeholder_function: file.stakeholder_function,
    actor_name: actor.name, actor_function: actor.function,
    needs: [{ id: "fixture-gap", statement: "Comparative evidence is missing", source_quote: file.text, provenance: { run_id: String(runs.find(r => r.stage === "S2")!.id) } }],
    gaps: [{ id: "fixture-gap", name: "Comparative evidence", statement: "Comparative evidence is missing", domain: "comparative_effectiveness", source_id, source_quote: file.text }],
    tactics: [{ id: "fixture-tactic", name: "Registry study", type: "registry", status: "planned", evidence_question: "What is persistence?", source_id, source_quote: file.text }],
  });
  for (const [stage, key, ids] of [["S2", "committed_gap_ids", committed.gap_ids], ["S3", "committed_tactic_ids", committed.tactic_ids]] as const) {
    const run = runs.find(r => r.stage === stage)!;
    await db().execute(sql`update module_runs set output = jsonb_set(output, array[${key}], coalesce(output->${key}, '[]'::jsonb) || ${JSON.stringify(ids)}::jsonb) where id = ${run.id}`);
  }
  return step;
}
async function post(body: Record<string, unknown> = {}) {
  return POST(new Request("http://localhost/api/iegp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "clear_ingested_files", ...body }) }));
}
describe("KAN-111 selective clear", () => {
  it("preserves manual work and history, removes ingestion state, invalidates old resumes and accepts a fresh upload", async () => isolated(async () => {
    const old = await ingest();
    const before = await loadState();
    expect(before.sources.length).toBeGreaterThan(0);
    const manual = await createGap({ statement: "Manually authored gap", source_id: before.sources[0].id, source_quote: "Payers need comparative evidence", actor_name: actor.name, actor_function: actor.function });
    const tactic = await recordMissedTactic({ name: "Manual tactic", type: "registry", status: "planned", evidence_question: "Manual question", actor_name: actor.name, actor_function: actor.function });
    const runs = await db().execute(sql`select id from module_runs`);
    await clearIngestedFiles();
    const after = await loadState();
    expect(after.sources).toEqual([]);
    expect(after.blocks).toEqual([]);
    expect(after.gaps.map(g => g.id)).toEqual([manual]);
    expect(after.tactics.map(t => t.id)).toEqual([tactic]);
    expect(after.needs.every(n => n.source_id === "" && n.source_quote === "")).toBe(true);
    expect(after.audit.length).toBeGreaterThanOrEqual(before.audit.length);
    expect(await db().execute(sql`select id from module_runs`)).toEqual(runs);
    expect(await db().execute(sql`select * from ingestion_jobs`)).toEqual([]);
    await expect(advanceIngest({ job_id: old.job_id, actor, role: "medical_affairs" })).rejects.toThrow("Ingestion not found");
    const fresh = await advanceIngest({ files: [file], actor, role: "medical_affairs" });
    expect(fresh.job_id).not.toBe(old.job_id);
    await expect(advanceIngest({ job_id: old.job_id, actor, role: "medical_affairs" })).rejects.toThrow("Ingestion not found");
  }));
  it("refuses clear while an ingestion transaction holds the workspace lock", async () => isolated(async (pg, schema) => {
    await pg.begin(async tx => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${`ingest:${schema}`}, 0))`;
      await expect(clearIngestedFiles()).rejects.toMatchObject({ code: "ingest_busy" });
    });
  }));
  it("requires explicit confirmation before the action clears any data", async () => isolated(async () => {
    await advanceIngest({ files: [file], actor, role: "medical_affairs" });
    const denied = await post();
    expect(denied.status).toBe(400);
    expect(await db().execute(sql`select id from source_files`)).toHaveLength(1);
    expect((await post({ confirmation: "clear_ingested_files" })).status).toBe(200);
    expect(await db().execute(sql`select id from source_files`)).toHaveLength(0);
  }));
  it("uses standalone successful run provenance when checkpoints are absent", async () => isolated(async () => {
    await ingest();
    const before = await loadState();
    expect(before.gaps.length).toBeGreaterThan(0);
    await db().execute(sql`delete from ingestion_jobs`);
    await clearIngestedFiles();
    expect((await loadState()).gaps).toEqual([]);
    expect((await loadState()).tactics).toEqual([]);
  }));
  it("preserves records when historical creation outputs are missing or malformed", async () => isolated(async () => {
    await ingest();
    const before = await loadState();
    await db().execute(sql`delete from ingestion_jobs`);
    await db().execute(sql`update module_runs set output = '{"committed_gap_ids":"truncated","committed_tactic_ids":null}'::jsonb where stage in ('S2', 'S3')`);
    await clearIngestedFiles();
    const after = await loadState();
    expect(after.sources).toEqual([]);
    expect(after.gaps.map(g => g.id)).toEqual(before.gaps.map(g => g.id));
    expect(after.tactics.map(t => t.id)).toEqual(before.tactics.map(t => t.id));
    expect(after.tactics.every(t => t.source_quote === "")).toBe(true);
  }));
  it("rolls every change back if a late source deletion fails", async () => isolated(async () => {
    await ingest();
    const before = await loadState();
    const jobs = await db().execute(sql`select * from ingestion_jobs`);
    await db().execute(sql`create function reject_clear() returns trigger language plpgsql as $$ begin raise exception 'clear failure fixture'; end $$`);
    await db().execute(sql`create trigger reject_clear before delete on sources for each row execute function reject_clear()`);
    await expect(clearIngestedFiles()).rejects.toThrow(/delete from sources/);
    expect(await loadState()).toEqual(before);
    expect(await db().execute(sql`select * from ingestion_jobs`)).toEqual(jobs);
  }));
  it("requires both workspace ownership and the reset capability", async () => isolated(async () => {
    const context = await guard.requireCustomerContext();
    for (const identity of [
      { ...context, workspace: { id: "fixture", role: "editor" } as unknown as guard.CustomerContext["workspace"] },
      { ...context, role: "viewer" as const, workspace: { id: "fixture", role: "owner" } as unknown as guard.CustomerContext["workspace"] },
    ]) {
      const spy = vi.spyOn(guard, "requireCustomerContext").mockResolvedValueOnce(identity);
      try { expect((await post({ confirmation: "clear_ingested_files" })).status).toBe(403); }
      finally { spy.mockRestore(); }
    }
  }));
  it("repairs retained manual evidence and JSON references without removing unrelated mappings or setup", async () => isolated(async () => {
    await ingest();
    const state = await loadState();
    const removedGap = state.gaps[0].id;
    const removedTactic = state.tactics[0].id;
    const who = { actor_name: actor.name, actor_function: actor.function };
    const manualGap = await createGap({ statement: "Keep my statement", ...who });
    const manualTactic = await recordMissedTactic({ name: "Keep my study", type: "registry", status: "planned", evidence_question: "Manual question", source_quote: file.text, data_source: file.title, ...who });
    await assignTacticToGap({ gap_id: manualGap, tactic_id: manualTactic, ...who });
    await db().execute(sql`update gaps set parent_gap_id = ${removedGap}, origin_gap_id = ${removedGap}, related_gap_ids = ${JSON.stringify([removedGap, manualGap])}::jsonb where id = ${manualGap}`);
    // A duplicate extraction can attach additional source evidence to manual work.
    const need = state.needs[0];
    await db().execute(sql`insert into need_gap_links (gap_id, need_id, role) values (${manualGap}, ${need.id}, 'supporting')`);
    await db().execute(sql`update gaps set new_source_need_id = ${need.id}, new_source_at = 'fixture' where id = ${manualGap}`);
    await db().execute(sql`insert into tactic_source_references values ('ref', ${manualTactic}, ${state.sources[0].id}, ${file.text}, 'quote', 'fixture')`);
    await db().execute(sql`insert into source_block_meta (block_id, source_id, origin, current_text) values ('meta', ${state.sources[0].id}, 'manual', 'source text')`);
    await db().execute(sql`insert into source_dropped_units (id, source_id, location, reason, text, created_at) values ('drop', ${state.sources[0].id}, 'p1', 'fixture', 'dropped text', 'fixture')`);
    await db().execute(sql`insert into source_stakeholder_meta (source_id) values (${state.sources[0].id})`);
    await db().execute(sql`insert into priority_placements (gap_id, axis_scores, suggested_band, suggested_rationale, at) values (${removedGap}, '{}', 'high', '', 'fixture'), (${manualGap}, '{}', 'low', '', 'fixture')`);
    await db().execute(sql`insert into timeline_activities (id, tactic_id, gap_ids, lane, start_date, end_date, depends_on, meta, updated_at) values ('remove', ${removedTactic}, ${JSON.stringify([removedGap])}::jsonb, 'lane', '2026-01-01', '2026-12-01', '[]', '{}', 'fixture'), ('keep', ${manualTactic}, ${JSON.stringify([removedGap, manualGap])}::jsonb, 'lane', '2026-01-01', '2026-12-01', '["remove"]', '{"proposed_dependencies":[{"id":"remove","reason":"source study"}],"dependency_reasons":{"remove":"source study"},"custom":"keep"}', 'fixture')`);
    const asset = state.asset;
    const objectives = state.objectives;
    await clearIngestedFiles();
    const result = await loadState();
    expect(result.asset).toEqual(asset);
    expect(result.objectives).toEqual(objectives);
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0]).toMatchObject({ id: manualGap, statement: "Keep my statement", parent_gap_id: null, origin_gap_id: null, related_gap_ids: [manualGap], new_source_need_id: null });
    expect(result.tactics[0]).toMatchObject({ id: manualTactic, source_quote: "", data_source: "" });
    expect(result.coverages).toHaveLength(1);
    expect(result.need_gap_links.every(l => l.gap_id === manualGap && result.needs.some(n => n.id === l.need_id))).toBe(true);
    expect(await db().execute(sql`select id, gap_ids, depends_on, meta from timeline_activities`)).toMatchObject([{ id: "keep", gap_ids: [manualGap], depends_on: [], meta: { proposed_dependencies: [], dependency_reasons: {}, custom: "keep" } }]);
    expect(await db().execute(sql`select gap_id from priority_placements`)).toMatchObject([{ gap_id: manualGap }]);
    for (const table of ["source_block_meta", "source_dropped_units", "source_stakeholder_meta", "tactic_source_references", "mapping_candidates", "gap_candidates", "tactic_candidates"]) expect(await db().execute(sql.raw(`select * from ${table}`))).toEqual([]);
  }));
  it("clears machine mapping candidates between retained manual endpoints while preserving their committed mapping", async () => isolated(async () => {
    await ingest();
    const who = { actor_name: actor.name, actor_function: actor.function };
    const gap = await createGap({ statement: "Manual evidence question", ...who });
    const tactic = await recordMissedTactic({ name: "Manual study", type: "registry", status: "planned", evidence_question: "Manual question", ...who });
    await assignTacticToGap({ gap_id: gap, tactic_id: tactic, ...who });
    await db().execute(sql`insert into mapping_candidates (id, run_id, gap_id, tactic_id, score, confidence, rationale, verdict, proposer, created_at)
      values ('retained-endpoints', 'fixture-run', ${gap}, ${tactic}, 75, 80, '{"reason":"Source-derived proposal"}', 'accept', 'fixture', 'fixture')`);
    const before = (await loadState()).coverages.filter(c => c.gap_id === gap && c.tactic_id === tactic);
    expect(before).toHaveLength(1);
    await clearIngestedFiles();
    const after = await loadState();
    expect(after.gaps.map(g => g.id)).toEqual([gap]);
    expect(after.tactics.map(t => t.id)).toEqual([tactic]);
    expect(after.coverages).toEqual(before);
    expect(await db().execute(sql`select * from mapping_candidates`)).toEqual([]);
  }));
  it("preserves manual tactic fields when only text or source-title coincidence exists", async () => isolated(async () => {
    await ingest();
    const who = { actor_name: actor.name, actor_function: actor.function };
    const quote = "comparative evidence";
    const overlap = await recordMissedTactic({ name: "External registry", type: "registry", status: "planned", evidence_question: "Manual question", source_quote: quote, data_source: "External registry", ...who });
    const title = await recordMissedTactic({ name: "Unrelated manual study", type: "registry", status: "planned", evidence_question: "Manual question", source_quote: "Independently authored quote", data_source: file.title, ...who });
    expect(await db().execute(sql`select * from tactic_source_references where tactic_id in (${overlap}, ${title})`)).toEqual([]);
    await clearIngestedFiles();
    const tactics = (await loadState()).tactics;
    expect(tactics.find(t => t.id === overlap)).toMatchObject({ source_quote: quote, data_source: "External registry" });
    expect(tactics.find(t => t.id === title)).toMatchObject({ source_quote: "Independently authored quote", data_source: file.title });
  }));
  it.each(["S0", "S1", "S2", "S3", "S4"] as const)("refuses standalone %s while clear's workspace lock is held", async (stage) => isolated(async (pg, schema) => {
    await ingest();
    const before = await loadState();
    await pg.begin(async tx => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${`ingest:${schema}`}, 0))`;
      const response = await modulePost(new Request("http://localhost/api/modules", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ stage, input: {} }) }));
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "ingest_busy" });
    });
    expect(await loadState()).toEqual(before);
    const failures = await db().execute(sql`select status, error from module_runs where stage = ${stage} and status = 'error'`);
    expect(failures).toEqual([{ status: "error", error: expect.stringContaining("still running") }]);
  }));
  it("rolls back standalone stage writes and preserves the failed run record", async () => isolated(async () => {
    await ingest();
    const before = await loadState();
    const original = kgMappingModule.run;
    const spy = vi.spyOn(kgMappingModule, "run").mockImplementationOnce(async (input, ctx) => {
      await original(input, ctx);
      throw new Error("standalone failure after mapping writes");
    });
    try {
      const response = await modulePost(new Request("http://localhost/api/modules", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ stage: "S4", input: {} }) }));
      expect(response.status).toBe(400);
    } finally { spy.mockRestore(); }
    expect(await loadState()).toEqual(before);
    expect(await db().execute(sql`select * from mapping_candidates`)).toEqual([]);
    expect(await db().execute(sql`select status, error from module_runs where stage = 'S4' and status = 'error'`)).toEqual([{ status: "error", error: "standalone failure after mapping writes" }]);
  }));
  it("coordinates a real standalone S4 API run with clear after its workspace snapshot is read", async () => isolated(async () => {
    await ingest();
    const before = await loadState();
    const who = { actor_name: actor.name, actor_function: actor.function };
    const manualGap = await createGap({ statement: "Comparative evidence is missing", ...who });
    const manualTactic = await recordMissedTactic({ name: "Comparative evidence study", type: "registry", status: "planned", evidence_question: "Comparative evidence is missing", ...who });
    let resume!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { resume = resolve; });
    const paused = new Promise<void>(resolve => { entered = resolve; });
    const original = kgMappingModule.run;
    const spy = vi.spyOn(kgMappingModule, "run").mockImplementationOnce(async (input, ctx) => {
      // runStage has already frozen the real workspace facts at this point.
      entered();
      await gate;
      return original(input, ctx);
    });
    const running = modulePost(new Request("http://localhost/api/modules", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ stage: "S4", input: {} }) }));
    let cleared: Response | undefined;
    let result: Response;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Concurrent clear did not complete while S4 was paused")), 5_000);
    });
    try {
      await Promise.race([paused, running.then(() => { throw new Error("S4 returned before reaching the pause"); }), deadline]);
      cleared = await Promise.race([post({ confirmation: "clear_ingested_files" }), deadline]);
    } finally {
      clearTimeout(timer);
      resume();
      try { result = await running; } finally { spy.mockRestore(); }
    }
    expect(cleared?.status).toBe(409);
    expect(await cleared!.json()).toMatchObject({ code: "ingest_busy" });
    expect(result!.status).toBe(200);
    const candidates = await db().execute(sql`select gap_id, tactic_id from mapping_candidates`);
    expect(candidates.some(c => c.gap_id === manualGap && c.tactic_id === manualTactic)).toBe(true);
    expect(candidates.some(c => c.gap_id === before.gaps[0].id)).toBe(true);
    expect((await post({ confirmation: "clear_ingested_files" })).status).toBe(200);
    expect(await db().execute(sql`select * from mapping_candidates`)).toEqual([]);
    const after = await loadState();
    expect(after.sources).toEqual([]);
    expect(after.gaps.map(g => g.id)).toEqual([manualGap]);
    expect(after.tactics.map(t => t.id)).toEqual([manualTactic]);
    expect(after.coverages.every(c => c.gap_id === manualGap && c.tactic_id === manualTactic)).toBe(true);
  }));
  it("leaves another workspace's current source data intact", async () => isolated(async () => {
    await ingest();
    const before = await loadState();
    await isolated(async () => { await ingest(); await clearIngestedFiles(); expect((await loadState()).sources).toEqual([]); });
    expect(await loadState()).toEqual(before);
  }));

});
