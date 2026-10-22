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
import { currentSchemaName, withWorkspaceTransaction } from "@/lib/iegp/db";
import { runInWorkspace } from "@/modules/workspaces/context";
import { commitExtractedRecords, createGap, loadState, recordMissedTactic } from "@/lib/iegp/store";
import * as guard from "@/modules/auth/api-guard";
import { assignTacticToGap, lockCoverageDimension, lockCoverageOverall, confirmCoverageReview, acceptMapping, saveMappingTableRow } from "@/lib/iegp/store";
import { lockRelationships } from "@/lib/iegp/relationship-change";
import { relationshipSnapshot, relationshipVersion } from "@/lib/iegp/relationship-version";
import { suppliedJudgementRecords } from "@/lib/iegp/judgement-references";
import { tacticEditVersion } from "@/lib/iegp/tactic-edit-version";
import { relationshipFit, gapEligibleForMapping } from "@/lib/iegp/engine";
import { acceptTacticExpansion, setExpansionStatus, tacticVersion } from "@/lib/iegp/tactic-expansions";
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
/** Real manual endpoints and standalone S4 writes; no fabricated ownership. */
async function automatedMapping() {
  const who = { actor_name: actor.name, actor_function: actor.function };
  const gap_id = await createGap({ statement: "Comparative evidence is missing", ...who });
  const tactic_id = await recordMissedTactic({ name: "Comparative evidence study", type: "registry", status: "planned", evidence_question: "Comparative evidence is missing", ...who });
  const response = await modulePost(new Request("http://localhost/api/modules", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ stage: "S4", input: { gap_ids: [gap_id], tactic_ids: [tactic_id] } }) }));
  expect(response.status).toBe(200);
  const row = (await loadState()).coverages.find(c => c.gap_id === gap_id && c.tactic_id === tactic_id)!;
  expect(row).toBeDefined();
  return { gap_id, tactic_id, row, who };
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
    await assignTacticToGap({ note: "The study informs this gap assessment", gap_id: manualGap, tactic_id: manualTactic, ...who });
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
    await assignTacticToGap({ note: "The study informs this gap assessment", gap_id: gap, tactic_id: tactic, human: true, ...who });
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
    // Ingestion may already own S1 comparison errors; identify this request's run.
    const previousRuns = await db().execute(sql`select id from module_runs where stage = ${stage}`);
    const previousRunIds = new Set(previousRuns.map(run => run.id));
    await pg.begin(async tx => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${`ingest:${schema}`}, 0))`;
      const response = await modulePost(new Request("http://localhost/api/modules", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ stage, input: {} }) }));
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "ingest_busy" });
    });
    expect(await loadState()).toEqual(before);
    const runs = await db().execute(sql`select id, stage, status, error from module_runs where stage = ${stage}`);
    const deniedRuns = runs.filter(run => !previousRunIds.has(run.id));
    expect(deniedRuns).toEqual([{ id: expect.any(String), stage, status: "error", error: expect.stringContaining("still running") }]);
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
    const mapped = (await loadState()).coverages.find(c => c.gap_id === manualGap && c.tactic_id === manualTactic)!;
    expect(mapped).toBeDefined();
    expect((await loadState()).gaps.find(g => g.id === manualGap)?.status).toBe("validated_partial");
    await clearIngestedFiles();
    expect(await db().execute(sql`select * from mapping_candidates`)).toEqual([]);
    const after = await loadState();
    expect(after.sources).toEqual([]);
    expect(after.gaps.map(g => g.id)).toEqual([manualGap]);
    expect(after.tactics.map(t => t.id)).toEqual([manualTactic]);
    expect(after.coverages.map(c => c.id)).not.toContain(mapped.id);
    expect(after.gaps.find(g => g.id === manualGap)?.status).toBe("validated_open");
  }));
  it.each(["dimension", "overall", "confirm", "accept", "save", "confirm-noop", "save-noop"])("retains the exact S4 relationship after explicit human %s", async action => isolated(async () => {
    const { gap_id, tactic_id, row, who } = await automatedMapping();
    expect(row.creation_run_id).toEqual(expect.any(String));
    expect(row.human_adopted).toBe(false);
    const reason = "Reviewed this exact relationship and retain the mapping";
    if (action === "dimension") await lockCoverageDimension({ coverage_id: row.id, dimension: "population", value: "yes", rationale: reason, ...who });
    if (action === "overall") await lockCoverageOverall({ coverage_id: row.id, overall: "partial", rationale: reason, ...who });
    if (action === "confirm") await db().execute(sql`update coverages set needs_review = true where id = ${row.id}`);
    if (action.startsWith("confirm")) await confirmCoverageReview({ coverage_id: row.id, note: reason, ...who });
    if (action === "accept") await acceptMapping({ gap_id, tactic_id, note: reason, ...who });
    if (action.startsWith("save")) {
      await saveMappingTableRow({ gap_id, tactic_ids: [tactic_id], mapping_status: "partially_addressed", rationale: reason, ...who });
      if (action === "save-noop") {
        await db().execute(sql`update coverages set human_adopted = false where id = ${row.id}`);
        await saveMappingTableRow({ gap_id, tactic_ids: [tactic_id], mapping_status: "partially_addressed", rationale: reason, ...who });
      }
    }
    expect((await loadState()).coverages.find(c => c.id === row.id)?.human_adopted).toBe(true);
    await clearIngestedFiles();
    expect((await loadState()).coverages.find(c => c.id === row.id)).toMatchObject({ creation_run_id: row.creation_run_id, human_adopted: true });
  }));
  it("retains an explicitly accepted model-origin judgement", async () => isolated(async () => {
    const { gap_id, tactic_id, row, who } = await automatedMapping();
    const state = await loadState();
    await acceptMapping({ gap_id, tactic_id, model: true,
      supplied_records: suppliedJudgementRecords(state, [gap_id]),
      expected_tactic_version: tacticEditVersion(state.tactics.find(t => t.id === tactic_id)!),
      references: [{ entity_type: "gap", entity_id: gap_id, reason: "The supplied gap describes the comparative evidence need" }],
      note: "Explicitly accept the model's comparative evidence judgement", ...who });
    expect((await loadState()).coverages.find(c => c.id === row.id)).toMatchObject({ human_adopted: true, assessment_origin: row.assessment_origin });
    await clearIngestedFiles();
    expect((await loadState()).coverages.map(c => c.id)).toContain(row.id);
  }));
  it.each(["accept_mapping", "map_tactic"] as const)("retains a relationship explicitly selected through public S5 %s", async action => isolated(async () => {
    const { gap_id, tactic_id, row } = await automatedMapping();
    if (action === "map_tactic") await clearIngestedFiles();
    const before = await loadState();
    const editsBefore = await db().execute(sql`select id from edit_records where entity_type = 'gap_tactic'`);
    const response = await modulePost(new Request("http://localhost/api/modules", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ stage: "S5", input: {
      action, gap_id, tactic_id, expected_relationship: relationshipVersion(relationshipSnapshot(before, gap_id, tactic_id)), rationale: "Human explicitly selected this comparative evidence mapping",
    } }) }));
    expect(response.status).toBe(200);
    const selected = (await loadState()).coverages.find(c => c.gap_id === gap_id && c.tactic_id === tactic_id)!;
    expect(selected.human_adopted).toBe(true);
    if (action === "accept_mapping") expect(selected.id).toBe(row.id);
    else expect(selected.creation_run_id).toBeNull();
    expect(await db().execute(sql`select id from edit_records where entity_type = 'gap_tactic'`)).toHaveLength(editsBefore.length + 1);
    await clearIngestedFiles();
    expect((await loadState()).coverages.map(c => c.id)).toContain(selected.id);
  }));
  it.each([false, true])("adopts whitespace-padded mapping-table IDs, including unchanged save: %s", async unchanged => isolated(async () => {
    const { gap_id, tactic_id, row, who } = await automatedMapping();
    const save = () => saveMappingTableRow({ gap_id, tactic_ids: [` ${tactic_id} `], mapping_status: "partially_addressed", rationale: "Human retained this exact mapping with normalized IDs", ...who });
    if (unchanged) {
      await save();
      await db().execute(sql`update coverages set human_adopted = false where id = ${row.id}`);
    }
    await save();
    expect((await loadState()).coverages.find(c => c.id === row.id)?.human_adopted).toBe(true);
    await clearIngestedFiles();
    expect((await loadState()).coverages.map(c => c.id)).toContain(row.id);
  }));
  it("resolves an ownership warning before explaining a later sibling review", async () => isolated(async () => {
    const { gap_id, tactic_id, row, who } = await automatedMapping();
    await db().execute(sql`update coverages set creation_run_id = null where id = ${row.id}`);
    await clearIngestedFiles();
    expect(relationshipFit(await loadState(), gap_id, tactic_id).review_reasons.join(" ")).toMatch(/ownership could not be established/);
    await confirmCoverageReview({ coverage_id: row.id, note: "Reviewed and retained this legacy relationship", ...who });
    expect((await loadState()).coverages.find(c => c.id === row.id)).toMatchObject({ needs_review: false, human_adopted: true, ownership_review_reason: null });
    const otherGap = await createGap({ statement: "Independent comparative evidence is missing", ...who });
    const sibling = await assignTacticToGap({ gap_id: otherGap, tactic_id, human: true, note: "Human selected an independent mapping", ...who });
    await lockCoverageDimension({ coverage_id: sibling, dimension: "population", value: "yes", rationale: "Reviewed the independent population", ...who });
    const state = await loadState();
    expect(state.coverages.find(c => c.id === row.id)?.needs_review).toBe(true);
    const reasons = relationshipFit(state, gap_id, tactic_id).review_reasons.join(" ");
    expect(reasons).toMatch(/sibling assessment changed/);
    expect(reasons).not.toMatch(/ownership could not be established/);
  }));
  it.each(["overall", "dimension", "historical-overall", "historical-dimension"])("retains a proven S4 relationship with %s human lock evidence when its adoption marker is absent", async kind => isolated(async () => {
    const { row, who } = await automatedMapping();
    if (kind.endsWith("overall")) await lockCoverageOverall({ coverage_id: row.id, overall: "partial", rationale: "Human reviewed this evidence scope", ...who });
    else await lockCoverageDimension({ coverage_id: row.id, dimension: "population", value: "yes", rationale: "Human reviewed this population", ...who });
    const reviewed = (await loadState()).coverages.find(c => c.id === row.id)!;
    await db().execute(sql`update coverages set human_adopted = false where id = ${row.id}`);
    if (kind.startsWith("historical")) {
      const history = [{ overall_lock: reviewed.overall_lock, dimensions: reviewed.dimensions }];
      await db().execute(sql`update coverages set overall_lock = ${JSON.stringify(row.overall_lock)}::jsonb,
        dimensions = ${JSON.stringify(row.dimensions)}::jsonb, assessment_history = ${JSON.stringify(history)}::jsonb where id = ${row.id}`);
    }
    await clearIngestedFiles();
    expect((await loadState()).coverages.map(c => c.id)).toContain(row.id);
  }));
  it("preserves a pre-existing human relationship unchanged when actual S4 assesses the same pair", async () => isolated(async () => {
    const { gap_id, tactic_id, row, who } = await automatedMapping();
    // Remove only this fixture's automated row, then create a genuine human mapping.
    await clearIngestedFiles();
    const id = await assignTacticToGap({ gap_id, tactic_id, human: true, coverage: "partial", note: "Human originally chose this comparative study", ...who });
    const before = (await loadState()).coverages.find(c => c.id === id)!;
    expect(id).not.toBe(row.id);
    const response = await modulePost(new Request("http://localhost/api/modules", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ stage: "S4", input: { gap_ids: [gap_id], tactic_ids: [tactic_id] } }) }));
    expect(response.status).toBe(200);
    expect((await loadState()).coverages.find(c => c.id === id)).toEqual(before);
    await clearIngestedFiles();
    expect((await loadState()).coverages.find(c => c.id === id)).toEqual(before);
  }));
  it("does not adopt an automated sibling when a person reviews a different relationship", async () => isolated(async () => {
    const { row, tactic_id, who } = await automatedMapping();
    const otherGap = await createGap({ statement: "Independent comparative evidence is missing", ...who });
    const sibling = await assignTacticToGap({ gap_id: otherGap, tactic_id, human: true, note: "Human picked the independent mapping", ...who });
    await lockCoverageDimension({ coverage_id: sibling, dimension: "population", value: "yes", rationale: "Reviewed only the independent population", ...who });
    expect((await loadState()).coverages.find(c => c.id === row.id)).toMatchObject({ needs_review: true, human_adopted: false });
    await clearIngestedFiles();
    expect((await loadState()).coverages.map(c => c.id)).toEqual([sibling]);
  }));
  it.each(["missing", "malformed", "failed", "wrong-stage", "wrong-workspace"])("preserves %s creation provenance and exposes a visible ownership review reason", async kind => isolated(async () => {
    const { gap_id, tactic_id, row } = await automatedMapping();
    if (kind === "missing") await db().execute(sql`update coverages set creation_run_id = null where id = ${row.id}`);
    if (kind === "malformed") await db().execute(sql`update coverages set creation_run_id = '{truncated' where id = ${row.id}`);
    if (kind === "failed") await db().execute(sql`update module_runs set status = 'error' where id = ${row.creation_run_id}`);
    if (kind === "wrong-stage") await db().execute(sql`update module_runs set stage = 'S3' where id = ${row.creation_run_id}`);
    if (kind === "wrong-workspace") await db().execute(sql`update module_runs set workspace_id = 'another-workspace' where id = ${row.creation_run_id}`);
    await clearIngestedFiles();
    const state = await loadState();
    expect(state.coverages.find(c => c.id === row.id)).toMatchObject({ needs_review: true, stale: false, overall: row.overall, human_adopted: false });
    expect(relationshipFit(state, gap_id, tactic_id).review_reasons.join(" ")).toMatch(/ownership could not be established/);
  }));
  it("preserves an existing expansion placeholder assessed in place by actual S4", async () => isolated(async () => {
    const { gap_id, tactic_id } = await automatedMapping();
    const tactic = (await loadState()).tactics.find(t => t.id === tactic_id)!;
    const child = await acceptTacticExpansion({ proposal_id: "clear-expansion", gap_id, tactic_id, expected_tactic_version: tacticVersion(tactic), actor,
      rationale: "Explicitly accept the comparative subgroup scope",
      scope: { name: "Comparative evidence subgroup", evidence_question: "Comparative evidence is missing", population: "Subgroup patients", outcomes: "Comparative evidence", geography: "UK", data_cut: "2026", analysis: "Comparative subgroup", instrument: "", study_design: "Registry", gap_coverage: "Comparative evidence", cost_effort: "One analyst", timing: "2026", feasibility_risks: "Small subgroup", post_hoc: false, prospective_enrolment: false, protocol_amendment: false, start_date: null, evidence_available: null } });
    await setExpansionStatus({ expansion_id: child.id, status: "planned", rationale: "Scope funded", actor, expected_version: child.version });
    const placeholder = (await loadState()).coverages.find(c => c.expansion_id === child.id)!;
    expect(placeholder).toMatchObject({ creation_run_id: null, human_adopted: true, overall: "unassessed" });
    const response = await modulePost(new Request("http://localhost/api/modules", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ stage: "S4", input: { gap_ids: [gap_id], expansion_ids: [child.id] } }) }));
    expect(response.status).toBe(200);
    const assessed = (await loadState()).coverages.find(c => c.id === placeholder.id)!;
    expect(assessed.overall).not.toBe("unassessed");
    expect(assessed).toMatchObject({ creation_run_id: null, human_adopted: true });
    await clearIngestedFiles();
    expect((await loadState()).coverages.map(c => c.id)).toContain(placeholder.id);
  }));
  it("restores eligibility repeatedly after real S4 clear and reingest cycles", async () => isolated(async () => {
    const { gap_id, tactic_id, row } = await automatedMapping();
    await clearIngestedFiles();
    await clearIngestedFiles();
    let state = await loadState();
    expect(state.coverages.map(c => c.id)).not.toContain(row.id);
    expect(state.gaps.find(g => g.id === gap_id)?.status).toBe("validated_open");
    expect(gapEligibleForMapping(state.gaps.find(g => g.id === gap_id)!.status)).toBe(true);
    await ingest();
    const response = await modulePost(new Request("http://localhost/api/modules", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ stage: "S4", input: { gap_ids: [gap_id], tactic_ids: [tactic_id] } }) }));
    expect(response.status).toBe(200);
    const next = (await loadState()).coverages.find(c => c.gap_id === gap_id && c.tactic_id === tactic_id)!;
    expect(next.id).not.toBe(row.id);
    await clearIngestedFiles();
    state = await loadState();
    expect(state.coverages.map(c => c.id)).not.toContain(next.id);
    expect(state.gaps.find(g => g.id === gap_id)?.status).toBe("validated_open");
  }));
  it("rolls back ownership warnings, relationship deletion and status when late deletion fails", async () => isolated(async () => {
    await ingest();
    const { row } = await automatedMapping();
    // A separate legacy relationship exercises the warning write in the same transaction.
    const legacy = await automatedMapping();
    await db().execute(sql`update coverages set creation_run_id = null where id = ${legacy.row.id}`);
    const before = await loadState();
    expect(before.coverages.map(c => c.id)).toContain(row.id);
    await db().execute(sql`create function reject_clear() returns trigger language plpgsql as $$ begin raise exception 'ownership rollback fixture'; end $$`);
    await db().execute(sql`create trigger reject_clear before delete on sources for each row execute function reject_clear()`);
    await expect(clearIngestedFiles()).rejects.toThrow(/delete from sources/);
    expect(await loadState()).toEqual(before);
  }));
  it("waits for a human review transaction and preserves the exact adopted relationship", async () => isolated(async (pg, schema) => {
    const { row, who } = await automatedMapping();
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const review = withWorkspaceTransaction(async () => {
      await lockRelationships();
      await confirmCoverageReview({ coverage_id: row.id, note: "Explicitly retain this mapping", ...who });
      entered();
      await gate;
    });
    await held;
    const clearing = clearIngestedFiles();
    try {
      await vi.waitFor(async () => {
        const waiting = await pg`select a.pid from pg_stat_activity a join pg_locks l on l.pid = a.pid where a.datname = current_database() and l.locktype = 'advisory' and not l.granted and a.query like '%gap-tactic relationships%'`;
        expect(waiting.length).toBeGreaterThan(0);
      }, { timeout: 3000, interval: 20 });
    } finally { release(); await review; await clearing; }
    expect((await loadState()).coverages.find(c => c.id === row.id)).toMatchObject({ human_adopted: true });
    expect(await currentSchemaName()).toBe(schema);
  }));
  it("leaves another workspace's source data and exact relationships intact", async () => isolated(async () => {
    await ingest();
    await automatedMapping();
    const before = await loadState();
    await isolated(async () => {
      await ingest();
      const { row } = await automatedMapping();
      await clearIngestedFiles();
      const cleared = await loadState();
      expect(cleared.sources).toEqual([]);
      expect(cleared.coverages.map(c => c.id)).not.toContain(row.id);
    });
    expect(await loadState()).toEqual(before);
  }));

});
