import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ scope: "demo", enabled: true }));
vi.mock("@/modules/workspaces/context", () => ({ scopedWorkspaceId: async () => state.scope }));
vi.mock("@/modules/workspaces/store", () => ({
  getWorkspace: async (id: string) => ({ id, demo_mode: id === "demo" && state.enabled }),
}));
vi.mock("@/modules/llm/api-keys", async importOriginal => ({
  ...await importOriginal<typeof import("@/modules/llm/api-keys")>(),
  providerConfigured: () => true,
}));

import { demoExecutionFor, isDemoModeWorkspace } from "@/lib/demo/mode";
import { completionFor, resolveRoute, type RouteConfig } from "@/modules/kernel/routing";
import type { RunHandle } from "@/modules/kernel/contracts";

const config: RouteConfig = {
  stage: "S8", provider_id: "xai-grok", model: "grok-4", params: { temperature: 0, max_tokens: 16000 },
  fallbacks: [], updated_by: "fixture", updated_at: "2026-11-25T00:00:00.000Z",
};

afterEach(() => {
  state.scope = "demo";
  state.enabled = true;
  vi.unstubAllEnvs();
});

describe("KAN-263 explicit customer demo routing", () => {
  it("resolves ordinary callers to live routing even when the scoped workspace enabled the demo", async () => {
    expect(await resolveRoute("S8", config)).toMatchObject({ provider_id: "xai-grok" });
    expect(await resolveRoute("S8", config, demoExecutionFor({ id: "demo", demo_mode: true }))).toMatchObject({
      provider_id: "demo-replay", auth: "none", model: "recorded", fallbacks: [],
      demo: { fixture: "velmara-client-demo", workspace_id: "demo", mode: "replay" },
    });
  });

  it("requires agreement with both current workspace scope and the saved switch", async () => {
    const demo = demoExecutionFor({ id: "demo", demo_mode: true })!;
    state.scope = "customer";
    await expect(resolveRoute("S8", config, demo)).rejects.toMatchObject({ code: "demo_replay_miss" });
    await expect(resolveRoute("S8", config, { ...demo, workspace_id: "customer" })).rejects.toMatchObject({ code: "demo_replay_miss" });
    state.scope = "demo";
    state.enabled = false;
    await expect(resolveRoute("S8", config, demo)).rejects.toMatchObject({ code: "demo_replay_miss" });
  });

  it("observes cross-worker updates without retaining a stale workspace demo flag", async () => {
    state.enabled = false;
    expect(await isDemoModeWorkspace()).toBe(false);
    state.enabled = true;
    expect(await isDemoModeWorkspace()).toBe(true);
    state.enabled = false;
    expect(await isDemoModeWorkspace()).toBe(false);
  });

  it("uses an explicit live recording route only in a non-production recording run", async () => {
    vi.stubEnv("SYNAPSE_DEMO_RECORD", "1");
    const workspace = { id: "demo", demo_mode: true };
    expect(() => demoExecutionFor(workspace)).toThrow(/recording ID/);
    const recording_id = "b1d1d892-4f6f-46de-8ab0-4cab8f9eeef2";
    vi.stubEnv("SYNAPSE_DEMO_RECORDING_ID", recording_id);
    const execution = demoExecutionFor(workspace);
    expect(await resolveRoute("S8", config, execution)).toMatchObject({
      provider_id: "xai-grok", demo: { mode: "record", recording_id },
    });
    vi.stubEnv("SYNAPSE_DEMO_RECORDING_ID", "3d0b1f0f-e816-4f34-8ec4-6f4b73f4a5d1");
    await expect(resolveRoute("S8", config, execution)).rejects.toMatchObject({ code: "demo_replay_miss" });
    vi.stubEnv("NODE_ENV", "production");
    expect(await resolveRoute("S8", config, demoExecutionFor(workspace))).toMatchObject({ provider_id: "demo-replay" });
  });

  it("refuses a substitute completion executor on a demo replay route", async () => {
    const route = await resolveRoute("S8", config, demoExecutionFor({ id: "demo", demo_mode: true }));
    const completeRaw = vi.fn().mockResolvedValue("{}");
    const complete = completionFor(route, { workspace_id: "demo" } as RunHandle, { completeRaw });
    await expect(complete({ system: "fictional system", user: "fictional input", purpose: "priority-suggester" }))
      .rejects.toMatchObject({ code: "demo_replay_miss" });
    expect(completeRaw).not.toHaveBeenCalled();
  });
});
