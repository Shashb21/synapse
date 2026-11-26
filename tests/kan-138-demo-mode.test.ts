import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// A one-call recording, so the test does not depend on the recorded demo run.
vi.mock("@/lib/demo/recording-replay.json", async () => {
  const { createHash } = await import("node:crypto");
  const hash = (parts: unknown[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
  return {
    default: {
      version: 3,
      fixture: "velmara-client-demo",
      recorded_at: "2026-10-16T10:00:00Z",
      calls: [{
        stage: "S8",
        purpose_hash: hash(["literal","priority-suggester"]),
        system_hash: hash(["literal","You suggest priority bands."]),
        user_hash: hash(["json",{gaps:[{id:null,name:"Economic burden"}]},[[["gaps",0,"id"],"",["GAP",0],""]]]),
        ids: ["GAP-001"],
        reply: '{"gaps":[{"gap_id":"GAP-001","band":"high"}]}',
      }],
    },
  };
});

import "@/modules";
import { randomBytes } from "node:crypto";
import { demoExecutionFor, isDemoModeWorkspace } from "@/lib/demo/mode";
import { CLIENT_DEMO_PACK } from "@/lib/demo/client-pack";
import { completionFor, resolveRoute } from "@/modules/kernel/routing";
import { listLlmCalls } from "@/modules/kernel/llm-calls";
import { uploadModule } from "@/modules/stages/s0-upload/module";
import { createWorkspace, getWorkspace, setWorkspaceDemoMode, withWorkspace, type Workspace } from "@/modules/workspaces/store";
import { replaceContentsOf } from "@/modules/workspaces/contents";
import { loadState } from "@/lib/iegp/store";
import type { ModuleContext, RunHandle } from "@/modules/kernel/contracts";
import { advanceIngest } from "@/app/api/iegp/ingest-pipeline";
import { listRuns } from "@/modules/kernel/observability";

/** KAN-138: in a client-demo workspace AI steps replay the recording, and only demo files upload. */

const unique = randomBytes(4).toString("hex");
let demo: Workspace;
let normal: Workspace;

const fakeRun = (workspace_id: string): RunHandle =>
  ({
    id: `run_kan138_${unique}_${Math.random().toString(36).slice(2, 6)}`,
    workspace_id,
    step: async (_name: string, fn: () => Promise<unknown>) => fn(),
    note: () => undefined,
  }) as unknown as RunHandle;

const uploadCtx = (workspace_id: string) =>
  ({ workspace_id, actor: { name: "Presenter", function: "medical_affairs" }, run: fakeRun(workspace_id) }) as unknown as ModuleContext;

beforeAll(async () => {
  vi.stubEnv("SYNAPSE_DEMO_REPLAY_DELAY_MS", "0");
  demo = await createWorkspace({ name: `KAN-138 demo ${unique}`, owner: `kan138.${unique}@example.com` });
  normal = await createWorkspace({ name: `KAN-138 normal ${unique}`, owner: `kan138.${unique}@example.com` });
  await setWorkspaceDemoMode(demo.id, true);
  await replaceContentsOf(demo.id, "client_demo");
  demo = (await getWorkspace(demo.id))!;
}, 60_000);

afterAll(() => {
  vi.unstubAllEnvs();
});

describe("client demo mode", () => {
  it("starts at upload with setup done and nothing ingested", async () => {
    const state = await withWorkspace(demo.id, () => loadState());
    expect(state.asset.name).toBe("Velmara");
    expect(state.asset.setup_complete).toBe(true);
    expect(state.sources).toHaveLength(0);
    expect(state.gaps).toHaveLength(0);
  });

  it("routes a demo workspace's AI to the recording, and leaves other workspaces alone", async () => {
    expect(await isDemoModeWorkspace(demo.id)).toBe(true);
    expect(await isDemoModeWorkspace(normal.id)).toBe(false);
    const route = await withWorkspace(demo.id, () => resolveRoute("S8", undefined, demoExecutionFor(demo)));
    expect(route).toMatchObject({ provider_id: "demo-replay", connected: true, auth: "none" });
    const unqualified = await withWorkspace(demo.id, () => resolveRoute("S8").catch((error: Error) => error));
    expect(unqualified instanceof Error ? unqualified.message : unqualified.provider_id).not.toBe("demo-replay");
    const other = await withWorkspace(normal.id, () => resolveRoute("S8").catch((error: Error) => error));
    await expect(withWorkspace(normal.id, () => resolveRoute("S8", undefined, demoExecutionFor(demo)))).rejects.toMatchObject({ code: "demo_replay_miss" });
    expect(other instanceof Error ? other.message : other.provider_id).not.toBe("demo-replay");
  });

  it("answers from the recording under this run's ids, and logs it as a replay", async () => {
    const run = fakeRun(demo.id);
    const result = await withWorkspace(demo.id, async () => {
      const route = await resolveRoute("S8", undefined, demoExecutionFor(demo));
      return completionFor(route, run)({
        system: "You suggest priority bands.",
        user: '{"gaps":[{"id":"GAP-057","name":"Economic burden"}]}',
        purpose: "priority-suggester",
      });
    });
    expect(result).toEqual({ gaps: [{ gap_id: "GAP-057", band: "high" }] });
    const calls = await listLlmCalls(run.id);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ provider_id: "demo-replay", model: "recorded", status: "ok", stage: "S8", demo_fixture: "velmara-client-demo", cost_usd: 0 });
  });

  it("explains a step the recording does not have", async () => {
    const run = fakeRun(demo.id);
    const failure = await withWorkspace(demo.id, async () =>
      completionFor(await resolveRoute("S9", undefined, demoExecutionFor(demo)), run)({ system: "s", user: "u", purpose: "ideation-proposer" }).catch((error: Error) => error),
    );
    expect(String(failure)).toMatch(/recorded Velmara demo has no answer/);
  });

  it("uploads a client demo document, and refuses anything else before storing it", async () => {
    const doc = CLIENT_DEMO_PACK[2]!;
    const ok = await withWorkspace(demo.id, () =>
      uploadModule.run(
        { files: [{ filename: "renamed.txt", title: "Whatever", source_type: "other_internal", stakeholder_function: "heor", text: doc.text }], demo_ids: [], reuse_existing: false },
        uploadCtx(demo.id),
      ),
    );
    // It takes the document's own name and details, as the recording does.
    expect(ok.output.files.map((f) => f.filename)).toEqual([doc.filename]);

    const refused = await withWorkspace(demo.id, () =>
      uploadModule
        .run(
          { files: [{ filename: "our-strategy.txt", title: "Ours", source_type: "other_internal", stakeholder_function: "heor", text: "A client's own plan." }], demo_ids: [], reuse_existing: false },
          uploadCtx(demo.id),
        )
        .catch((error: Error) => error),
    );
    expect(String(refused)).toMatch(/our-strategy\.txt is not one of the demo files/);
  });

  it("does not restrict uploads in a normal workspace", async () => {
    const ok = await withWorkspace(normal.id, () =>
      uploadModule.run(
        { files: [{ filename: "our-strategy.txt", title: "Ours", source_type: "other_internal", stakeholder_function: "heor", text: `A client's own plan ${unique}.` }], demo_ids: [], reuse_existing: false },
        uploadCtx(normal.id),
      ),
    );
    expect(ok.output.files.map((f) => f.filename)).toEqual(["our-strategy.txt"]);
  });

  it("KAN-263 retains a navigable failed ingest run and its call without applying or advancing the stage", async () => {
    vi.stubEnv("SYNAPSE_TEST_STUB_LLM", "0");
    const file = CLIENT_DEMO_PACK[0]!;
    const args = { actor: { name: "Presenter", function: "medical_affairs" as const }, role: "medical_affairs" as const, demo: demoExecutionFor(demo) };
    await withWorkspace(demo.id, async () => {
      const uploaded = await advanceIngest({ ...args, demo_ids: [file.id] });
      expect(uploaded).toMatchObject({ stage: "S1", completed: 1, done: false });
      for (let i = 0; i < 2; i++) {
        // The test fixture intentionally covers S8 only, so this S1 request misses.
        await expect(advanceIngest({ ...args, job_id: uploaded.job_id })).rejects.toMatchObject({ code: "demo_replay_miss" });
      }
      const failures = await listRuns({ stage: "S1" });
      expect(failures).toHaveLength(2);
      for (const failed of failures) {
        expect(failed).toMatchObject({ status: "error", route: { provider_id: "demo-replay" } });
        const [call] = await listLlmCalls(failed.id);
        expect(call).toMatchObject({ status: "error", provider_id: "demo-replay", purpose: "parse-structure:1" });
        expect(JSON.stringify(failed.steps)).toContain(call.id);
      }
      expect((await loadState()).sources).toHaveLength(0);
    });
  });
});
