/** Persisted candidates keep held-out lineage away from model inputs and live prompts. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { sharedDb } from "@/modules/kernel/db";
import { recordDecisionExample } from "@/modules/kernel/decision-examples";
import * as stateStore from "@/lib/iegp/store";
import * as routing from "@/modules/kernel/routing";
import * as llm from "@/modules/kernel/llm";
import { activePromptVersion } from "@/modules/kernel/prompt-variant";
import { createWorkspace } from "@/modules/workspaces/store";
import { AiDisabledError, setAiEnabled } from "@/modules/kernel/ai-switch";
import { freezeRevisionCohort, getRevisionCohort, getPromptRevision, listPromptRevisions, proposePromptRevision } from "@/modules/kernel/prompt-revisions";

const actor = { name: "Owner", function: "medical_affairs" as const };
afterEach(async () => { vi.restoreAllMocks(); await setAiEnabled({ enabled: true, actor_name: "test" }); });
async function fixture() {
  const ws = await createWorkspace({ name: `revision-${crypto.randomUUID()}`, owner: "revision-test" });
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
