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
    const runs = await db().execute(sql`select stage from module_runs order by stage`);
    expect(runs.map((row) => row.stage)).toEqual(["S0", "S1", "S2", "S3", "S4"]);
    expect((await completedIngestSourceIds()).size).toBe(1);
    expect(await advanceIngest({ ...args, files: [...args.files] })).toEqual(next);
    expect(await advanceIngest({ ...args, files: [{ ...file, title: "Renamed", filename: "renamed.txt" }] })).toEqual(next);
    expect(await db().execute(sql`select stage from module_runs`)).toHaveLength(5);
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
