/** Regression coverage for recoverable ingestion using disposable workspace schemas. */
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";

// The legacy gap race needs two application transactions to reach PostgreSQL.
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
import { advanceIngest } from "@/app/api/iegp/ingest-pipeline";
import { POST } from "@/app/api/iegp/route";
import { db } from "@/modules/kernel/db";
import { modelRunTimeoutMs } from "@/modules/kernel/model-timeout";
import * as kernel from "@/modules/kernel/run";
import { runStage } from "@/modules/kernel/run";
import { validationModule } from "@/modules/stages/s5-validation/module";
import { validatePlacement } from "@/modules/stages/s8-prioritization/module";
import type { TacticExtractOutput } from "@/modules/stages/s3-tactic-extract/module";
import * as store from "@/lib/iegp/store";
import { createGap, loadState, recordMissedTactic } from "@/lib/iegp/store";
import { currentSchemaName, inWorkspaceTransaction, withWorkspaceTransaction } from "@/lib/iegp/db";
import { tacticEditVersion } from "@/lib/iegp/tactic-edit-version";
import { runInWorkspace } from "@/modules/workspaces/context";
import * as uploads from "@/modules/stages/s0-upload/module";
import { listSourceFiles } from "@/modules/stages/s0-upload/module";
import { listParsedDocuments, parseModule } from "@/modules/stages/s1-parse/module";
import { gapExtractModule } from "@/modules/stages/s2-gap-extract/module";
import { ingestionJobs } from "@/lib/ingest/schema";
import { DEMO_PACK } from "@/lib/iegp/demo-pack";
import { setAiSection } from "@/modules/kernel/ai-switch";
import { completedIngestSourceIds } from "@/lib/ingest/status";

const actor = { name: "Ingestion test", function: "medical_affairs" } as const;
const file = { filename: "recovery.txt", title: "Recovery test", source_type: "advisory_board", stakeholder_function: "market_access", text: "Payers need comparative evidence versus standard of care. A registry study will collect real-world persistence data." } as const;
const args = { files: [file], actor, role: "medical_affairs" } as const;

async function isolated(test: (pg: ReturnType<typeof postgres>, schema: string) => Promise<void>) {
  const pg = postgres(process.env.DATABASE_URL!, { max: 1, connection: { client_min_messages: "warning" } });
  const schema = `ws_ingest_${randomBytes(8).toString("hex")}`;
  try {
    await runInWorkspace({ workspace_id: schema, schema }, async () => {
      await currentSchemaName();
      await test(pg, schema);
    });
  } finally {
    await pg.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pg.end();
  }
}

/** Commit an editor change after the other connection completes or is waiting on it. */
async function raceGapEdit<T>(
  pg: ReturnType<typeof postgres>,
  edit: (tx: postgres.TransactionSql) => Promise<unknown>,
  run: () => Promise<T>,
) {
  let pending: Promise<PromiseSettledResult<T>> | undefined;
  let finished = false;
  try {
    const blocked = await pg.begin(async tx => {
      await edit(tx);
      pending = Promise.allSettled([run()]).then(([result]) => {
        finished = true;
        return result;
      });
      const deadline = Date.now() + 5_000;
      while (!finished && Date.now() < deadline) {
        const [activity] = await tx<{ blocked: boolean }[]>`
          select exists (
            select 1 from pg_stat_activity
            where pg_backend_pid() = any(pg_blocking_pids(pid))
          ) as blocked
        `;
        if (activity.blocked) return true;
        await delay(10);
      }
      if (!finished) throw new Error("The stage neither finished nor waited for the editor");
      return false;
    });
    return { blocked, result: (await pending)! };
  } finally {
    await pending;
  }
}

async function post(body: Record<string, unknown>) {
  return POST(new Request("http://localhost/api/iegp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "ingest", actor_name: actor.name, actor_function: actor.function, incremental: "true", ...body }) }));
}

describe("KAN-110 ingestion checkpoints", () => {
  it("advances one stage at a time and retries completed payloads without duplicating work", async () => isolated(async () => {
    const first = await advanceIngest({ ...args, files: [...args.files] });
    expect(first).toMatchObject({ completed: 1, total: 5, done: false, stage: "S1" });
    expect(await listSourceFiles()).toHaveLength(1);
    expect(await listParsedDocuments()).toHaveLength(0);
    expect(await completedIngestSourceIds()).toEqual(new Set());
    // Retrying the original request also finds the saved job after a lost response.
    let next = await advanceIngest({ ...args, files: [...args.files] });
    expect(next).toMatchObject({ job_id: first.job_id, completed: 2, stage: "S2" });
    expect(await listParsedDocuments()).toHaveLength(1);
    while (!next.done) next = await advanceIngest({ actor, role: args.role, job_id: first.job_id });
    // Comparison has its own observable provider run; pipeline stages still execute once.
    const runs = await db().execute(sql`select stage from module_runs where module_id <> 'incoming-source-comparison' order by stage`);
    const allRuns = await db().execute(sql`select id, module_id from module_runs order by id`);
    expect(allRuns.filter(row => row.module_id === "incoming-source-comparison")).toHaveLength(1);
    expect(runs.map((row) => row.stage)).toEqual(["S0", "S1", "S2", "S3", "S4"]);
    expect((await completedIngestSourceIds()).size).toBe(1);
    expect(await advanceIngest({ ...args, files: [...args.files] })).toEqual(next);
    expect(await advanceIngest({ ...args, files: [{ ...file, title: "Renamed", filename: "renamed.txt" }] })).toEqual(next);
    expect(await db().execute(sql`select id, module_id from module_runs order by id`)).toEqual(allRuns);
    const invalidDuplicate = await post({ ...file, source_type: "invalid" });
    expect(invalidDuplicate.status).toBe(400);
    expect(JSON.stringify((await db().select().from(ingestionJobs))[0])).not.toContain(file.text);
  }));

  it("rolls back stage writes and resumes from the preceding checkpoint after a failure", async () => isolated(async () => {
    const first = await advanceIngest({ ...args, files: [...args.files] });
    const original = parseModule.run;
    const spy = vi.spyOn(parseModule, "run").mockImplementationOnce(async (input, ctx) => {
      await original(input, ctx);
      throw new Error("injected failure after parse writes");
    });
    try {
      await expect(advanceIngest({ actor, role: args.role, job_id: first.job_id })).rejects.toThrow("injected failure");
      expect(await listParsedDocuments()).toHaveLength(0);
      expect((await listSourceFiles())[0].status).toBe("uploaded");
      expect((await db().select().from(ingestionJobs))[0].checkpoint).toMatchObject({ completed: 1 });
    } finally { spy.mockRestore(); }
    expect(await advanceIngest({ actor, role: args.role, job_id: first.job_id })).toMatchObject({ completed: 2, stage: "S2" });
    expect(await listParsedDocuments()).toHaveLength(1);
  }));

  it("releases the database during extraction, fences a concurrent retry and preserves an intervening edit", async () => isolated(async (pg, schema) => {
    const first = await advanceIngest({ ...args, files: [...args.files] });
    const resume = () => advanceIngest({ actor, role: args.role, job_id: first.job_id });
    await resume();
    const original = gapExtractModule.run;
    let entered!: (inTransaction: boolean) => void;
    let release!: () => void;
    const started = new Promise<boolean>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const spy = vi.spyOn(gapExtractModule, "run").mockImplementationOnce(async (input, ctx) => {
      entered(inWorkspaceTransaction());
      await gate;
      return original(input, ctx);
    });
    const pending = resume();
    try {
      expect(await started).toBe(false);
      await expect(resume()).rejects.toMatchObject({ code: "ingest_busy" });
      await pg.unsafe(`update "${schema}".sources set title='Human-reviewed fictional cohort'`);
      release();
      await expect(pending).rejects.toMatchObject({ code: "stage_inputs_changed" });
      expect(await db().execute(sql`select title from sources`)).toEqual([{ title: "Human-reviewed fictional cohort" }]);
      expect(await db().execute(sql`select id from gap_candidates`)).toHaveLength(0);
      expect((await db().select().from(ingestionJobs))[0].checkpoint).toMatchObject({ completed: 2 });
      expect(await resume()).toMatchObject({ completed: 3 });
    } finally { release(); await pending.catch(() => undefined); spy.mockRestore(); }
  }));

  it("reuses the latest parsed document from the S1 snapshot while parsing another uploaded file", async () => isolated(async () => {
    const first = await advanceIngest({ ...args, files: [file] });
    const second = await advanceIngest({ ...args, files: [file, { ...file, filename: "other.txt", text: "Another fictional cohort needs evidence on long-term access." }] });
    await advanceIngest({ actor, role: args.role, job_id: first.job_id });
    const [existing] = await listParsedDocuments();
    // An explicit direct reparse is supported. Ingestion must use its latest version only.
    const originalRun = kernel.runStage;
    let latestId = "";
    const competing = vi.spyOn(kernel, "runStage").mockImplementationOnce(async options => {
      await originalRun({ stage: "S1", input: { file_ids: [existing.file_id] }, actor, role: args.role });
      latestId = (await listParsedDocuments())[0].id;
      return originalRun(options);
    });
    try { await advanceIngest({ actor, role: args.role, job_id: second.job_id }); }
    finally { competing.mockRestore(); }
    expect(latestId).not.toBe(existing.id);
    const [checkpoint] = await db().execute(sql`select checkpoint->'document_ids' as ids from ingestion_jobs where id = ${second.job_id}`);
    expect(checkpoint.ids).toHaveLength(2);
    expect(checkpoint.ids).toContain(latestId);
    expect(await listParsedDocuments()).toHaveLength(3);
  }));

  it("advances a reuse-only parse without attributing old warnings to the new run", async () => isolated(async () => {
    const other = { ...file, filename: "other.txt", text: "Fictional second cohort enrollment." };
    const first = await advanceIngest({ ...args, files: [file, other] });
    await advanceIngest({ actor, role: args.role, job_id: first.job_id });
    const uploaded = (await listSourceFiles()).find(row => row.filename === file.filename)!;
    const existing = (await listParsedDocuments()).find(row => row.file_id === uploaded.id)!;
    const signals = () => db().execute(sql`select source_run_id from hillclimb_signals
      where stage = 'S1' and kind = 'parse_quality' and subject = ${`document:${existing.id}`}`);
    expect(existing.quality.warnings.length).toBeGreaterThan(0);
    const before = await signals();
    expect(before).toHaveLength(1);

    const next = await advanceIngest({ ...args, files: [file] });
    expect(next.job_id).not.toBe(first.job_id);
    const read = vi.spyOn(uploads, "sourceFileContent");
    try {
      expect(await advanceIngest({ actor, role: args.role, job_id: next.job_id }))
        .toMatchObject({ completed: 2, stage: "S2" });
      expect(read).not.toHaveBeenCalled();
      const [checkpoint] = await db().execute(sql`select checkpoint->'document_ids' as ids
        from ingestion_jobs where id = ${next.job_id}`);
      expect(checkpoint.ids).toEqual([existing.id]);
      expect(await signals()).toEqual(before);
    } finally {
      read.mockRestore();
    }
  }));

  it("loads each S1 payload outside the snapshot after processing the previous file", async () => isolated(async () => {
    await advanceIngest({ ...args, files: [file, { ...file, filename: "other.txt", text: "Fictional second source." }] });
    const ids = (await listSourceFiles()).map(row => row.id);
    const events: string[] = [];
    const read = uploads.sourceFileContent;
    const reads = vi.spyOn(uploads, "sourceFileContent").mockImplementation(async (...args) => {
      events.push(`read:${args[0]}:${inWorkspaceTransaction()}`);
      return read(...args);
    });
    const run = parseModule.run;
    const parser = vi.spyOn(parseModule, "run").mockImplementationOnce(async (input, ctx) => {
      const note = ctx.run.note.bind(ctx.run);
      vi.spyOn(ctx.run, "note").mockImplementation((...args) => {
        if (args[0].startsWith("dry-parsed:")) events.push(args[0]);
        return note(...args);
      });
      return run(input, ctx);
    });
    try {
      await runStage({ stage: "S1", input: { dry_run: true, file_ids: ids }, actor, role: args.role });
      expect(events).toEqual(ids.flatMap(id => [`read:${id}:false`, `dry-parsed:${id}`]));
    } finally { reads.mockRestore(); parser.mockRestore(); }
  }));

  it("rejects a file changed after capture before parsing its replacement payload", async () => isolated(async (pg, schema) => {
    const first = await advanceIngest({ ...args, files: [file] });
    const run = parseModule.run;
    let parsedReplacement = false;
    const parser = vi.spyOn(parseModule, "run").mockImplementationOnce(async (input, ctx) => {
      await pg.unsafe(`update "${schema}".source_files set content_base64=$1`, [Buffer.from("Replacement fictional payload").toString("base64")]);
      const step = vi.spyOn(ctx.run, "step");
      try { return await run(input, ctx); }
      finally { parsedReplacement = step.mock.calls.some(([name]) => name.startsWith("parse:")); }
    });
    try {
      await expect(advanceIngest({ job_id: first.job_id, actor, role: args.role })).rejects.toMatchObject({ code: "stage_inputs_changed" });
      expect(parsedReplacement).toBe(false);
      expect(await listParsedDocuments()).toHaveLength(0);
      expect((await db().select().from(ingestionJobs))[0].checkpoint).toMatchObject({ completed: 1 });
    } finally { parser.mockRestore(); }
  }));

  it("leaves a legacy unnumbered gap unchanged after failed computation", async () => isolated(async () => {
    const gap = await createGap({ statement: "A fictional legacy gap", actor_name: actor.name, actor_function: actor.function });
    await db().execute(sql`update gaps set number=null where id=${gap}`);
    const spy = vi.spyOn(gapExtractModule, "run").mockRejectedValueOnce(new Error("fixture failure"));
    try {
      await expect(runStage({ stage: "S2", input: {}, actor, role: args.role })).rejects.toThrow("fixture failure");
      expect(await db().execute(sql`select number from gaps where id=${gap}`)).toEqual([{ number: null }]);
    } finally { spy.mockRestore(); }
  }));

  it("preserves another editor’s field and records the locked tactic values in S5", async () => isolated(async (pg, schema) => {
    const id = await recordMissedTactic({ name: "Original study", evidence_question: "Original question", type: "registry", status: "planned", actor_name: actor.name, actor_function: actor.function });
    const original = (await loadState()).tactics.find(row => row.id === id)!;
    await pg.unsafe(`update "${schema}".tactics set evidence_question='Updated question' where id=$1`, [id]);
    const input = { action: "edit_tactic", tactic_id: id, name: "Renamed study", rationale: "Clarify the study name" };
    await expect(runStage({ stage: "S5", input: { ...input, expected_tactic: tacticEditVersion(original) }, actor, role: args.role })).rejects.toThrow("changed since");
    // This editor has already read the plan when the other connection updates the question.
    const modify = store.modifyTactic;
    const concurrent = vi.spyOn(store, "modifyTactic").mockImplementationOnce(async edit => {
      await pg.unsafe(`update "${schema}".tactics set evidence_question='Concurrent question' where id=$1`, [id]);
      return modify(edit);
    });
    try { await runStage({ stage: "S5", input, actor, role: args.role }); }
    finally { concurrent.mockRestore(); }
    expect((await loadState()).tactics.find(row => row.id === id)).toMatchObject({ name: "Renamed study", evidence_question: "Concurrent question" });
    expect(await db().execute(sql`select field, before, after from edit_records where stage='S5' and entity_id=${id}`)).toEqual([{ field: "name", before: "Original study", after: "Renamed study" }]);
  }));

  it("keeps evaluation candidates out of the live tables while standalone dry runs keep theirs", async () => isolated(async () => {
    const first = await advanceIngest({ ...args, files: [{ ...file, text: "There is limited evidence about comparative effectiveness in this fictional population." }] });
    await advanceIngest({ actor, role: args.role, job_id: first.job_id });
    const options = { stage: "S2", input: { dry_run: true }, actor, role: args.role } as const;
    await runStage({ ...options, evaluation: true });
    expect(await db().execute(sql`select id from gap_candidates`)).toHaveLength(0);
    await runStage(options);
    expect((await db().execute(sql`select id from gap_candidates`)).length).toBeGreaterThan(0);
  }));

  it("rejects a model stage inside an ambient transaction before opening a run", async () => isolated(async () => {
    await loadState();
    await withWorkspaceTransaction(async () => {
      await expect(runStage({ stage: "S2", input: {}, actor, role: args.role })).rejects.toThrow("outside a workspace transaction");
      expect(await db().execute(sql`select id from module_runs`)).toHaveLength(0);
    });
  }));

  it.each([["180001", 180001], ["2147483648", 180000], ["0", 180000]])(
    "uses a bounded positive model deadline for %s", (configured, expected) => {
      vi.stubEnv("SYNAPSE_RUN_TIMEOUT_MS", configured);
      try { expect(modelRunTimeoutMs()).toBe(expected); }
      finally { vi.unstubAllEnvs(); }
    },
  );

  it("reclaims an expired attempt and discards the late worker's writes", async () => isolated(async (pg, schema) => {
    const first = await advanceIngest({ ...args, files: [...args.files] });
    const resume = () => advanceIngest({ actor, role: args.role, job_id: first.job_id });
    const original = parseModule.run;
    let release!: () => void;
    let enter!: () => void;
    const started = new Promise<void>(resolve => { enter = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const spy = vi.spyOn(parseModule, "run").mockImplementationOnce(async (input, ctx) => {
      enter();
      await gate;
      return original(input, ctx);
    });
    vi.stubEnv("SYNAPSE_RUN_TIMEOUT_MS", "600000");
    const pending = resume();
    try {
      await started;
      const [claim] = await pg.unsafe(`select
        (checkpoint->'attempt'->>'expires_at')::timestamptz > clock_timestamp() + interval '10 minutes' as covers_model
        from "${schema}".ingestion_jobs where id = $1`, [first.job_id]);
      expect(claim.covers_model).toBe(true);
      await pg.unsafe(`update "${schema}".ingestion_jobs
        set checkpoint = jsonb_set(checkpoint, '{attempt,expires_at}', to_jsonb(clock_timestamp() - interval '1 second'))
        where id = $1`, [first.job_id]);
      expect(await resume()).toMatchObject({ completed: 2, stage: "S2" });
      release();
      await expect(pending).rejects.toMatchObject({ code: "stage_inputs_changed" });
      expect(await listParsedDocuments()).toHaveLength(1);
      expect((await db().select().from(ingestionJobs))[0].checkpoint).toMatchObject({ completed: 2 });
    } finally {
      release();
      await pending.catch(() => undefined);
      spy.mockRestore();
      vi.unstubAllEnvs();
    }
  }));

  it("rolls back publication if the lease changes while the domain versions stay identical", async () => isolated(async (pg, schema) => {
    const first = await advanceIngest({ ...args, files: [file] });
    const original = parseModule.run;
    const replaceOwner = vi.spyOn(parseModule, "run").mockImplementationOnce(async (input, ctx) => {
      const draft = await original(input, ctx);
      await pg.unsafe(`update "${schema}".ingestion_jobs set checkpoint=jsonb_set(checkpoint, '{attempt,token}', to_jsonb('replacement'::text)) where id=$1`, [first.job_id]);
      return draft;
    });
    try {
      await expect(advanceIngest({ actor, role: args.role, job_id: first.job_id })).rejects.toMatchObject({ code: "ingest_busy" });
      expect(await listParsedDocuments()).toHaveLength(0);
      expect((await listSourceFiles())[0].status).toBe("uploaded");
      expect((await db().select().from(ingestionJobs))[0].checkpoint).toMatchObject({ completed: 1, attempt: { token: "replacement" } });
    } finally { replaceOwner.mockRestore(); }
  }));

  it("publishes S3 tactics without replacing a concurrently saved gap override", async () => isolated(async (pg, schema) => {
    const source = { ...file, text: "The prospective VELA registry will collect real-world persistence data." };
    const first = await advanceIngest({ ...args, files: [source] });
    await advanceIngest({ actor, role: args.role, job_id: first.job_id });
    const [document] = await listParsedDocuments();
    const id = await createGap({
      statement: "The separate fictional cohort lacks access evidence.",
      actor_name: actor.name, actor_function: actor.function,
    });
    await store.overrideGapStatus({
      gap_id: id, status: "validated_open", reason: "Original review found a need",
      actor_name: actor.name, actor_function: actor.function,
    });
    const decision = {
      status: "validated_addressed" as const,
      to: "validated_addressed" as const,
      reason: "Independent evidence resolves this question",
      actor_name: "Concurrent editor",
      stale: true,
    };

    const { blocked, result } = await raceGapEdit(pg, tx => tx`
      update ${tx(schema)}.gaps set status = ${decision.status},
        status_override = status_override || ${tx.json(decision)}::jsonb
      where id = ${id}
    `, () => runStage<TacticExtractOutput>({
      stage: "S3", input: { document_ids: [document.id] }, actor, role: args.role,
    }));

    if (result.status === "rejected") throw result.reason;
    expect(result.value.output.committed_tactic_ids).not.toHaveLength(0);
    expect((await loadState()).gaps.find(gap => gap.id === id)).toMatchObject({
      status: decision.status, status_override: decision,
    });
    expect(blocked).toBe(false);
  }));

  it.each([
    { surface: "S5", action: "classify", status: 400, error: /Only live Open or Addressed gaps can be overridden/ },
    { surface: "S5", action: "validate", status: 404, error: /Gap not found/ },
    { surface: "workbench", action: "classify_gap", status: 400, error: /Only live Open or Addressed gaps can be overridden/ },
    { surface: "workbench", action: "override_gap_status", status: 400, error: /Only live Open or Addressed gaps can be overridden/ },
    { surface: "workbench", action: "validate_gap", status: 404, error: /Gap not found/ },
  ] as const)("rejects $surface $action after another editor excludes the gap", async ({ surface, action, status, error }) => isolated(async (pg, schema) => {
    const id = await createGap({
      statement: "The fictional cohort lacks follow-up evidence.",
      actor_name: actor.name, actor_function: actor.function,
    });
    const explanation = "The cohort is outside the agreed scope";
    const { blocked, result } = await raceGapEdit(pg, tx => tx`
      update ${tx(schema)}.gaps set status = 'excluded', computed_status = null,
        exclusion_reason = 'outside_scope', exclusion_note = ${explanation}
      where id = ${id}
    `, async () => {
      const rationale = "Reviewed the evidence independently";
      const input = { action, gap_id: id, status: "validated_open", rationale };
      if (surface === "S5") {
        await expect(runStage({ stage: "S5", actor, role: args.role, input })).rejects.toMatchObject({
          message: expect.stringMatching(error), status,
        });
        return;
      }
      const response = await POST(new Request("http://localhost/api/iegp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...input, reason: rationale, note: rationale }),
      }));
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ error: expect.stringMatching(error), request_outcome: "rejected" });
    });

    expect(blocked).toBe(true);
    const state = await loadState();
    expect(state.gaps.find(gap => gap.id === id)).toMatchObject({
      status: "excluded", exclusion_note: explanation,
      human_validated: false, status_override: null,
    });
    expect(state.residuals.filter(row => row.gap_id === id)).toHaveLength(0);
    expect(await db().execute(sql`select id from edit_records where stage = 'S5' and entity_id = ${id}`)).toHaveLength(0);
    if (result.status === "rejected") throw result.reason;
  }));

  it("numbers legacy gaps once while S5 and workbench editors act on different gaps", async () => isolated(async (pg, schema) => {
    const attributes = { actor_name: actor.name, actor_function: actor.function };
    const first = await createGap({ ...attributes, statement: "The first cohort lacks long-term evidence." });
    const second = await createGap({ ...attributes, statement: "The second cohort lacks comparative evidence." });
    const numbered = await createGap({ ...attributes, statement: "The third cohort lacks registry evidence." });
    await db().execute(sql`update gaps set number = null where id = ${first}`);
    await db().execute(sql`update gaps set number = 0 where id = ${second}`);

    const rationale = "Reviewed the evidence independently";
    const runGapActions = () => Promise.allSettled([
      runStage({ stage: "S5", actor, role: args.role, input: {
        action: "classify", gap_id: first, status: "validated_addressed", rationale,
      } }),
      post({ action: "validate_gap", gap_id: second, rationale, note: rationale }),
    ]);
    const { blocked, result } = await raceGapEdit(pg, tx =>
      tx`select key from ${tx(schema)}.id_counters where key = 'gap_number' for update`, runGapActions);
    if (result.status === "rejected") throw result.reason;
    const [stage, workbench] = result.value;
    if (stage.status === "rejected") throw stage.reason;
    if (workbench.status === "rejected") throw workbench.reason;
    expect(blocked).toBe(false);
    expect(workbench.value.status, await workbench.value.text()).toBe(200);

    const [loaded, reloaded] = await Promise.all([loadState(), loadState()]);
    const firstGap = loaded.gaps.find(gap => gap.id === first)!;
    const secondGap = loaded.gaps.find(gap => gap.id === second)!;
    expect(firstGap).toMatchObject({ status: "validated_addressed", human_validated: false });
    expect(secondGap).toMatchObject({ status: "validated_open", human_validated: true });
    expect(loaded.gaps.find(gap => gap.id === numbered)?.number).toBe(3);
    expect(new Set([firstGap.number, secondGap.number])).toEqual(new Set([4, 5]));
    expect(new Map(reloaded.gaps.map(gap => [gap.id, gap.number])))
      .toEqual(new Map(loaded.gaps.map(gap => [gap.id, gap.number])));
  }));

  it("lets S5 validate a legacy Open gap while S8 saves its priority", async () => isolated(async pg => {
    const gapId = await createGap({
      statement: "The fictional cohort lacks follow-up evidence.",
      actor_name: actor.name, actor_function: actor.function,
    });
    await db().execute(sql`update gaps set number = null where id = ${gapId}`);

    const started = Promise.withResolvers<number>();
    const release = Promise.withResolvers<void>();
    const originalLoad = store.loadState;
    const spy = vi.spyOn(store, "loadState").mockImplementationOnce(async () => {
      // S8 owns the gap row by the time it reads the decision state.
      const [connection] = await db().execute(sql`select pg_backend_pid() as pid`);
      started.resolve(Number(connection.pid));
      await release.promise;
      return originalLoad();
    });
    const priority = validatePlacement({
      gap_id: gapId, actor, band: "high", expected_version: null,
      reason: "Prioritized after reviewing the evidence",
    });
    const priorityResult = Promise.allSettled([priority]);
    let validationResult: Promise<PromiseSettledResult<unknown>[]> | undefined;
    try {
      const priorityPid = await Promise.race([
        started.promise,
        priority.then(() => { throw new Error("S8 finished before reaching the gap lock"); }),
        delay(5_000).then(() => { throw new Error("S8 did not reach the gap lock"); }),
      ]);
      validationResult = Promise.allSettled([runStage({ stage: "S5", actor, role: args.role, input: {
        action: "validate", gap_id: gapId, rationale: "Reviewed the evidence independently",
      } })]);

      const deadline = Date.now() + 5_000;
      let blocked = false;
      while (!blocked && Date.now() < deadline) {
        const [activity] = await pg<{ blocked: boolean }[]>`
          select exists (
            select 1 from pg_stat_activity where ${priorityPid} = any(pg_blocking_pids(pid))
          ) as blocked
        `;
        blocked = activity.blocked;
        if (!blocked) await delay(10);
      }
      expect(blocked).toBe(true);
      release.resolve();

      const [saved] = await priorityResult;
      const [validated] = await validationResult;
      if (saved.status === "rejected") throw saved.reason;
      if (validated.status === "rejected") throw validated.reason;
      expect(saved.value).toMatchObject({ gap_id: gapId, band: "high", validated: true });
      expect((await loadState()).gaps.find(gap => gap.id === gapId)).toMatchObject({ number: 2, human_validated: true });
    } finally {
      release.resolve();
      await priorityResult;
      await validationResult;
      spy.mockRestore();
    }
  }));

  it("lets a numbered gap decision proceed while another editor holds its own gap and the numbering counter", async () => isolated(async (pg, schema) => {
    const attributes = { actor_name: actor.name, actor_function: actor.function };
    const first = await createGap({ ...attributes, statement: "The first cohort lacks long-term evidence." });
    const second = await createGap({ ...attributes, statement: "The second cohort lacks comparative evidence." });
    const { blocked, result } = await raceGapEdit(pg, async tx => {
      await tx`select key from ${tx(schema)}.id_counters where key = 'gap_number' for update`;
      await tx`select id from ${tx(schema)}.gaps where id = ${first} for update`;
    }, () => runStage({ stage: "S5", actor, role: args.role, input: {
      action: "validate", gap_id: second, rationale: "Reviewed the second cohort independently",
    } }));

    if (result.status === "rejected") throw result.reason;
    expect(blocked).toBe(false);
    expect((await loadState()).gaps.find(gap => gap.id === second)).toMatchObject({ number: 2, human_validated: true });
  }));

  it("rolls back a human validation and its audit trail when the output contract fails", async () => isolated(async () => {
    const id = await createGap({
      statement: "The fictional cohort lacks follow-up evidence.",
      actor_name: actor.name, actor_function: actor.function,
    });
    const selectEdits = () => db().execute(sql`select id from edit_records where entity_id = ${id} order by id`);
    const before = await selectEdits();
    const original = validationModule.run;
    const spy = vi.spyOn(validationModule, "run").mockImplementationOnce(async (input, ctx) => {
      const result = await original(input, ctx);
      return { ...result, output: { ...result.output, action: null as unknown as string } };
    });
    try {
      await expect(runStage({ stage: "S5", input: {
        action: "validate", gap_id: id, rationale: "Independent fixture review completed",
      }, actor, role: args.role })).rejects.toThrow("outside its contract");
      expect((await loadState()).gaps.find(gap => gap.id === id)?.human_validated).toBe(false);
      expect(await selectEdits()).toEqual(before);
      expect(await db().execute(sql`select status from module_runs where stage = 'S5'`)).toEqual([{ status: "error" }]);
    } finally { spy.mockRestore(); }
  }));

  it("rejects a competing transaction without changing its checkpoint", async () => isolated(async (pg, schema) => {
    const first = await advanceIngest({ ...args, files: [...args.files] });
    await pg.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${`ingest:${schema}`}, 0))`;
      const response = await post({ ingest_job_id: first.job_id });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "ingest_busy" });
    });
    expect((await db().select().from(ingestionJobs))[0].checkpoint).toMatchObject({ completed: 1 });
    expect(await advanceIngest({ actor, role: args.role, job_id: first.job_id })).toMatchObject({ completed: 2 });
  }));

  it("never reuses a cleared job token even when the same file is ingested again", async () => isolated(async () => {
    const first = await advanceIngest({ ...args, files: [...args.files] });
    await db().delete(ingestionJobs);
    const fresh = await advanceIngest({ ...args, files: [...args.files] });
    expect(fresh.job_id).not.toBe(first.job_id);
    const stale = await post({ ingest_job_id: first.job_id });
    expect(stale.status).toBe(400);
    expect(await stale.json()).toMatchObject({ code: "invalid_request", error: expect.stringContaining("Ingestion not found") });
    expect(await listSourceFiles()).toHaveLength(1);
  }));

  it("resumes demo ingestion without resending its demo id", async () => isolated(async () => {
    const first = await post({ action: "ingest_demo", demo_id: DEMO_PACK[0].id });
    expect(first.status).toBe(200);
    const state = await first.json();
    const second = await post({ action: "ingest_demo", ingest_job_id: state.job_id });
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ job_id: state.job_id, completed: 2, stage: "S2" });
  }));

  it("finishes after parsing when extraction and mapping are disabled", async () => isolated(async () => {
    const sections = ["gap_extraction", "tactic_extraction", "mapping"] as const;
    try {
      for (const section of sections) await setAiSection({ section, enabled: false, actor_name: actor.name });
      const first = await advanceIngest({ ...args, files: [...args.files] });
      expect(first).toMatchObject({ completed: 1, total: 2, stage: "S1" });
      expect(await advanceIngest({ actor, role: args.role, job_id: first.job_id })).toMatchObject({ done: true, completed: 2, total: 2, stage: null });
      expect((await completedIngestSourceIds()).size).toBe(1);
    } finally {
      for (const section of sections) await setAiSection({ section, enabled: true, actor_name: actor.name });
    }
  }));

  it("rejects invalid input before saving files and reports parsing errors without advancing", async () => isolated(async () => {
    for (const body of [{ ...file, title: " " }, { ...file, title: 42 }, { ...file, text: " " }, { ...file, source_type: "invalid" }, { ...file, filename: "bad.exe" }, { ...file, filename: "bad.pdf", text: undefined, content_base64: "a" }, { ingest_job_id: "bad" }, { ...file, filename: "bad.pdf", text: undefined, content_base64: "!invalid!" }]) {
      const response = await post(body);
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBeTruthy();
    }
    expect(await listSourceFiles()).toHaveLength(0);
    const response = await post({ ...file, filename: "broken.pdf", text: undefined, content_base64: Buffer.from("not a PDF").toString("base64") });
    expect(response.status).toBe(200);
    const first = await response.json();
    const failed = await post({ ingest_job_id: first.job_id });
    expect(failed.status).toBe(400);
    expect(await failed.json()).toMatchObject({ stage: "S1", error: expect.stringMatching(/Parsing failed/) });
    expect((await db().select().from(ingestionJobs))[0].checkpoint).toMatchObject({ completed: 1 });
    expect(await listParsedDocuments()).toHaveLength(0);
  }));
});
