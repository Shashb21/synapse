/** Persisted candidates keep held-out lineage away from model inputs and live prompts. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { db, sharedDb } from "@/modules/kernel/db";
import { computeLesson, getDecisionExample, recordDecisionExample } from "@/modules/kernel/decision-examples";
import * as observations from "@/modules/kernel/observability";
import * as transactions from "@/lib/iegp/db";
import * as stateStore from "@/lib/iegp/store";
import * as routing from "@/modules/kernel/routing";
import * as llm from "@/modules/kernel/llm";
import { activePromptVersion } from "@/modules/kernel/prompt-variant";
import { createWorkspace, setLearningSharingEligible, learningSharingEligible } from "@/modules/workspaces/store";
import { AiDisabledError, setAiEnabled } from "@/modules/kernel/ai-switch";
import { freezeRevisionCohort, getRevisionCohort, getPromptRevision, listPromptRevisions, proposePromptRevision } from "@/modules/kernel/prompt-revisions";

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
describe("prompt revision generation", () => {
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
    const processing = (kind === "lesson" ? computeLesson(ids[0]) : proposePromptRevision({ stage: "S2", workspace_id: ws.id, actor, exclude_ids: [] })).catch(error => error);
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
      else await expect(proposePromptRevision({ stage: "S2", workspace_id: ws.id, actor, exclude_ids: [] })).rejects.toThrow();
      const [failed] = await sharedDb().execute(sql`select error from ${table} where status = 'error'`);
      expect(failed?.error).toContain(diagnostic);
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });
  it("freezes linked run and subject decisions in one held-out group", async () => {
    const { ws, ids } = await fixture();
    await sharedDb().execute(sql`update decision_examples set run_id = 'run-5' where id = ${ids[4]}`);
    await sharedDb().execute(sql`update decision_examples set subject_id = 'subject-4' where id = ${ids[3]}`);
    const cohort = await freezeRevisionCohort({ stage: "S2", workspace_id: ws.id, exclude_ids: [] });
    expect(cohort.heldout_ids).toEqual(expect.arrayContaining(ids.slice(3)));
    expect(cohort.training_ids.some(id => cohort.heldout_ids.includes(id))).toBe(false);
    expect(await getRevisionCohort(cohort.id, ws.id)).toEqual(cohort);
    expect(await getRevisionCohort(cohort.id, "foreign")).toBeNull();
    expect(cohort.replay_exclusions).toMatchObject({ [ids[5]]: expect.stringContaining("frozen") });
  });
  it("only sends revalidated disagreement lessons, persists evidence and never activates", async () => {
    const { ws, ids } = await fixture();
    await sharedDb().execute(sql`update decision_examples set lesson = 'Reviewers keep Secretbrand separate.' where id = ${ids[2]}`);
    vi.spyOn(llm, "isTestStub").mockReturnValue(false);
    vi.spyOn(routing, "resolveRoute").mockResolvedValue({ stage: "S2", provider_id: "xai", model: "grok-4", connected: true, auth: "api_key" } as Awaited<ReturnType<typeof routing.resolveRoute>>);
    const complete = vi.fn(async () => ({ instruction_text: "Keep distinct decision questions separate." }));
    vi.spyOn(routing, "completionFor").mockReturnValue(complete);
    const before = activePromptVersion();
    const candidate = await proposePromptRevision({ stage: "S2", workspace_id: ws.id, actor, exclude_ids: [ids[1]] });
    const call = JSON.stringify(complete.mock.calls);
    expect(call).toContain("Reviewers keep a narrower population separate.");
    for (const secret of [...ids, "Secretbrand", "private answer", "private reviewer answer", "private rationale", "raw customer input"]) expect(call).not.toContain(secret);
    expect(candidate.state).toBe("candidate"); expect(candidate.parent_revision).toBe(before);
    expect(candidate.training_ids).toEqual([ids[3]]);
    expect(candidate.heldout_ids).toEqual(expect.arrayContaining(ids.slice(4)));
    expect(candidate.excluded_ids).toContain(ids[1]);
    expect(await getPromptRevision(candidate.id, ws.id)).toEqual(candidate);
    const second = await proposePromptRevision({ stage: "S2", workspace_id: ws.id, actor, exclude_ids: [] });
    expect(second.id).not.toBe(candidate.id); expect(await getPromptRevision(candidate.id, ws.id)).toEqual(candidate);
    expect((await listPromptRevisions(ws.id)).length).toBe(2); expect(activePromptVersion()).toBe(before);
    expect(await getPromptRevision(candidate.id, "foreign")).toBeNull();
    await expect(sharedDb().execute(sql`update prompt_revisions set instruction_text = 'changed' where id = ${candidate.id}`)).rejects.toThrow();
    await expect(sharedDb().execute(sql`update prompt_revision_cohorts set heldout_ids = '[]'::jsonb where id = ${candidate.cohort_id}`)).rejects.toThrow();
    expect(await getPromptRevision(candidate.id, ws.id)).toEqual(candidate);
  });
  it("fails closed for empty context, invalid generation and AI off without saving a candidate", async () => {
    const { ws } = await fixture();
    vi.spyOn(stateStore, "loadState").mockResolvedValue({ asset: {}, sources: [], tactics: [] } as unknown as Awaited<ReturnType<typeof stateStore.loadState>>);
    await expect(proposePromptRevision({ stage: "S2", workspace_id: ws.id, actor, exclude_ids: [] })).rejects.toThrow("entity context");
    vi.spyOn(stateStore, "loadState").mockResolvedValue({ asset: { name: "Secretbrand" }, sources: [], tactics: [] } as unknown as Awaited<ReturnType<typeof stateStore.loadState>>);
    vi.spyOn(llm, "isTestStub").mockReturnValue(false);
    vi.spyOn(routing, "resolveRoute").mockResolvedValue({ stage: "S2" } as Awaited<ReturnType<typeof routing.resolveRoute>>);
    vi.spyOn(routing, "completionFor").mockReturnValue(async () => ({ instruction_text: "" }));
    await expect(proposePromptRevision({ stage: "S2", workspace_id: ws.id, actor, exclude_ids: [] })).rejects.toThrow();
    await setAiEnabled({ enabled: false, actor_name: "test" });
    await expect(proposePromptRevision({ stage: "S2", workspace_id: ws.id, actor, exclude_ids: [] })).rejects.toThrow(AiDisabledError);
    expect(await listPromptRevisions(ws.id)).toEqual([]);
  });
  it("supports S3 while explicitly refusing generation without disagreement evidence", async () => {
    const { ws } = await fixture();
    await expect(proposePromptRevision({ stage: "S3", workspace_id: ws.id, actor, exclude_ids: [] })).rejects.toThrow("No validated disagreement lessons");
  });

});
