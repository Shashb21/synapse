import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  accuracyAuthAllowsLive,
  inspectLiveExtractGate,
  EXTRACT_CONNECT_PATH,
  EXTRACT_KEY_GATE_CODE,
  EXTRACT_KEY_GATE_MESSAGE,
} from "@/accuracy/kernel/extract-gate";
import { registerAccuracyStack } from "@/accuracy";
import { db, ensurePlatformSchema } from "@/modules/kernel/db";
import * as t from "@/modules/kernel/schema";
import { accuracyDb, ensureAccuracySchema } from "@/accuracy/store/db";
import { accuracyRoutingConfig } from "@/accuracy/store/schema";
import { setAccuracyRouteConfig } from "@/accuracy/kernel/routing";
import { xaiGrok } from "@/modules/llm/provider";

const KEY_ENVS = [
  "SYNAPSE_TEST_STUB_LLM",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_WORKSPACE_ID",
  "XAI_API_KEY",
  "OPENAI_API_KEY",
] as const;

describe("live extract API-key gate", () => {
  const saved: Record<string, string | undefined> = {};
  const savedOauth = new Map<string, typeof t.oauthConnections.$inferSelect | undefined>();
  const gateRoute = and(
    eq(accuracyRoutingConfig.call_kind, "need_extract"),
    eq(accuracyRoutingConfig.agent_role, "proposer"),
  );
  let savedRoute: typeof accuracyRoutingConfig.$inferSelect | undefined;
  let routeSnapshotTaken = false;

  beforeAll(async () => {
    await ensureAccuracySchema();
    [savedRoute] = await accuracyDb().select().from(accuracyRoutingConfig).where(gateRoute);
    routeSnapshotTaken = true;
    await setAccuracyRouteConfig({
      call_kind: "need_extract",
      agent_role: "proposer",
      provider_id: "xai-grok",
      model: xaiGrok.default_model,
      fallbacks: ["anthropic-claude", "openai"],
      actor_name: "KAN-4 gate fixture",
    });
  });

  afterAll(async () => {
    // A failed snapshot must never delete an existing row. Restore raw values:
    // the routing setter normalizes fallbacks and replaces update metadata.
    if (!routeSnapshotTaken) return;
    if (savedRoute) {
      await accuracyDb().insert(accuracyRoutingConfig).values(savedRoute).onConflictDoUpdate({
        target: [accuracyRoutingConfig.call_kind, accuracyRoutingConfig.agent_role],
        set: savedRoute,
      });
    } else {
      await accuracyDb().delete(accuracyRoutingConfig).where(gateRoute);
    }
  });

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

  /** The retired OAuth table (KAN-65): a row left in it must not make a provider live. */
  async function legacyOauthRow(provider_id: string) {
    await ensurePlatformSchema();
    if (!savedOauth.has(provider_id)) {
      const [row] = await db().select().from(t.oauthConnections)
        .where(eq(t.oauthConnections.provider_id, provider_id));
      savedOauth.set(provider_id, row);
    }
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
    // Only restore rows this test touched; never clear unrelated OAuth data.
    for (const [provider_id, row] of savedOauth) {
      if (row) {
        await db().insert(t.oauthConnections).values(row).onConflictDoUpdate({
          target: t.oauthConnections.provider_id,
          set: row,
        });
      } else {
        await db().delete(t.oauthConnections).where(eq(t.oauthConnections.provider_id, provider_id));
      }
      savedOauth.delete(provider_id);
    }
  });

  it("accuracyAuthAllowsLive accepts any provider's API key, Claude included without a workspace id (KAN-65)", () => {
    stash("ANTHROPIC_WORKSPACE_ID");
    delete process.env.ANTHROPIC_WORKSPACE_ID;
    expect(accuracyAuthAllowsLive("xai-grok", "api_key")).toBe(true);
    expect(accuracyAuthAllowsLive("openai", "api_key")).toBe(true);
    expect(accuracyAuthAllowsLive("anthropic-claude", "api_key")).toBe(true);
    expect(accuracyAuthAllowsLive("xai-grok", "none")).toBe(false);
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

  it("blocks live extract without a provider key and points at /admin/control", async () => {
    registerAccuracyStack();
    liveEnv();
    const gate = await inspectLiveExtractGate();
    expect(gate.ready).toBe(false);
    if (gate.ready) return;
    expect(gate.code).toBe(EXTRACT_KEY_GATE_CODE);
    expect(gate.connect_path).toBe("/admin/control");
    expect(gate.message).toBe(EXTRACT_KEY_GATE_MESSAGE);
    expect(gate.reason.length).toBeGreaterThan(0);
  });

  it("ignores a token left in the retired OAuth table", async () => {
    registerAccuracyStack();
    liveEnv();
    await legacyOauthRow("xai-grok");
    await legacyOauthRow("anthropic-claude");
    const gate = await inspectLiveExtractGate();
    expect(gate.ready).toBe(false);
    if (gate.ready) return;
    expect(gate.reason).toContain("XAI_API_KEY");
  });

  it("treats a Claude API key as live-ready without ANTHROPIC_WORKSPACE_ID (KAN-65)", async () => {
    registerAccuracyStack();
    liveEnv({ ANTHROPIC_API_KEY: "sk-ant-test" });
    const gate = await inspectLiveExtractGate();
    expect(gate.ready).toBe(true);
    if (!gate.ready || gate.stub) throw new Error("expected Claude API key route");
    expect(gate.provider_id).toBe("anthropic-claude");
    expect(gate.auth).toBe("api_key");
  });

  it("allows Claude API key when ANTHROPIC_WORKSPACE_ID is set", async () => {
    registerAccuracyStack();
    liveEnv({ ANTHROPIC_API_KEY: "sk-ant-test", ANTHROPIC_WORKSPACE_ID: "ws_ant" });
    const gate = await inspectLiveExtractGate();
    expect(gate.ready).toBe(true);
    if (!gate.ready || gate.stub) throw new Error("expected Claude API key route");
    expect(gate.provider_id).toBe("anthropic-claude");
    expect(gate.auth).toBe("api_key");
  });

  it("allows Grok XAI_API_KEY without ANTHROPIC_WORKSPACE_ID", async () => {
    registerAccuracyStack();
    liveEnv({ XAI_API_KEY: "xai-test" });
    const gate = await inspectLiveExtractGate();
    expect(gate.ready).toBe(true);
    if (!gate.ready || gate.stub) throw new Error("expected Grok API key route");
    expect(gate.provider_id).toBe("xai-grok");
    expect(gate.auth).toBe("api_key");
  });
});
