import { afterEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { db, sharedDb } from "@/modules/kernel/db";
import { createWorkspace, setLearningSharingEligible, learningSharingEligible } from "@/modules/workspaces/store";
import { proposePromptRevision, listPromptRevisions, getRevisionCohort } from "@/modules/kernel/prompt-revisions";
import * as routing from "@/modules/kernel/routing";
import { ensurePlatformSchema } from "@/modules/kernel/db";
import * as examples from "@/modules/kernel/decision-examples";

import { computeLesson, getDecisionExample, recordDecisionExample } from "@/modules/kernel/decision-examples";
import * as observations from "@/modules/kernel/observability";
import * as transactions from "@/lib/iegp/db";
import * as stateStore from "@/lib/iegp/store";
import * as llm from "@/modules/kernel/llm";
import * as approvedRoutes from "@/modules/kernel/approved-evaluation-route";
import { setAiEnabled } from "@/modules/kernel/ai-switch";
import { activeModule } from "@/modules/kernel/registry";
import type { ResolvedRoute } from "@/modules/kernel/contracts";
import { priorityReviewExample } from "./support/priority-review-example";

describe("prompt revision preflight", () => {
  it("refuses unsupported stages before loading lessons or allocating a cohort", async () => {
    const read = vi.spyOn(examples, "listDecisionExamples");
    try {
      for (const stage of ["S2", "S3", "S6"] as const) {
        await expect(
          proposePromptRevision({
            stage,
            workspace_id: "fiction",
            exclude_ids: [],
            actor: { name: "Owner", function: "medical_affairs" },
          }),
        ).rejects.toThrow("human target contract");
      }
      expect(read).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });
  it("creates no candidate or orphan cohort when the workspace lacks independent gold", async () => {
    const ws = await createWorkspace({ name: "fiction-" + crypto.randomUUID(), owner: "fiction-owner" });
    const completion = vi.spyOn(routing, "completionFor");
    vi.spyOn(routing, "routeConfigs").mockResolvedValue([
      {
        stage: "S8",
        provider_id: "test",
        model: "fiction",
        params: { temperature: 0, max_tokens: 500 },
        fallbacks: [],
        updated_by: "fixture",
        updated_at: "2026-01-01",
      },
    ]);
    vi.spyOn(routing, "resolveRoute").mockResolvedValue({
      stage: "S8",
      provider_id: "test",
      provider_label: "fiction",
      model: "fiction",
      params: { temperature: 0, max_tokens: 500 },
      degraded: false,
      connected: true,
      auth: "api_key",
      fallbacks: [],
      reason: null,
    });
    try {
      await ensurePlatformSchema();
      await expect(
        proposePromptRevision({
          stage: "S8",
          workspace_id: ws.id,
          exclude_ids: [],
          actor: { name: "Owner", function: "medical_affairs" },
        }),
      ).rejects.toThrow("three independent");
      expect(completion).not.toHaveBeenCalled();
      expect(await listPromptRevisions(ws.id)).toEqual([]);
      expect(await sharedDb().execute(sql`select id from prompt_revision_cohorts where workspace_id=${ws.id}`)).toHaveLength(
        0,
      );
    } finally {
      vi.restoreAllMocks();
    }
  });
});

const ownedWorkspaceIds: string[] = [];
const actor = { name: "Owner", function: "medical_affairs" as const };
afterEach(async () => { vi.restoreAllMocks(); await setAiEnabled({ enabled: true, actor_name: "test" }); for (const id of ownedWorkspaceIds.splice(0)) { await setLearningSharingEligible(id,false); expect(await learningSharingEligible(id)).toBe(false); } });
async function fixture() {
  const ws = await createWorkspace({ name: `revision-${crypto.randomUUID()}`, owner: "revision-test" });
  ownedWorkspaceIds.push(ws.id);
  vi.spyOn(stateStore, "loadState").mockResolvedValue({ asset: { name: "Secretbrand" }, sources: [], tactics: [] } as unknown as Awaited<ReturnType<typeof stateStore.loadState>>);
  const ids: string[] = [];
  for (let i = 0; i < 6; i++) {
    const id = (await recordDecisionExample({ workspace_id: ws.id, stage: "S2", kind: "gap_suggestion", subject_id: `subject-${i}`, run_id: `run-${i}`, ai_input: { text: "Secretbrand raw customer input" }, ai_output: { answer: "private answer" }, final: { answer: "private reviewer answer" }, rationale: "private rationale", outcome: i === 0 ? "accepted" : "edited", replay_input: i === 5 ? undefined : { snapshot: { value: i } } }))!;
    await sharedDb().execute(sql`update decision_examples set lesson_status = 'ok', lesson = 'Reviewers keep a narrower population separate.', created_at = ${`2026-10-0${i + 1}T12:00:00Z`} where id = ${id}`);
    ids.push(id);
  }
  return { ws, ids };
}
/** Build a valid S8 cohort, leaving the S2 lesson fixture independent. */
function proposeWithEvidence(workspaceId: string) {
  const route = {
    stage: "S8", provider_id: "xai-grok", provider_label: "xAI", model: "grok-4",
    connected: true, auth: "api_key", degraded: false, fallbacks: [], reason: null,
    params: { temperature: 0, max_tokens: 2000 },
  } satisfies ResolvedRoute;
  vi.spyOn(approvedRoutes, "approvedEvaluationRoute").mockResolvedValue(route);
  vi.spyOn(examples, "listDecisionExamples").mockImplementation(async ({ stage }) => {
    expect(stage).toBe("S8");
    const implementation = await activeModule("S8");
    return [1, 2, 3, 4, 5].map(index => {
      const example = priorityReviewExample(index, route, workspaceId);
      return {
        ...example,
        lesson: index % 2 ? "Check competing interpretations." : "Separate overlapping populations.",
        replay_input: {
          ...example.replay_input!,
          module_id: implementation.manifest.id,
          module_version: implementation.manifest.version,
        },
      };
    });
  });
  return proposePromptRevision({ stage: "S8", workspace_id: workspaceId, actor, exclude_ids: [] });
}

describe("learning run ownership", () => {
  it.each(["lesson", "revision"] as const)("discards a delayed %s response after the run owner disconnects", async kind => {
    const { ws, ids } = await fixture();
    await sharedDb().execute(sql`update decision_examples set lesson_status = 'pending', lesson = null where id = ${ids[0]}`);
    const entered = Promise.withResolvers<number>();
    const release = Promise.withResolvers<void>();
    const lateWork = Promise.withResolvers<void>();
    let released = false;
    // Wait until the detached work attempts to publish or leaves its savepoint.
    // This also catches a regression to publishing through the independent pool.
    const originalTransaction = transactions.withWorkspaceTransaction;
    vi.spyOn(transactions, "withWorkspaceTransaction").mockImplementation(work => originalTransaction(async () => {
      try { return await work(); } finally { if (released) lateWork.resolve(); }
    }));
    const originalClose = observations.closeRun;
    vi.spyOn(observations, "closeRun").mockImplementation(args => {
      if (released) lateWork.resolve();
      return originalClose(args);
    });
    vi.stubEnv("XAI_API_KEY", "synthetic-test-key");
    vi.spyOn(llm, "isTestStub").mockReturnValue(false);
    const http = vi.fn(async () => {
      const [owner] = await db().execute(sql`select pg_backend_pid() as pid`);
      entered.resolve(Number(owner.pid));
      await release.promise;
      const content = JSON.stringify({ lesson: "Reviewers separate distinct populations.", instruction_text: "Separate distinct populations." });
      return Response.json({ choices: [{ message: { content: kind === "lesson" ? content : JSON.stringify({ instruction_text: "Separate distinct populations." }) } }] });
    });
    vi.stubGlobal("fetch", http);
    const processing = (kind === "lesson" ? computeLesson(ids[0]) : proposeWithEvidence(ws.id)).catch(error => error);
    try {
      const owner = await Promise.race([entered.promise, processing.then(result => { throw new Error(String(result)); })]);
      const [disconnected] = await sharedDb().execute(sql`select pg_terminate_backend(${owner}::integer, 5000) as ok`);
      expect(disconnected.ok).toBe(true);
      const result = await processing;
      if (kind === "lesson") expect(result).toBe("failed");
      else expect(result).toBeInstanceOf(Error);
      const runsTable = sql`${sql.identifier(ws.schema_name)}.module_runs`;
      const [failed] = await sharedDb().execute(sql`select * from ${runsTable} where status = 'error'`);
      expect(failed).toBeDefined();
      released = true;
      release.resolve();
      await lateWork.promise;
      expect(await getDecisionExample(ids[0])).toMatchObject({ lesson_status: kind === "lesson" ? "failed" : "pending", lesson: null });
      expect(await listPromptRevisions(ws.id)).toEqual([]);
      expect(await sharedDb().execute(sql`select id from prompt_revision_cohorts where workspace_id = ${ws.id}`)).toHaveLength(0);
      expect(await sharedDb().execute(sql`select id from audit_events where run_id = ${failed.id} and action = 'prompt.generate'`)).toHaveLength(0);
      expect(await sharedDb().execute(sql`select * from ${runsTable} where id = ${failed.id}`)).toEqual([failed]);
      expect(http).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it.each(["lesson", "revision"] as const)("records an overdue %s failure before releasing the run to recovery", async kind => {
    const { ws, ids } = await fixture();
    await sharedDb().execute(sql`update decision_examples set lesson_status = 'pending', lesson = null where id = ${ids[0]}`);
    vi.spyOn(llm, "isTestStub").mockReturnValue(false);
    vi.stubEnv("XAI_API_KEY", "synthetic-test-key");
    const diagnostic = "Synthetic learning diagnostic";
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { message: diagnostic } }, { status: 400 })));
    const table = sql`${sql.identifier(ws.schema_name)}.module_runs`;
    const insertRun = observations.openRun;
    vi.spyOn(observations, "openRun").mockImplementation(async recorder => {
      await insertRun(recorder);
      await sharedDb().execute(sql`update ${table} set started_at = '2000-01-01' where id = ${recorder.id}`);
    });
    const originalClose = observations.closeRun;
    vi.spyOn(observations, "closeRun").mockImplementation(async args => {
      await sharedDb().execute(sql`update ${table} set status = 'error', error = 'Interrupted' where id in (
        select id from ${table} where id = ${args.recorder.id} and status = 'running' and started_at = '2000-01-01' for update skip locked)`);
      return originalClose(args);
    });
    try {
      if (kind === "lesson") expect(await computeLesson(ids[0])).toBe("failed");
      else await expect(proposeWithEvidence(ws.id)).rejects.toThrow();
      const [failed] = await sharedDb().execute(sql`select error from ${table} where status = 'error'`);
      expect(failed?.error).toContain(diagnostic);
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });
  it("commits an S8 candidate, its frozen cohort and its completed run together", async () => {
    const { ws } = await fixture();
    vi.spyOn(llm, "isTestStub").mockReturnValue(false);
    vi.stubEnv("XAI_API_KEY", "synthetic-test-key");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      choices: [{ message: { content: JSON.stringify({ instruction_text: "Separate distinct populations." }) } }],
    })));
    try {
      const revision = await proposeWithEvidence(ws.id);
      expect(await listPromptRevisions(ws.id)).toEqual([revision]);
      const cohort = await getRevisionCohort(revision.cohort_id, ws.id);
      expect(cohort?.heldout_ids).toHaveLength(3);
      expect(cohort?.training_ids).toHaveLength(2);
      const [run] = await sharedDb().execute(
        sql`select status from ${sql.identifier(ws.schema_name)}.module_runs where id = ${revision.generation_run_id}`,
      );
      expect(run?.status).toBe("ok");
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });
});
