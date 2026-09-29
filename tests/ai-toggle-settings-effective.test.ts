import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
}));

import "@/modules";
import { resetDemoSetup } from "@/lib/iegp/store";
import {
  AiDisabledError,
  aiEnabled,
  aiState,
  assertAiEnabled,
  platformAiEnabled,
  setAiEnabled,
  workspaceAiEnabled,
} from "@/modules/kernel/ai-switch";
import { runStage } from "@/modules/kernel/run";
import { listRuns } from "@/modules/kernel/observability";
import { setWorkspaceAiEnabled } from "@/modules/workspaces/ai-setting";
import { createWorkspace, withWorkspace, type Workspace } from "@/modules/workspaces/store";

/**
 * Effective AI = the platform master switch AND the workspace's own AI
 * assistance setting, resolved for whichever workspace the query runs in.
 */

const unique = Math.random().toString(36).slice(2, 8);
const OWNER = `ai-toggle-owner-${unique}@example.com`;
const ACTOR = { name: "AI Toggle Owner", function: "medical_affairs" as const };

let a: Workspace;
let b: Workspace;

async function setWorkspaceAi(workspace: Workspace, enabled: boolean) {
  return setWorkspaceAiEnabled({ workspace_id: workspace.id, enabled, principal: OWNER, actor: ACTOR });
}

describe("AI toggle in settings: effective AI", () => {
  beforeAll(async () => {
    await setAiEnabled({ enabled: true, actor_name: ACTOR.name });
    a = await createWorkspace({ name: `AI toggle A ${unique}`, owner: OWNER, ai_enabled: true });
    b = await createWorkspace({ name: `AI toggle B ${unique}`, owner: OWNER, ai_enabled: true });
  }, 60_000);
  afterAll(async () => {
    // Leave AI on for every other test file.
    await setAiEnabled({ enabled: true, actor_name: ACTOR.name });
  });

  it("a new workspace starts with AI assistance off unless asked for (KAN-52)", async () => {
    const plain = await createWorkspace({ name: `AI default ${unique}`, owner: OWNER });
    expect(plain.ai_enabled).toBe(false);
    expect(await workspaceAiEnabled(plain.id)).toBe(false);
    expect(await withWorkspace(plain.id, aiEnabled)).toBe(false);
    expect(a.ai_enabled).toBe(true);
    expect(await workspaceAiEnabled(a.id)).toBe(true);
    expect(await withWorkspace(a.id, aiEnabled)).toBe(true);
  });

  it("is the platform switch AND the workspace setting", async () => {
    await setWorkspaceAi(a, false);
    expect(await withWorkspace(a.id, aiState)).toMatchObject({
      enabled: false,
      platform: true,
      workspace: false,
      workspace_id: a.id,
      off_by: "workspace",
    });
    await expect(withWorkspace(a.id, () => assertAiEnabled("Test"))).rejects.toBeInstanceOf(AiDisabledError);

    await setWorkspaceAi(a, true);
    expect(await withWorkspace(a.id, aiState)).toMatchObject({ enabled: true, off_by: null });
  });

  it("turning workspace A off does not touch workspace B or the platform", async () => {
    await setWorkspaceAi(a, false);
    expect(await withWorkspace(a.id, aiEnabled)).toBe(false);
    expect(await withWorkspace(b.id, aiEnabled)).toBe(true);
    expect(await platformAiEnabled()).toBe(true);
    await setWorkspaceAi(a, true);
  });

  it("the platform master switch turns AI off everywhere, whatever each workspace says", async () => {
    await setAiEnabled({ enabled: false, actor_name: ACTOR.name });
    try {
      for (const workspace of [a, b]) {
        expect(await withWorkspace(workspace.id, aiState)).toMatchObject({
          enabled: false,
          platform: false,
          workspace: true,
          off_by: "platform",
        });
      }
      // Both off: the platform is the one to name.
      await setWorkspaceAi(a, false);
      expect((await withWorkspace(a.id, aiState)).off_by).toBe("platform");
    } finally {
      await setAiEnabled({ enabled: true, actor_name: ACTOR.name });
      await setWorkspaceAi(a, true);
    }
    expect(await withWorkspace(a.id, aiEnabled)).toBe(true);
  });

  it("outside any workspace scope only the platform switch counts", async () => {
    await setWorkspaceAi(a, false);
    try {
      expect(await aiState(null)).toMatchObject({ enabled: true, workspace_id: null });
    } finally {
      await setWorkspaceAi(a, true);
    }
  });

  it("an AI stage in an AI-off workspace throws AiDisabledError while another workspace still runs it", async () => {
    await withWorkspace(a.id, resetDemoSetup);
    await withWorkspace(b.id, resetDemoSetup);
    await setWorkspaceAi(a, false);
    try {
      const before = (await withWorkspace(a.id, () => listRuns({ limit: 500 }))).length;
      await expect(
        withWorkspace(a.id, () =>
          runStage({ stage: "S9", input: { per_gap: 1 }, actor: ACTOR, role: "medical_affairs", workspace_id: a.id }),
        ),
      ).rejects.toBeInstanceOf(AiDisabledError);
      // Refused before a run is opened.
      expect((await withWorkspace(a.id, () => listRuns({ limit: 500 }))).length).toBe(before);

      // Workspace B runs the same stage under the test stub LLM.
      const run = await withWorkspace(b.id, () =>
        runStage({ stage: "S9", input: { per_gap: 1 }, actor: ACTOR, role: "medical_affairs", workspace_id: b.id }),
      );
      expect(run.run_id).toBeTruthy();
      expect(run.stage).toBe("S9");

      // Mechanical stages still run in the AI-off workspace.
      const s7 = await withWorkspace(a.id, () => runStage({ stage: "S7", input: {}, actor: ACTOR, role: "medical_affairs" }));
      expect(s7.run_id).toBeTruthy();
    } finally {
      await setWorkspaceAi(a, true);
    }
  }, 120_000);
});
