import { afterEach, describe, expect, it } from "vitest";
import {
  accuracyAuthAllowsLive,
  inspectLiveExtractGate,
  EXTRACT_CONNECT_PATH,
  EXTRACT_OAUTH_GATE_CODE,
  EXTRACT_OAUTH_GATE_MESSAGE,
} from "@/accuracy/kernel/extract-gate";
import { registerAccuracyStack } from "@/accuracy";
import { db, ensurePlatformSchema } from "@/modules/kernel/db";
import * as t from "@/modules/kernel/schema";

const KEY_ENVS = [
  "SYNAPSE_TEST_STUB_LLM",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_WORKSPACE_ID",
  "XAI_API_KEY",
  "OPENAI_API_KEY",
] as const;

describe("live extract OAuth gate", () => {
  const saved: Record<string, string | undefined> = {};

  function stash(name: (typeof KEY_ENVS)[number]) {
    if (!(name in saved)) saved[name] = process.env[name];
  }

  function liveEnv(overrides: Partial<Record<(typeof KEY_ENVS)[number], string | undefined>> = {}) {
    for (const name of KEY_ENVS) {
      stash(name);
      const next = Object.prototype.hasOwnProperty.call(overrides, name)
        ? overrides[name]
        : name === "SYNAPSE_TEST_STUB_LLM"
          ? "0"
          : undefined;
      if (next === undefined) delete process.env[name];
      else process.env[name] = next;
    }
  }

  async function clearOauth() {
    await ensurePlatformSchema();
    await db().delete(t.oauthConnections);
  }

  async function connectProvider(provider_id: string) {
    await ensurePlatformSchema();
    const values = {
      provider_id,
      status: "connected",
      account_label: `${provider_id}-test`,
      scopes: ["api:access"],
      access_token: "test-oauth-token",
      refresh_token: null,
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      connected_by: "test",
      connected_at: new Date().toISOString(),
      detail: null,
    };
    await db()
      .insert(t.oauthConnections)
      .values(values)
      .onConflictDoUpdate({
        target: t.oauthConnections.provider_id,
        set: values,
      });
  }

  afterEach(async () => {
    for (const name of KEY_ENVS) {
      if (!(name in saved)) continue;
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
      delete saved[name];
    }
    await clearOauth();
  });

  it("accuracyAuthAllowsLive accepts OAuth and Grok keys, not Claude keys without workspace", () => {
    stash("ANTHROPIC_WORKSPACE_ID");
    delete process.env.ANTHROPIC_WORKSPACE_ID;
    expect(accuracyAuthAllowsLive("xai-grok", "oauth")).toBe(true);
    expect(accuracyAuthAllowsLive("anthropic-claude", "oauth")).toBe(true);
    expect(accuracyAuthAllowsLive("xai-grok", "api_key")).toBe(true);
    expect(accuracyAuthAllowsLive("openai", "api_key")).toBe(true);
    expect(accuracyAuthAllowsLive("anthropic-claude", "api_key")).toBe(false);
    expect(accuracyAuthAllowsLive("xai-grok", "none")).toBe(false);
    process.env.ANTHROPIC_WORKSPACE_ID = "ws_test";
    expect(accuracyAuthAllowsLive("anthropic-claude", "api_key")).toBe(true);
  });

  it("is ready under SYNAPSE_TEST_STUB_LLM", async () => {
    expect(process.env.SYNAPSE_TEST_STUB_LLM).toBe("1");
    const gate = await inspectLiveExtractGate();
    expect(gate).toEqual({
      ready: true,
      stub: true,
      connect_path: EXTRACT_CONNECT_PATH,
    });
  });

  it("blocks live extract without a connected provider and points at /control", async () => {
    registerAccuracyStack();
    liveEnv();
    await clearOauth();
    const gate = await inspectLiveExtractGate();
    expect(gate.ready).toBe(false);
    if (gate.ready) return;
    expect(gate.code).toBe(EXTRACT_OAUTH_GATE_CODE);
    expect(gate.connect_path).toBe("/admin/control");
    expect(gate.message).toBe(EXTRACT_OAUTH_GATE_MESSAGE);
    expect(gate.reason.length).toBeGreaterThan(0);
  });

  it("allows live extract when Grok OAuth is connected without ANTHROPIC_WORKSPACE_ID", async () => {
    registerAccuracyStack();
    liveEnv();
    await clearOauth();
    await connectProvider("xai-grok");
    const gate = await inspectLiveExtractGate();
    expect(gate.ready).toBe(true);
    if (!gate.ready || gate.stub) throw new Error("expected live Grok OAuth");
    expect(gate.provider_id).toBe("xai-grok");
    expect(gate.auth).toBe("oauth");
    expect(gate.provider_label).toMatch(/Grok/i);
  });

  it("allows live extract when Claude OAuth is connected without ANTHROPIC_WORKSPACE_ID", async () => {
    registerAccuracyStack();
    liveEnv();
    await clearOauth();
    await connectProvider("anthropic-claude");
    const gate = await inspectLiveExtractGate();
    expect(gate.ready).toBe(true);
    if (!gate.ready || gate.stub) throw new Error("expected live Claude OAuth");
    expect(gate.provider_id).toBe("anthropic-claude");
    expect(gate.auth).toBe("oauth");
  });

  it("does not treat a Claude API key as live-ready without ANTHROPIC_WORKSPACE_ID", async () => {
    registerAccuracyStack();
    liveEnv({ ANTHROPIC_API_KEY: "sk-ant-test" });
    await clearOauth();
    const gate = await inspectLiveExtractGate();
    expect(gate.ready).toBe(false);
    if (gate.ready) return;
    expect(gate.reason).toMatch(/ANTHROPIC_WORKSPACE_ID|\/control/i);
  });

  it("allows Claude API key when ANTHROPIC_WORKSPACE_ID is set", async () => {
    registerAccuracyStack();
    liveEnv({ ANTHROPIC_API_KEY: "sk-ant-test", ANTHROPIC_WORKSPACE_ID: "ws_ant" });
    await clearOauth();
    const gate = await inspectLiveExtractGate();
    expect(gate.ready).toBe(true);
    if (!gate.ready || gate.stub) throw new Error("expected Claude API key route");
    expect(gate.provider_id).toBe("anthropic-claude");
    expect(gate.auth).toBe("api_key");
  });

  it("allows Grok XAI_API_KEY without ANTHROPIC_WORKSPACE_ID", async () => {
    registerAccuracyStack();
    liveEnv({ XAI_API_KEY: "xai-test" });
    await clearOauth();
    const gate = await inspectLiveExtractGate();
    expect(gate.ready).toBe(true);
    if (!gate.ready || gate.stub) throw new Error("expected Grok API key route");
    expect(gate.provider_id).toBe("xai-grok");
    expect(gate.auth).toBe("api_key");
  });
});
