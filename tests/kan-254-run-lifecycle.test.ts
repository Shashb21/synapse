/** Persisted stage lifecycle regressions, using synthetic inputs and no provider calls. */
import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/modules/route";
import { GET as readRun } from "@/app/api/runs/[id]/route";
import postgres from "postgres";
import { db } from "@/modules/kernel/db";
import { HISTORICAL_FAILURE_MESSAGE } from "@/modules/kernel/failure-presentation";
import { closeRun, openRun, RunRecorder, SOURCE_COMPARISON_MODULE, withRunningSourceComparison } from "@/modules/kernel/observability";
import * as observability from "@/modules/kernel/observability";
import * as routing from "@/modules/kernel/routing";
import { runStage } from "@/modules/kernel/run";
import { moduleRuns } from "@/modules/kernel/schema";
import { stageOf } from "@/modules/kernel/stage-errors";
import { runInWorkspace } from "@/modules/workspaces/context";

const actor = { name: "KAN-254 lifecycle fixture", function: "medical_affairs" as const };
const old = new Date(Date.now() - 60 * 60_000).toISOString();
const workspace = { workspace_id: "kan254_fixture", schema: "ws_kan254_fixture" };

function fixture(workspaceId = "default") {
  return new RunRecorder({ workspace_id: workspaceId, stage: "S8", module_id: "kan254.fixture", module_version: "1", actor, input: {} });
}

function stored(id: string) {
  return db().select().from(moduleRuns).where(eq(moduleRuns.id, id)).then(([row]) => row);
}

function read(id: string) {
  return readRun(new Request(`http://localhost/api/runs/${id}`), { params: Promise.resolve({ id }) });
}

async function openOldRun(recorder: RunRecorder) {
  await openRun(recorder);
  await db().update(moduleRuns).set({ started_at: old }).where(eq(moduleRuns.id, recorder.id));
}

describe("stage run lifecycle", () => {
  it("records routing setup failure once and keeps private details out of the route response", async () => {
    const actorFilter = and(eq(moduleRuns.actor_name, actor.name), eq(moduleRuns.stage, "S8"));
    const failure = new Error("Private synthetic provider routing diagnostic");
    const route = vi.spyOn(routing, "routeConfig").mockRejectedValue(failure);
    try {
      await expect(runStage({ stage: "S8", input: {}, actor, role: "medical_affairs" })).rejects.toBe(failure);
      expect(stageOf(failure)).toBe("S8");
      const rows = await db().select().from(moduleRuns).where(actorFilter);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: "error", error: failure.message, finished_at: expect.any(String) });
      const response = await POST(new Request("http://localhost/api/modules", {
        method: "POST", body: JSON.stringify({ stage: "S8", input: {}, actor_name: actor.name }),
      }));
      const body = await response.json();
      expect(response.status).toBe(400);
      expect(body).toMatchObject({ safe_error: true, stage: "S8" });
      expect(JSON.stringify(body)).not.toContain(failure.message);
    } finally {
      route.mockRestore();
      await db().delete(moduleRuns).where(actorFilter);
    }
  });

  it("commits the stage diagnostic before an overdue recovery can close the run", async () => {
    const actorFilter = and(eq(moduleRuns.actor_name, actor.name), eq(moduleRuns.stage, "S8"));
    const failure = new Error("Original synthetic setup failure");
    const worker = postgres(process.env.DATABASE_URL!, { max: 1, ssl: false });
    const insertRun = observability.openRun;
    const finalizeRun = observability.closeRun;
    vi.spyOn(observability, "openRun").mockImplementation(async (recorder) => {
      await insertRun(recorder);
      await db().update(moduleRuns).set({ started_at: old }).where(eq(moduleRuns.id, recorder.id));
    });
    vi.spyOn(routing, "routeConfig").mockRejectedValue(failure);
    vi.spyOn(observability, "closeRun").mockImplementation(async (args) => {
      // A separate recovery worker claims only overdue rows it can lock immediately.
      await worker.begin(async (tx) => {
        const [claim] = await tx`
          select id from module_runs where status = 'running' and started_at = ${old}
          and id = ${args.recorder.id} for update skip locked
        `;
        if (claim) await tx`update module_runs set status = 'error', error = 'Interrupted' where id = ${claim.id}`;
      });
      return finalizeRun(args);
    });
    try {
      await expect(runStage({ stage: "S8", input: {}, actor, role: "medical_affairs" })).rejects.toBe(failure);
      const [row] = await db().select().from(moduleRuns).where(actorFilter);
      expect(row).toMatchObject({ status: "error", error: failure.message });
    } finally {
      vi.restoreAllMocks();
      await worker.end();
      await db().delete(moduleRuns).where(actorFilter);
    }
  });

  it("preserves the original terminal result after a second close or a recovery read", async () => {
    const recorder = fixture();
    try {
      await openOldRun(recorder);
      await closeRun({ recorder, status: "ok", output: { score: 0.8 } });
      const completed = await stored(recorder.id);
      await closeRun({ recorder, status: "error", error: "A later follow-up failed" });
      const response = await read(recorder.id);
      expect(response.status).toBe(200);
      expect((await response.json()).run).toMatchObject({ status: "ok", output: { score: 0.8 } });
      expect(await stored(recorder.id)).toEqual(completed);
    } finally {
      await db().delete(moduleRuns).where(eq(moduleRuns.id, recorder.id));
    }
  });

  it("recovers only expired rows in the selected schema and keeps recovery terminal", async () => {
    const recorder = fixture(workspace.workspace_id);
    const recent = fixture(workspace.workspace_id);
    try {
      await runInWorkspace(workspace, async () => {
        await openOldRun(recorder);
        await openRun(recent);
      });
      expect((await read(recorder.id)).status).toBe(404);
      await runInWorkspace(workspace, async () => {
        expect(await stored(recorder.id)).toMatchObject({ status: "running" });
        const response = await read(recorder.id);
        expect(response.status).toBe(200);
        expect((await response.json()).run).toMatchObject({ status: "error", error: HISTORICAL_FAILURE_MESSAGE });
        expect(await stored(recorder.id)).toMatchObject({ status: "error", finished_at: expect.any(String) });
        await closeRun({ recorder, status: "ok", output: { score: 0.8 } });
        expect((await stored(recorder.id)).status).toBe("error");
        expect((await read(recent.id)).status).toBe(200);
        expect((await stored(recent.id)).status).toBe("running");
      });
    } finally {
      await db().execute(sql`drop schema if exists ws_kan254_fixture cascade`);
    }
  });

  it.each(["row", "ingestion"] as const)("skips an expired row while its %s lock is held", async (lock) => {
    const recorder = new RunRecorder({ workspace_id: "default", stage: "S2", module_id: "kan254.fixture", module_version: "1", actor, input: {} });
    // This is a different connection from the route's workspace pool, even
    // when that pool has only one slot under Vitest.
    const worker = postgres(process.env.DATABASE_URL!, { max: 1, ssl: false });
    try {
      await openOldRun(recorder);
      await worker.begin(async (tx) => {
        if (lock === "row") {
          await tx`select id from module_runs where id = ${recorder.id} for update`;
        } else {
          await tx`select pg_advisory_xact_lock(hashtextextended('ingest:public', 0))`;
        }
        const response = await read(recorder.id);
        expect(response.status).toBe(200);
        expect((await response.json()).run.status).toBe("running");
      });
      expect((await (await read(recorder.id)).json()).run.status).toBe("error");
    } finally {
      await worker.end();
      await db().delete(moduleRuns).where(eq(moduleRuns.id, recorder.id));
    }
  });

  it("keeps an expired comparison running until its provider call releases the execution lock", async () => {
    const recorder = new RunRecorder({ workspace_id: "default", stage: "S1", module_id: SOURCE_COMPARISON_MODULE, module_version: "1", actor, input: {} });
    try {
      await openOldRun(recorder);
      await withRunningSourceComparison(recorder, async () => {
        expect((await (await read(recorder.id)).json()).run.status).toBe("running");
      });
      expect((await (await read(recorder.id)).json()).run.status).toBe("error");
    } finally {
      await db().delete(moduleRuns).where(eq(moduleRuns.id, recorder.id));
    }
  });
});
