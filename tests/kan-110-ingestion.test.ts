/** Regression coverage for recoverable ingestion using disposable workspace schemas. */
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));

import "@/modules";
import { advanceIngest } from "@/app/api/iegp/ingest-pipeline";
import { POST } from "@/app/api/iegp/route";
import { db } from "@/modules/kernel/db";
import { currentSchemaName } from "@/lib/iegp/db";
import { runInWorkspace } from "@/modules/workspaces/context";
import { listSourceFiles } from "@/modules/stages/s0-upload/module";
import { listParsedDocuments, parseModule } from "@/modules/stages/s1-parse/module";
import { ingestionJobs } from "@/lib/ingest/schema";
import { DEMO_PACK } from "@/lib/iegp/demo-pack";
import { setAiSection } from "@/modules/kernel/ai-switch";
import * as routing from "@/modules/kernel/routing";
import { stageOf } from "@/modules/kernel/stage-errors";
import { completedIngestSourceIds } from "@/lib/ingest/status";
import { priorityDecision, reviewInventoryForPriorities } from "./support/priority-decision";

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

  it("retains a setup failure trace while rolling back the stage checkpoint", async () => isolated(async () => {
    const first = await advanceIngest({ ...args, files: [...args.files] });
    const failure = new Error("Synthetic route lookup failure");
    const route = vi.spyOn(routing, "routeConfig").mockRejectedValueOnce(failure);
    try {
      await expect(advanceIngest({ actor, role: args.role, job_id: first.job_id })).rejects.toBe(failure);
      expect(stageOf(failure)).toBe("S1");
      expect((await db().select().from(ingestionJobs))[0].checkpoint).toMatchObject({ completed: 1 });
      expect(await listParsedDocuments()).toHaveLength(0);
      const runs = await db().execute(sql`select status, error, finished_at from module_runs where stage = 'S1'`);
      expect([...runs]).toEqual([{ status: "error", error: failure.message, finished_at: expect.any(String) }]);
    } finally {
      route.mockRestore();
    }
    expect(await advanceIngest({ actor, role: args.role, job_id: first.job_id })).toMatchObject({ completed: 2, stage: "S2" });
    expect(await listParsedDocuments()).toHaveLength(1);
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

describe("KAN-262 run-wide outcomes across stage and checkpoint boundaries", () => {
  it("closes a direct stage trace when policy denies the only credentialed fallback", async () => isolated(async () => {
    const { runStage } = await import("@/modules/kernel/run");
    const routing = await import("@/modules/kernel/routing");
    const resolveRoute = routing.resolveRoute;
    const route = vi.spyOn(routing, "resolveRoute").mockImplementation(stage => resolveRoute(stage, {
      stage, provider_id: "xai-grok", model: "grok-4", params: { temperature: 0, max_tokens: 4096 },
      fallbacks: ["openai"], updated_by: actor.name, updated_at: "test",
    }));
    const modelMode = vi.spyOn(await import("@/modules/kernel/llm"), "isTestStub").mockReturnValue(false);
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    vi.stubEnv("XAI_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "fictional-fallback");
    vi.stubEnv("SYNAPSE_APPROVED_FALLBACK_PAIRS", "");
    try {
      await expect(runStage({ stage: "S2", input: {}, actor, role: args.role })).rejects.toThrow("XAI_API_KEY");
      expect(fetch).not.toHaveBeenCalled();
      expect(await db().execute(sql`select status, finished_at, error from module_runs where stage = 'S2'`))
        .toMatchObject([{ status: "error", finished_at: expect.any(String), error: expect.stringContaining("XAI_API_KEY") }]);
    } finally {
      route.mockRestore();
      modelMode.mockRestore();
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  }));

  it("returns classified cancellation for an already-aborted ingestion request", async () => {
    const response = await POST(new Request("http://localhost/api/iegp", {
      method: "POST", body: JSON.stringify({ action: "ingest" }), signal: AbortSignal.abort(),
    }));
    expect(response.status).toBe(408);
    expect(await response.json()).toMatchObject({ code: "cancelled" });
  });

  it.each(["refusal", "truncation", "attempt_limit"] as const)(
    "preserves %s for direct multi-file S1 and ingestion without advancing", async code => isolated(async () => {
      const { runStage } = await import("@/modules/kernel/run");
      const { apiErrorResponse } = await import("@/modules/auth/api-guard");
      const first = await advanceIngest({ ...args, files: [file, { ...file, filename: "second.txt", text: "Second fictional panel report." }] });
      const ids = (await listSourceFiles()).map(row => row.id);
      expect(ids).toHaveLength(2);
      const routing = await import("@/modules/kernel/routing");
      const resolveRoute = routing.resolveRoute;
      const route = vi.spyOn(routing, "resolveRoute").mockImplementation(stage => resolveRoute(stage, {
        stage, provider_id: "xai-grok", model: "grok-4", params: { temperature: 0, max_tokens: 4096 },
        fallbacks: [], updated_by: actor.name, updated_at: "test",
      }));
      const modelMode = vi.spyOn(await import("@/modules/kernel/llm"), "isTestStub").mockReturnValue(false);
      vi.stubEnv("XAI_API_KEY", "fictional");
      vi.stubEnv("SYNAPSE_RUN_MAX_ATTEMPTS", "1");
      const fetch = vi.fn(async () => Response.json({ choices: [{
        message: { content: "{}" }, finish_reason: code === "refusal" ? "content_filter" : code === "truncation" ? "length" : "stop",
      }] }));
      vi.stubGlobal("fetch", fetch);
      try {
        const direct = await runStage({ actor, role: args.role, stage: "S1", input: { file_ids: ids } })
          .then(() => { throw new Error("Expected S1 to stop"); }, apiErrorResponse);
        expect(await direct.json()).toMatchObject({ code, stage: "S1" });
        expect(fetch).toHaveBeenCalledTimes(1);
        const pipeline = await post({ ingest_job_id: first.job_id });
        expect(await pipeline.json()).toMatchObject({ code, stage: "S1" });
        expect(fetch).toHaveBeenCalledTimes(2);
        expect((await listSourceFiles()).map(row => row.status)).toEqual(["uploaded", "uploaded"]);
        expect(await listParsedDocuments()).toHaveLength(0);
        expect((await db().select().from(ingestionJobs))[0].checkpoint).toMatchObject({ completed: 1 });
      } finally {
        route.mockRestore();
        modelMode.mockRestore();
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
      }
    }),
  );

  it("rolls back a direct parse when cancelled during success recording", async () => isolated(async pg => {
    const { runStage } = await import("@/modules/kernel/run");
    const evals = await import("@/modules/kernel/evals");
    await advanceIngest({ ...args, files: [file] });
    const id = (await listSourceFiles())[0].id;
    const controller = new AbortController();
    const original = evals.recordEvalRun;
    const spy = vi.spyOn(evals, "recordEvalRun").mockImplementationOnce(async (...params) => {
      const result = await original(...params);
      controller.abort();
      return result;
    });
    try {
      await expect(runStage({ stage: "S1", input: { file_ids: [id] }, actor, role: args.role, signal: controller.signal }))
        .rejects.toMatchObject({ code: "cancelled" });
      const runId = spy.mock.calls[0][0].run_id!;
      expect(await pg`select id from public.eval_runs where run_id = ${runId}`).toHaveLength(0);
      expect(await db().execute(sql`select status from module_runs where id = ${runId}`)).toMatchObject([{ status: "error" }]);
      expect(await listParsedDocuments()).toHaveLength(0);
      expect((await listSourceFiles())[0].status).toBe("uploaded");
    } finally { spy.mockRestore(); }
  }));

  it.each(["before", "after"] as const)("reports the durable S8 outcome when cancelled %s the placement commit", async timing => isolated(async pg => {
    const { runStage } = await import("@/modules/kernel/run");
    const { resetDemoSetup, createGap } = await import("@/lib/iegp/store");
    const priorities = await import("@/modules/stages/s8-prioritization/module");
    const runs = await import("@/modules/kernel/observability");
    const context = await import("@/lib/iegp/store");
    await resetDemoSetup();
    const gap = await createGap({ statement: "Comparative safety remains unknown.", actor_name: actor.name, actor_function: actor.function });
    await reviewInventoryForPriorities(actor);
    const controller = new AbortController();
    const lock = context.lockObjectiveContext;
    const lockSpy = vi.spyOn(context, "lockObjectiveContext").mockImplementation(async (...params) => {
      await lock(...params);
      if (timing === "before") controller.abort();
    });
    const run = runs.withRunningRun;
    const commitSpy = vi.spyOn(runs, "withRunningRun").mockImplementationOnce(async (recorder, execute) => {
      const result = await run(recorder, execute);
      if (timing === "after") controller.abort();
      return result;
    });
    try {
      const pending = runStage({ stage: "S8", input: {}, actor, role: args.role, signal: controller.signal });
      if (timing === "before") await expect(pending).rejects.toMatchObject({ code: "cancelled" });
      else await expect(pending).resolves.toMatchObject({ stage: "S8" });
      expect(lockSpy).toHaveBeenCalled();
      const [run] = await db().execute(sql`select id, status from module_runs where stage = 'S8'`);
      const placements = (await priorities.listPlacements()).filter(row => row.gap_id === gap && row.run_id === run.id);
      const metrics = await pg`select metrics from public.eval_runs where run_id = ${String(run.id)}`;
      expect(run.status).toBe(timing === "before" ? "error" : "ok");
      expect(placements).toHaveLength(timing === "before" ? 0 : 1);
      expect(metrics).toHaveLength(timing === "before" ? 0 : 1);
    } finally {
      lockSpy.mockRestore();
      commitSpy.mockRestore();
    }
  }));

  it.each([
    { stage: "S8", input: { only_missing: true } },
    { stage: "S10", input: { persist: true, anchor: "2026-01-01" } },
  ] as const)("cancels $stage during success recording when the stage writes no customer rows", async ({ stage, input }) => isolated(async pg => {
    const { runStage } = await import("@/modules/kernel/run");
    const { resetDemoSetup, createGap } = await import("@/lib/iegp/store");
    const { listPlacements } = await import("@/modules/stages/s8-prioritization/module");
    const { timelineActivities } = await import("@/modules/kernel/schema");
    const evals = await import("@/modules/kernel/evals");
    await resetDemoSetup();
    if (stage === "S8") {
      await createGap({ statement: "Comparative safety remains unknown.", actor_name: actor.name, actor_function: actor.function });
      await reviewInventoryForPriorities(actor);
      const initial = await runStage({ stage: "S8", input: {}, actor, role: args.role });
      expect(await listPlacements()).toMatchObject([{ run_id: initial.run_id }]);
    }
    const placements = await listPlacements();
    const controller = new AbortController();
    const record = evals.recordEvalRun;
    const spy = vi.spyOn(evals, "recordEvalRun").mockImplementationOnce(async (...params) => {
      const result = await record(...params);
      controller.abort();
      return result;
    });
    try {
      await expect(runStage({ stage, input, actor, role: args.role, signal: controller.signal }))
        .rejects.toMatchObject({ code: "cancelled" });
      const runId = spy.mock.calls[0][0].run_id!;
      expect(await db().execute(sql`select status, output from module_runs where id = ${runId}`))
        .toMatchObject([{ status: "error", output: null }]);
      expect(await pg`select id from public.eval_runs where run_id = ${runId}`).toHaveLength(0);
      expect(await listPlacements()).toEqual(placements);
      expect(await db().select().from(timelineActivities)).toHaveLength(0);
    } finally { spy.mockRestore(); }
  }));

  it("rolls back the S9 proposal batch, audit edits and evaluation together", async () => isolated(async pg => {
    const { runStage } = await import("@/modules/kernel/run");
    const { resetDemoSetup, createGap } = await import("@/lib/iegp/store");
    const { validatePlacement } = await import("@/modules/stages/s8-prioritization/module");
    const evals = await import("@/modules/kernel/evals");
    await resetDemoSetup();
    const gap = await createGap({ statement: "Comparative safety remains unknown.", actor_name: actor.name, actor_function: actor.function });
    const rationale = "Comparative safety blocks the decision.";
    await reviewInventoryForPriorities(actor);
    await validatePlacement({ ...await priorityDecision(gap, rationale), gap_id: gap, actor, band: "high", rationale });
    const controller = new AbortController();
    const record = evals.recordEvalRun;
    const spy = vi.spyOn(evals, "recordEvalRun").mockImplementationOnce(async (...params) => {
      const result = await record(...params);
      expect(await db().execute(sql`select id from ideation_proposals where design->>'run_id' = ${result.run_id}`))
        .not.toHaveLength(0);
      controller.abort();
      return result;
    });
    try {
      await expect(runStage({ stage: "S9", input: { gap_ids: [gap], per_gap: 2 }, actor, role: args.role, signal: controller.signal }))
        .rejects.toMatchObject({ code: "cancelled" });
      const runId = spy.mock.calls[0][0].run_id!;
      expect(await db().execute(sql`select status from module_runs where id = ${runId}`)).toMatchObject([{ status: "error" }]);
      expect(await db().execute(sql`select id from ideation_proposals where design->>'run_id' = ${runId}`)).toHaveLength(0);
      expect(await db().execute(sql`select id from edit_records where stage = 'S9'`)).toHaveLength(0);
      expect(await pg`select id from public.eval_runs where run_id = ${runId}`).toHaveLength(0);
    } finally { spy.mockRestore(); }
  }));

  it("keeps the previous checkpoint if cancellation arrives while loading already-parsed files", async () => isolated(async () => {
    const { runStage } = await import("@/modules/kernel/run");
    const parser = await import("@/modules/stages/s1-parse/module");
    const first = await advanceIngest({ ...args, files: [file] });
    const id = (await listSourceFiles())[0].id;
    await runStage({ stage: "S1", input: { file_ids: [id] }, actor, role: args.role });
    const controller = new AbortController();
    const original = parser.listParsedDocuments;
    const spy = vi.spyOn(parser, "listParsedDocuments").mockImplementationOnce(async () => {
      const parsed = await original();
      controller.abort();
      return parsed;
    });
    try {
      await expect(advanceIngest({ job_id: first.job_id, actor, role: args.role, signal: controller.signal }))
        .rejects.toMatchObject({ code: "cancelled" });
      expect((await db().select().from(ingestionJobs))[0].checkpoint).toMatchObject({ completed: 1 });
      expect(await original()).toHaveLength(1);
    } finally { spy.mockRestore(); }
  }));
});
