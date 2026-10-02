import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * KAN-65: LLM provider OAuth is gone. Every provider authenticates with a
 * server-side API key from the environment. The admin console reports only
 * whether a key is set and which env var it comes from, never its value; each
 * provider sends its key the documented way; a provider with no key fails with
 * an error naming the env var; and a stored route whose model the provider no
 * longer lists keeps working on the provider's default.
 */

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
  headers: async () => new Headers(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined, push: () => undefined, replace: () => undefined }),
  usePathname: () => "/admin/control",
  useSearchParams: () => new URLSearchParams(),
  redirect: () => undefined,
}));

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";
import "@/modules";
import { GET as controlGet, POST as controlPost } from "@/app/api/control/route";
import { ControlPanelView } from "@/components/platform/control-panel-view";
import { ProviderPanel } from "@/components/platform/provider-panel";
import { AiStatusProvider } from "@/components/platform/ai-status";
import { listProviderKeys, providerApiKeyEnvName } from "@/modules/llm/api-keys";
import { NoRouteError, PROVIDERS, findProvider, servedModel, type LlmProvider } from "@/modules/llm/provider";
import { completionFor, resolveRoute, routeConfig, setRouteConfig } from "@/modules/kernel/routing";
import { RunRecorder } from "@/modules/kernel/observability";
import { CAPABILITIES } from "@/modules/auth/roles";
import { ensurePlatformSchema, sharedDb } from "@/modules/kernel/db";
import * as t from "@/modules/kernel/schema";

const SECRET = "sk-test-SECRETVALUE";
const KEY_ENVS = ["ANTHROPIC_API_KEY", "XAI_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY"];
const ACTOR = "KAN-65 Test";

const savedEnv: Record<string, string | undefined> = {};
let savedS2: typeof t.routingConfig.$inferSelect | undefined;

beforeAll(async () => {
  for (const name of KEY_ENVS) savedEnv[name] = process.env[name];
  await ensurePlatformSchema();
  [savedS2] = await sharedDb().select().from(t.routingConfig).where(eq(t.routingConfig.stage, "S2"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const name of KEY_ENVS) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
});

afterAll(async () => {
  await sharedDb().delete(t.routingConfig).where(eq(t.routingConfig.stage, "S2"));
  if (savedS2) await sharedDb().insert(t.routingConfig).values(savedS2);
});

function clearKeys() {
  for (const name of KEY_ENVS) delete process.env[name];
}

function control(body: Record<string, unknown>) {
  return controlPost(
    new Request("http://localhost/api/control", {
      method: "POST",
      body: JSON.stringify({ actor_name: ACTOR, actor_function: "medical_affairs", ...body }),
    }),
  );
}

describe("key status: presence only, never the value", () => {
  it("GET /api/control says which keys are set and where from, and never returns a value", async () => {
    clearKeys();
    process.env.ANTHROPIC_API_KEY = SECRET;
    const res = await controlGet();
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("SECRETVALUE");
    const body = JSON.parse(text) as {
      provider_keys: { provider_id: string; status: string; key_env: string | null }[];
      connections?: unknown;
    };
    expect(body.connections).toBeUndefined();
    const claude = body.provider_keys.find((row) => row.provider_id === "anthropic-claude")!;
    expect(claude).toMatchObject({ status: "configured", key_env: "ANTHROPIC_API_KEY" });
    const grok = body.provider_keys.find((row) => row.provider_id === "xai-grok")!;
    expect(grok).toMatchObject({ status: "missing", key_env: "XAI_API_KEY" });
    expect(body.provider_keys).toHaveLength(PROVIDERS.length);
  });

  it("the rendered control panel shows Key set / No key and the env var, never the value", async () => {
    clearKeys();
    process.env.ANTHROPIC_API_KEY = SECRET;
    const html = renderToStaticMarkup(await ControlPanelView({ params: {} }));
    expect(html).not.toContain(SECRET);
    expect(html).not.toContain("SECRETVALUE");
    expect(html).toContain("Key set");
    expect(html).toContain("No key");
    expect(html).toContain("<code class=\"font-mono\">ANTHROPIC_API_KEY</code> (server environment)");
    expect(html).toContain("Each provider uses an API key set in the server environment");
    expect(html).toContain("Keys are never shown or entered here.");
    // The OAuth controls are gone.
    expect(html).not.toMatch(/Log in with|Re-authorize|Disconnect|OAuth client|Signed in by/);
    expect(html).not.toContain("Synapse never asks you for an API key");
    // Nothing on the panel accepts a key.
    expect(html).not.toMatch(/<input[^>]*(api.?key|secret|sk-)/i);
  });

  it("the provider cards report each status from the environment", () => {
    clearKeys();
    process.env.XAI_API_KEY = SECRET;
    const keys = listProviderKeys();
    const html = renderToStaticMarkup(
      createElement(
        AiStatusProvider,
        { enabled: true },
        createElement(ProviderPanel, {
          connections: keys.map((key) => ({ ...key, tier: key.tier ?? null })),
          defaults: { primary: "xai-grok", alternate: "anthropic-claude" },
          canRoute: true,
          routedTo: "xai-grok",
        }),
      ),
    );
    expect(html).not.toContain(SECRET);
    expect(html.match(/>Key set</g)).toHaveLength(1);
    expect(html.match(/>No key</g)).toHaveLength(PROVIDERS.length - 1);
    for (const provider of PROVIDERS) {
      expect(html).toContain(`>${providerApiKeyEnvName(provider.id)}</code>`);
    }
    // KAN-60 switch is untouched.
    expect(html).toContain("Route every stage to");
    expect(html).toContain("Every stage routes to xAI · Grok.");
  });
});

describe("each provider sends its key the documented way", () => {
  const REQUEST = { system: "s", user: "u", model: "m", temperature: 0, max_tokens: 16 };

  function capture(payload: unknown) {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url: String(url), headers: init.headers as Record<string, string> });
        return new Response(JSON.stringify(payload), { status: 200 });
      }),
    );
    return calls;
  }

  const CHAT = { choices: [{ message: { content: "ok" } }] };

  it.each([
    ["xai-grok", CHAT, "api.x.ai"],
    ["openai", CHAT, "api.openai.com"],
    ["openrouter", CHAT, "openrouter.ai"],
  ])("%s sends Authorization: Bearer", async (id, payload, host) => {
    const calls = capture(payload);
    await expect(findProvider(id)!.complete(REQUEST, { api_key: SECRET })).resolves.toBe("ok");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain(host);
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(calls[0]!.headers["x-api-key"]).toBeUndefined();
  });

  it("anthropic-claude sends x-api-key and anthropic-version, no bearer", async () => {
    const calls = capture({ content: [{ type: "text", text: "ok" }] });
    await expect(findProvider("anthropic-claude")!.complete(REQUEST, { api_key: SECRET })).resolves.toBe("ok");
    expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(calls[0]!.headers["x-api-key"]).toBe(SECRET);
    expect(calls[0]!.headers["anthropic-version"]).toBe("2023-06-01");
    expect(calls[0]!.headers.authorization).toBeUndefined();
  });

  it("google-gemini sends x-goog-api-key, never the key in the URL", async () => {
    const calls = capture({ candidates: [{ content: { parts: [{ text: "ok" }] } }] });
    await expect(findProvider("google-gemini")!.complete(REQUEST, { api_key: SECRET })).resolves.toBe("ok");
    expect(calls[0]!.url).toContain("generativelanguage.googleapis.com");
    expect(calls[0]!.url).not.toContain(SECRET);
    expect(calls[0]!.headers["x-goog-api-key"]).toBe(SECRET);
    expect(calls[0]!.headers.authorization).toBeUndefined();
  });

  it("every provider authenticates by API key and has no OAuth block", () => {
    for (const provider of PROVIDERS) {
      expect(provider.auth).toBe("api_key");
      expect("oauth" in provider).toBe(false);
    }
  });
});

describe("a provider with no key is not configured", () => {
  it("routing to it fails with a NoRouteError naming the env var", async () => {
    clearKeys();
    await setRouteConfig({ stage: "S2", provider_id: "openrouter", model: "", fallbacks: [], actor_name: ACTOR });
    const failure = resolveRoute("S2");
    await expect(failure).rejects.toBeInstanceOf(NoRouteError);
    await expect(resolveRoute("S2")).rejects.toThrow(/OPENROUTER_API_KEY/);
    await expect(resolveRoute("S2")).rejects.toThrow(/server environment/);
  });

  it("a fallback with a key serves instead, and the route names the missing one", async () => {
    clearKeys();
    process.env.OPENAI_API_KEY = SECRET;
    await setRouteConfig({ stage: "S2", provider_id: "openrouter", model: "", fallbacks: ["openai"], actor_name: ACTOR });
    const route = await resolveRoute("S2");
    expect(route).toMatchObject({ provider_id: "openai", auth: "api_key", connected: true, degraded: true });
    expect(route.reason).toContain("OPENROUTER_API_KEY");
    expect(JSON.stringify(route)).not.toContain(SECRET);
  });

  it("a completion whose key disappeared refuses before calling out, naming the env var", async () => {
    clearKeys();
    process.env.XAI_API_KEY = SECRET;
    await setRouteConfig({ stage: "S2", provider_id: "xai-grok", model: "grok-4", fallbacks: [], actor_name: ACTOR });
    const route = await resolveRoute("S2");
    delete process.env.XAI_API_KEY;
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const run = new RunRecorder({
      workspace_id: "test",
      stage: "S2",
      module_id: "kan65.test",
      module_version: "1.0.0",
      actor: { name: ACTOR, function: "medical_affairs" },
      input: {},
    });
    await expect(completionFor(route, run)({ system: "s", user: "u", purpose: "test" })).rejects.toThrow(/XAI_API_KEY/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("a stored route whose model the provider no longer lists", () => {
  it("reads as the provider's default and resolves to it", async () => {
    clearKeys();
    process.env.ANTHROPIC_API_KEY = SECRET;
    const claude = findProvider("anthropic-claude")!;
    expect(claude.models).not.toContain("claude-sonnet-4-5");
    // What existing databases hold: every stage on claude-sonnet-4-5.
    await sharedDb()
      .insert(t.routingConfig)
      .values({
        stage: "S2",
        provider_id: "anthropic-claude",
        model: "claude-sonnet-4-5",
        params: { temperature: 0, max_tokens: 8192 },
        fallbacks: [],
        updated_by: "pre-KAN-65",
        updated_at: "2026-01-01T00:00:00.000Z",
      })
      .onConflictDoUpdate({
        target: t.routingConfig.stage,
        set: { provider_id: "anthropic-claude", model: "claude-sonnet-4-5", fallbacks: [] },
      });
    expect((await routeConfig("S2")).model).toBe(claude.default_model);
    const route = await resolveRoute("S2");
    expect(route.model).toBe(claude.default_model);
    expect(route.provider_id).toBe("anthropic-claude");
  });

  it("set_route refuses the retired model and accepts a listed one (KAN-63 stays consistent)", async () => {
    const refused = await control({ action: "set_route", stage: "S2", provider_id: "anthropic-claude", model: "claude-sonnet-4-5" });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toBe("Anthropic · Claude does not serve claude-sonnet-4-5");
    const accepted = await control({ action: "set_route", stage: "S2", provider_id: "anthropic-claude", model: "claude-opus-5-5" });
    expect(accepted.status).toBe(200);
    expect((await routeConfig("S2")).model).toBe("claude-opus-5-5");
  });

  it("servedModel keeps a listed model and swaps an unlisted one for the default", () => {
    const claude = findProvider("anthropic-claude")!;
    expect(claude.default_model).toBe("claude-sonnet-5-5");
    expect(claude.models).toEqual(["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-4-5-20251001"]);
    expect(servedModel(claude, "claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5-20251001");
    expect(servedModel(claude, "claude-sonnet-4-5")).toBe("claude-sonnet-5-5");
    expect(servedModel(claude, "")).toBe("claude-sonnet-5-5");
    const anyModel: LlmProvider = { ...claude, models: [] };
    expect(servedModel(anyModel, "anything")).toBe("anything");
  });
});

describe("provider OAuth is gone", () => {
  it("connect_provider and disconnect_provider are unknown actions", async () => {
    for (const action of ["connect_provider", "disconnect_provider"]) {
      const res = await control({ action, provider_id: "xai-grok" });
      expect(res.status, action).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe(`Unknown action ${action}`);
    }
  });

  it("has no connect_provider capability, OAuth module or LLM callback route", () => {
    expect(CAPABILITIES as readonly string[]).not.toContain("connect_provider");
    for (const file of [
      "src/modules/llm/oauth.ts",
      "src/modules/llm/oauth-clients.ts",
      "src/app/api/oauth/llm/callback/route.ts",
    ]) {
      expect(existsSync(join(process.cwd(), file)), file).toBe(false);
    }
  });
});

describe("KAN-65 Claude 5 request shape", () => {
  it("sends temperature only to Claude models that still accept it", async () => {
    const { anthropicAcceptsTemperature } = await import("@/modules/llm/provider");
    for (const model of ["claude-sonnet-5-5", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5", "claude-fable-5-1", "claude-opus-4-8", "claude-opus-4-7"]) {
      expect(anthropicAcceptsTemperature(model)).toBe(false);
    }
    for (const model of ["claude-haiku-4-5-20251001", "claude-haiku-4-5", "claude-sonnet-4-6", "claude-opus-4-6", "claude-sonnet-4-5"]) {
      expect(anthropicAcceptsTemperature(model)).toBe(true);
    }
  });

  it("reads only text blocks, and turns a refusal or an empty max_tokens cut-off into an error", async () => {
    const { anthropicText } = await import("@/modules/llm/provider");
    expect(
      anthropicText({ stop_reason: "end_turn", content: [{ type: "thinking", thinking: "" }, { type: "text", text: "{\"ok\":true}" }] }),
    ).toBe("{\"ok\":true}");
    expect(() => anthropicText({ stop_reason: "refusal", stop_details: { category: "cyber" }, content: [] })).toThrow(/declined.*cyber/);
    expect(() => anthropicText({ stop_reason: "max_tokens", content: [{ type: "thinking", thinking: "" }] })).toThrow(/max_tokens/);
    expect(anthropicText({ stop_reason: "max_tokens", content: [{ type: "text", text: "partial" }] })).toBe("partial");
  });
});

describe("KAN-66 a reply that is not valid JSON is asked for again", () => {
  const claudeReply = (text: string) =>
    new Response(JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const recorder = () =>
    new RunRecorder({
      workspace_id: "test",
      stage: "S4",
      module_id: "kan66.test",
      module_version: "1.0.0",
      actor: { name: ACTOR, function: "medical_affairs" },
      input: {},
    });

  it("retries with the parse error in the system prompt and returns the valid reply", async () => {
    clearKeys();
    process.env.ANTHROPIC_API_KEY = SECRET;
    await setRouteConfig({ stage: "S4", provider_id: "anthropic-claude", model: "claude-sonnet-5-5", fallbacks: [], actor_name: ACTOR });
    const route = await resolveRoute("S4");
    const bodies: { system: string }[] = [];
    const replies = ['{"rows":[{"gap_id":"GAP-1"} {"gap_id":"GAP-2"}]}', '{"rows":[{"gap_id":"GAP-1"},{"gap_id":"GAP-2"}]}'];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        bodies.push(JSON.parse(init.body) as { system: string });
        return claudeReply(replies[bodies.length - 1]!);
      }),
    );
    const out = await completionFor(route, recorder())({ system: "Map gaps.", user: "{}", purpose: "mapping-table-proposer" });
    expect(out).toEqual({ rows: [{ gap_id: "GAP-1" }, { gap_id: "GAP-2" }] });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]!.system).toBe("Map gaps.");
    expect(bodies[1]!.system).toMatch(/^Map gaps\.\n\nYour previous reply was not valid JSON \(/);
  });

  it("gives up with a clear error after the last attempt", async () => {
    clearKeys();
    process.env.ANTHROPIC_API_KEY = SECRET;
    await setRouteConfig({ stage: "S4", provider_id: "anthropic-claude", model: "claude-sonnet-5-5", fallbacks: [], actor_name: ACTOR });
    const route = await resolveRoute("S4");
    const fetchSpy = vi.fn(async () => claudeReply("not json at all"));
    vi.stubGlobal("fetch", fetchSpy);
    await expect(
      completionFor(route, recorder())({ system: "s", user: "{}", purpose: "mapping-table-proposer" }),
    ).rejects.toThrow(/did not return valid JSON for mapping-table-proposer after 3 attempts/);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });
});
