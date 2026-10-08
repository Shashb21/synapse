import * as llm from "@/modules/kernel/llm";
import * as workspaceStore from "@/modules/workspaces/store";
import { runAgenticCycle } from "@/modules/kernel/agentic";
import { RunRecorder } from "@/modules/kernel/observability";
import type { ModuleContext } from "@/modules/kernel/contracts";
/** Behavioral privacy boundaries and held-out exclusion for decision learning. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { sharedDb } from "@/modules/kernel/db";
import * as stateStore from "@/lib/iegp/store";
import { createWorkspace, setLearningSharingEligible, learningSharingEligible } from "@/modules/workspaces/store";
import { runInWorkspace, scopedWorkspaceId } from "@/modules/workspaces/context";
import { computeLesson, getDecisionExample, recordDecisionExample, similarExamples, withLearningExclusions, workedExamplesAsPrompt } from "@/modules/kernel/decision-examples";

const unique = () => `privacy-${crypto.randomUUID()}`;
const ownedWorkspaceIds: string[] = [];
async function workspace() {
  const ws = await createWorkspace({ name: unique(), owner: "privacy-test" });
  ownedWorkspaceIds.push(ws.id);
  return ws;
}
async function example(workspace_id: string) {
  return (await recordDecisionExample({ workspace_id, stage: "S2", kind: "gap_suggestion", subject_id: unique(), ai_input: { text: "secretbrand corneal population" }, ai_output: {}, outcome: "accepted" }))!;
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const id of ownedWorkspaceIds.splice(0)) {
    await setLearningSharingEligible(id, false);
    expect(await learningSharingEligible(id)).toBe(false);
  }
});

describe("decision learning fails closed", () => {
  it("loads the recorded workspace rather than the ambient workspace", async () => {
    const a = await workspace(); const b = await workspace(); const id = await example(b.id);
    const loaded: (string | null)[] = [];
    vi.spyOn(stateStore, "loadState").mockImplementation(async () => {
      const ws = await scopedWorkspaceId(); loaded.push(ws);
      return { asset: { name: ws === b.id ? "secretbrand" : "otherbrand" }, sources: [], tactics: [] } as unknown as Awaited<ReturnType<typeof stateStore.loadState>>;
    });
    const result = await runInWorkspace({ workspace_id: a.id, schema: a.schema_name }, () => computeLesson(id, async () => ({ lesson: "Reviewers keep secretbrand population separate." })));
    expect(loaded).toEqual([b.id]); expect(result).toBe("failed"); expect((await getDecisionExample(id))?.lesson).toBeNull();
  });

  it("refuses sharing when entity lookup fails", async () => {
    const b = await workspace(); const id = await example(b.id);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(stateStore, "loadState").mockRejectedValue(new Error("entity context unavailable"));
    expect(await computeLesson(id, async () => ({ lesson: "Reviewers keep a narrower population separate." }))).toBe("failed");
    expect((await getDecisionExample(id))?.lesson).toBeNull();
    expect(logged).toHaveBeenCalledExactlyOnceWith("[learning] entity context unavailable", id, expect.objectContaining({message:"entity context unavailable"}));
    logged.mockRestore();
    vi.spyOn(stateStore, "loadState").mockResolvedValue({ asset: { name: "Brand" }, sources: [], tactics: [] } as unknown as Awaited<ReturnType<typeof stateStore.loadState>>);
    expect(await computeLesson(id, async () => ({ lesson: "Reviewers keep a narrower population separate." }))).toBe("ok");
  });

  it("defaults sharing off, requires both workspaces, revalidates lessons and excludes held-out IDs", async () => {
    const a = await workspace(); const b = await workspace(); const foreign = await example(b.id); const own = await example(a.id);
    await sharedDb().execute(sql`update decision_examples set lesson = 'Reviewers keep a narrower population separate.', lesson_status = 'ok' where id = ${foreign}`);
    const query = { stage: "S2" as const, text: "narrower population", workspace_id: a.id };
    expect(await learningSharingEligible(a.id)).toBe(false);
    expect((await similarExamples(query)).map(x => x.id)).not.toContain(foreign);
    await setLearningSharingEligible(b.id, true);
    expect((await similarExamples({ ...query, allow_cross_workspace: true })).map(x => x.id)).not.toContain(foreign);
    await setLearningSharingEligible(a.id, true);
    vi.spyOn(stateStore, "loadState").mockResolvedValue({ asset: { name: "secretbrand" }, sources: [], tactics: [] } as unknown as Awaited<ReturnType<typeof stateStore.loadState>>);
    await setLearningSharingEligible(b.id, false);
    expect((await similarExamples({ ...query, allow_cross_workspace: true })).map(x => x.id)).not.toContain(foreign);
    await setLearningSharingEligible(b.id, true);
    const shared = await similarExamples({ ...query, allow_cross_workspace: true });
    expect(shared.map(x => x.id)).toContain(foreign); expect(workedExamplesAsPrompt(shared.filter(x => x.scope === "other_plans"))).not.toContain("secretbrand");
    const excluded = await withLearningExclusions([own], () => similarExamples({ ...query, allow_cross_workspace: true, exclude_ids: [foreign] }));
    expect(excluded.map(x => x.id)).not.toContain(own); expect(excluded.map(x => x.id)).not.toContain(foreign);
    await sharedDb().execute(sql`update decision_examples set lesson = 'Reviewers keep secretbrand population separate.' where id = ${foreign}`);
    expect((await similarExamples({ ...query, allow_cross_workspace: true })).map(x => x.id)).not.toContain(foreign);
  });

  it("does not rank foreign examples using their raw text", async () => {
    const a = await workspace(); const b = await workspace(); const id = await example(b.id);
    await setLearningSharingEligible(a.id, true); await setLearningSharingEligible(b.id, true);
    await sharedDb().execute(sql`update decision_examples set lesson = 'Reviewers keep a narrower population separate.', lesson_status = 'ok' where id = ${id}`);
    vi.spyOn(stateStore, "loadState").mockResolvedValue({ asset: { name: "secretbrand" }, sources: [], tactics: [] } as unknown as Awaited<ReturnType<typeof stateStore.loadState>>);
    expect((await similarExamples({ stage: "S2", text: "corneal", workspace_id: a.id, allow_cross_workspace: true })).map(x => x.id)).not.toContain(id);
  });
});


describe("request-scoped exclusions at the agentic boundary", () => {
  it("withholds held-out case IDs from proposer hints and traces and restores normal lookup afterwards", async () => {
    const ws = await workspace(); const id = await example(ws.id);
    const recorder = new RunRecorder({ workspace_id: ws.id, stage: "S2", module_id: "privacy-test", module_version: "test", actor: { name: "Test", function: "medical_affairs" }, input: {} });
    const hints: string[] = [];
    const ctx = { workspace_id: ws.id, run: recorder } as unknown as ModuleContext;
    await withLearningExclusions([id], () => runAgenticCycle(ctx, "S2", {
      subjectOf: (candidate: { id: string }) => candidate.id,
      proposer: { local: ({ hints: prompt }) => { hints.push(prompt); return [{ id: "candidate" }]; } },
      critic: () => [{ subject: "candidate", verdict: "keep", note: "keep", score: 90 }],
      judge: ({ candidates }) => candidates.map(candidate => ({ candidate, subject: candidate.id, verdict: "accept", note: "accept", score: 90 })),
    }, { kinds: ["gap_suggestion"], text: "corneal population" }));
    expect(hints).toHaveLength(4); expect(hints.join(" ")).not.toContain(id);
    expect(recorder.steps().find(step => step.name === "learning:worked-examples")?.data).toEqual({ used: [] });
    expect((await similarExamples({ stage: "S2", workspace_id: ws.id, text: "corneal population" })).map(row => row.id)).toContain(id);
  });

  it("unwinds exclusions after a failed callback and rejects an unknown eligibility setting", async () => {
    const ws = await workspace(); const id = await example(ws.id);
    await expect(withLearningExclusions([id], async () => { throw new Error("evaluation failed"); })).rejects.toThrow("evaluation failed");
    expect((await similarExamples({ stage: "S2", workspace_id: ws.id, text: "corneal population" })).map(row => row.id)).toContain(id);
    await expect(setLearningSharingEligible("missing-workspace", true)).rejects.toThrow("no longer exists");
  });
});


describe("reserved default workspace context", () => {
  it("uses the existing public mapping when its registry row is absent, and fails closed on lookup errors", async () => {
    const id = await example("default");
    vi.spyOn(workspaceStore, "getWorkspace").mockResolvedValue(null);
    const loaded: (string | null)[] = [];
    vi.spyOn(stateStore, "loadState").mockImplementation(async () => {
      loaded.push(await scopedWorkspaceId());
      return { asset: { name: "Originalbrand" }, sources: [], tactics: [] } as unknown as Awaited<ReturnType<typeof stateStore.loadState>>;
    });
    expect(await computeLesson(id, async () => ({ lesson: "Reviewers keep a narrower population separate." }))).toBe("ok");
    expect(loaded).toEqual(["default"]);
    const skipped = vi.spyOn(llm,"isTestStub");
    const another = await example("default");
    // Wait for the queued stub lesson to finish before injecting the retry failure.
    await vi.waitFor(() => expect(skipped).toHaveBeenCalled());
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(workspaceStore, "getWorkspace").mockRejectedValue(new Error("workspace registry unavailable"));
    expect(await computeLesson(another, async () => ({ lesson: "Reviewers keep a narrower population separate." }))).toBe("failed");
    expect(logged).toHaveBeenCalledExactlyOnceWith("[learning] lesson processing failed", another, expect.objectContaining({message:"workspace registry unavailable"}));
    logged.mockRestore();
    expect((await getDecisionExample(another))?.lesson).toBeNull();
  });
});
