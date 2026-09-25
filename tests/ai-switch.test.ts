import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
}));

import "@/modules";
import { registerAccuracyStack, runAccuracyModule } from "@/accuracy";
import { AiDisabledError, aiSwitch, setAiEnabled } from "@/modules/kernel/ai-switch";
import { runStage } from "@/modules/kernel/run";
import { listRuns } from "@/modules/kernel/observability";
import { POST as controlPost } from "@/app/api/control/route";
import { POST as uploadPost } from "@/app/api/accuracy/sources/upload/route";
import { can } from "@/modules/auth/roles";

const ACTOR = { name: "Switch Test", function: "medical_affairs" as const };

async function control(body: Record<string, unknown>) {
  const res = await controlPost(
    new Request("http://localhost/api/control", { method: "POST", body: JSON.stringify(body) }),
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe("the admin AI switch", () => {
  beforeAll(async () => {
    registerAccuracyStack();
    await setAiEnabled({ enabled: true, actor_name: ACTOR.name, rationale: "reset for the test" });
  });
  afterAll(async () => {
    // Leave AI on for every other test file.
    await setAiEnabled({ enabled: true, actor_name: ACTOR.name, rationale: "restore after the test" });
  });

  it("is on until an admin turns it off, and only an admin may", async () => {
    expect((await aiSwitch()).enabled).toBe(true);
    expect(can("operator", "toggle_ai")).toBe(true);
    expect(can("medical_affairs", "toggle_ai")).toBe(true);
    expect(can("contributor", "toggle_ai")).toBe(false);
    expect(can("viewer", "toggle_ai")).toBe(false);
  });

  it("flips with no reason asked, and records who flipped it", async () => {
    const bad = await control({ action: "set_ai_enabled", enabled: "no" });
    expect(bad.status).toBe(400);

    const off = await control({ action: "set_ai_enabled", enabled: false });
    expect(off.status).toBe(200);
    const state = await aiSwitch();
    expect(state).toMatchObject({ enabled: false, rationale: null });
    expect(state.updated_by).toBeTruthy();
  });

  it("with AI off, refuses every AI stage before a run is opened", async () => {
    await setAiEnabled({ enabled: false, actor_name: ACTOR.name, rationale: "AI off for this test" });
    const before = (await listRuns({ limit: 500 })).length;
    for (const stage of ["S0", "S1", "S2", "S3", "S4", "S6", "S8", "S9"] as const) {
      await expect(
        runStage({ stage, input: {}, actor: ACTOR, role: "medical_affairs" }),
      ).rejects.toBeInstanceOf(AiDisabledError);
    }
    expect((await listRuns({ limit: 500 })).length).toBe(before);
  });

  it("with AI off, mechanical stages and the timeline still run", async () => {
    await setAiEnabled({ enabled: false, actor_name: ACTOR.name, rationale: "AI off for this test" });
    const s7 = await runStage({ stage: "S7", input: {}, actor: ACTOR, role: "medical_affairs" });
    expect(s7.run_id).toBeTruthy();
    const s10 = await runStage<{ pending: unknown[] }>({
      stage: "S10",
      input: {},
      actor: ACTOR,
      role: "medical_affairs",
    });
    expect(s10.run_id).toBeTruthy();
    expect(Array.isArray(s10.output.pending)).toBe(true);
  });

  it("with AI off, the accuracy app refuses agentic modules and uploads", async () => {
    await setAiEnabled({ enabled: false, actor_name: ACTOR.name, rationale: "AI off for this test" });
    await expect(
      runAccuracyModule({
        call_kind: "parse",
        input: {},
        actor: ACTOR,
        org_id: "org",
        workspace_id: "ws",
      }),
    ).rejects.toBeInstanceOf(AiDisabledError);

    const form = new FormData();
    form.set("workspace_id", "ws-any");
    form.set("file", new File([Buffer.from("text")], "memo.txt", { type: "text/plain" }));
    const res = await uploadPost(
      new Request("http://localhost/api/accuracy/sources/upload", { method: "POST", body: form }),
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code?: string }).code).toBe("ai_off");
  });

  it("turning AI back on lets AI stages run again", async () => {
    await setAiEnabled({ enabled: true, actor_name: ACTOR.name, rationale: "AI back on" });
    const s0 = await runStage({ stage: "S0", input: {}, actor: ACTOR, role: "medical_affairs" });
    expect(s0.run_id).toBeTruthy();
  });
});
