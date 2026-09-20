import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_COSTS,
  DEFAULT_MODELS,
  defaultLlmSettings,
  estimateCostUsd,
  moduleForPurpose,
} from "@/lib/llm/catalog";
import {
  getLlmSettings,
  mergeSettings,
  patchLlmSettings,
  resetLlmSettings,
  setLlmSettings,
} from "@/lib/llm/settings";
import { completeJson, hasAgenticLlm, setLlmRouterDeps } from "@/lib/llm/router";
import { agenticCallLog, clearAgenticCallLog } from "@/lib/llm/agentic";
import { startOpenRouterLogin } from "@/lib/llm/providers/oauth-login";
import { persistProviderCredential, clearProviderCredential } from "@/lib/llm/provider-store";

process.env.AGENTIC_TRACKING = "memory";

function tempSettingsPath() {
  return join(mkdtempSync(join(tmpdir(), "synapse-llm-settings-")), "llm-settings.json");
}

function tempOauthStore() {
  return join(mkdtempSync(join(tmpdir(), "synapse-llm-oauth-")), "llm-oauth.json");
}

afterEach(() => {
  setLlmRouterDeps(null);
  resetLlmSettings();
  clearAgenticCallLog();
  delete process.env.LLM_SETTINGS_PATH;
  delete process.env.LLM_OAUTH_STORE;
  delete process.env.OPENROUTER_OAUTH_TOKEN;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.GROK_OAUTH_TOKEN;
  delete process.env.XAI_OAUTH_TOKEN;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
});

describe("llm catalog + settings", () => {
  it("maps purposes onto modules", () => {
    expect(moduleForPurpose("proposer")).toBe("gaps");
    expect(moduleForPurpose("critic")).toBe("gaps");
    expect(moduleForPurpose("judge")).toBe("gaps");
    expect(moduleForPurpose("improver")).toBe("hillclimb");
    expect(moduleForPurpose("insight_extract")).toBe("insight");
    expect(moduleForPurpose("validate")).toBe("validate");
    expect(moduleForPurpose("generic")).toBe("default");
  });

  it("estimates USD cost from per-million rates", () => {
    expect(estimateCostUsd("claude-sonnet-4-5", 1_000_000, 1_000_000, DEFAULT_COSTS)).toBe(18);
    expect(estimateCostUsd("missing-model", 100, 100, DEFAULT_COSTS)).toBeUndefined();
    expect(estimateCostUsd("grok-4", 500_000, 0, DEFAULT_COSTS)).toBe(1.5);
  });

  it("patches and resets routes, costs, and provider defaults", () => {
    process.env.LLM_SETTINGS_PATH = tempSettingsPath();
    resetLlmSettings();
    const patched = patchLlmSettings({
      routes: {
        ...defaultLlmSettings().routes,
        gaps: { provider: "openrouter", model: "openai/gpt-4o" },
      },
      costs: {
        ...DEFAULT_COSTS,
        "openai/gpt-4o": { input_per_mtok: 1, output_per_mtok: 2, currency: "USD" },
      },
    });
    expect(patched.routes.gaps).toEqual({ provider: "openrouter", model: "openai/gpt-4o" });
    expect(patched.costs["openai/gpt-4o"]?.output_per_mtok).toBe(2);
    expect(patched.routes.hillclimb.provider).toBe("claude_code");

    resetLlmSettings();
    const restored = setLlmSettings(defaultLlmSettings());
    expect(restored.routes.gaps.provider).toBe("claude_code");
    expect(getLlmSettings().routes.gaps.provider).toBe("claude_code");
  });

  it("ignores unknown providers when merging", () => {
    const merged = mergeSettings({
      routes: {
        ...defaultLlmSettings().routes,
        gaps: { provider: "nope" as never, model: "x" },
      },
    });
    expect(merged.routes.gaps.provider).toBe("claude_code");
    expect(merged.routes.gaps.model).toBe("x");
  });
});

describe("generic llm router", () => {
  it("routes the gaps module to OpenRouter and records cost", async () => {
    const calls: string[] = [];
    setLlmRouterDeps({
      providerReady: (provider) => provider === "openrouter",
      settings: () => {
        const next = defaultLlmSettings();
        next.routes.gaps = { provider: "openrouter", model: DEFAULT_MODELS.openrouter };
        return next;
      },
      completeOpenRouter: async (input) => {
        calls.push("openrouter");
        expect(input.model).toBe(DEFAULT_MODELS.openrouter);
        return {
          json: { via: "openrouter" },
          text: '{"via":"openrouter"}',
          http_status: 200,
          input_tokens: 1_000_000,
          output_tokens: 1_000_000,
        };
      },
      completeGrok: async () => {
        throw new Error("must not call grok");
      },
      completeClaude: async () => {
        throw new Error("must not call claude");
      },
    });
    const json = await completeJson({
      system: "You are the proposer.",
      user: "{}",
      purpose: "proposer",
    });
    expect(json).toEqual({ via: "openrouter" });
    expect(calls).toEqual(["openrouter"]);
    expect(agenticCallLog()[0]).toMatchObject({
      ok: true,
      provider: "openrouter",
      module: "gaps",
      purpose: "proposer",
      cost_usd: 18,
    });
  });

  it("fails clearly when the routed provider is not logged in", async () => {
    setLlmRouterDeps({
      providerReady: () => false,
      settings: () => {
        const next = defaultLlmSettings();
        next.routes.gaps = { provider: "openrouter", model: DEFAULT_MODELS.openrouter };
        return next;
      },
      completeOpenRouter: async () => {
        throw new Error("must not call provider");
      },
      completeClaude: async () => {
        throw new Error("must not fall back to claude");
      },
    });
    await expect(
      completeJson({ system: "You are the critic.", user: "{}", purpose: "critic" }),
    ).rejects.toThrow(/OpenRouter is not connected/);
    expect(agenticCallLog()[0]?.ok).toBe(false);
    expect(agenticCallLog()[0]?.provider).toBe("openrouter");
    expect(agenticCallLog()[0]?.module).toBe("gaps");
  });

  it("treats hasAgenticLlm as true when any routed provider is ready", () => {
    process.env.LLM_OAUTH_STORE = tempOauthStore();
    persistProviderCredential("openrouter", { accessToken: "sk-or-test", source: "dashboard" });
    setLlmSettings({
      ...defaultLlmSettings(),
      routes: {
        ...defaultLlmSettings().routes,
        gaps: { provider: "openrouter", model: DEFAULT_MODELS.openrouter },
      },
    });
    expect(hasAgenticLlm("gaps")).toBe(true);
    expect(hasAgenticLlm("hillclimb")).toBe(false);
    expect(hasAgenticLlm()).toBe(true);
    clearProviderCredential("openrouter");
  });

  it("builds an OpenRouter PKCE authorize URL", () => {
    process.env.LLM_PKCE_OPENROUTER_PATH = join(
      mkdtempSync(join(tmpdir(), "synapse-or-pkce-")),
      "oauth-openrouter.json",
    );
    const started = startOpenRouterLogin();
    expect(started.authorize_url).toContain("https://openrouter.ai/auth?");
    expect(started.authorize_url).toContain("code_challenge_method=S256");
    expect(started.authorize_url).toContain("code_challenge=");
  });
});
