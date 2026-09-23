import { afterEach, describe, expect, it } from "vitest";
import {
  apiKeyRoutableProviderIds,
  hasProviderApiKey,
  providerApiKey,
  providerApiKeyEnvName,
} from "@/modules/llm/api-keys";
import { canPrompt } from "@/modules/kernel/routing";

const KEY_ENVS = ["ANTHROPIC_API_KEY", "XAI_API_KEY", "OPENAI_API_KEY"] as const;

describe("LLM API key routing groundwork", () => {
  const saved: Record<string, string | undefined> = {};

  afterEach(() => {
    for (const name of KEY_ENVS) {
      if (name in saved) {
        if (saved[name] === undefined) delete process.env[name];
        else process.env[name] = saved[name];
        delete saved[name];
      }
    }
  });

  function stash(name: (typeof KEY_ENVS)[number]) {
    if (!(name in saved)) saved[name] = process.env[name];
  }

  it("maps Claude, Grok, and OpenAI to env key names", () => {
    expect(apiKeyRoutableProviderIds().sort()).toEqual([
      "anthropic-claude",
      "openai",
      "xai-grok",
    ]);
    expect(providerApiKeyEnvName("anthropic-claude")).toBe("ANTHROPIC_API_KEY");
    expect(providerApiKeyEnvName("xai-grok")).toBe("XAI_API_KEY");
    expect(providerApiKeyEnvName("openai")).toBe("OPENAI_API_KEY");
    expect(providerApiKeyEnvName("google-gemini")).toBeUndefined();
  });

  it("reads keys only when present (no invented secrets)", () => {
    stash("ANTHROPIC_API_KEY");
    stash("XAI_API_KEY");
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.XAI_API_KEY;
    expect(hasProviderApiKey("anthropic-claude")).toBe(false);
    expect(providerApiKey("xai-grok")).toBeNull();

    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    expect(hasProviderApiKey("anthropic-claude")).toBe(true);
    expect(providerApiKey("anthropic-claude")).toBe("sk-ant-test");
  });

  it("allows prompting on api_key auth routes", () => {
    expect(
      canPrompt({
        stage: "S2",
        provider_id: "anthropic-claude",
        provider_label: "Anthropic · Claude",
        model: "claude-sonnet-4-5",
        auth: "api_key",
        connected: true,
        params: { temperature: 0, max_tokens: 8192 },
        fallbacks: [],
        degraded: false,
        reason: "server API key",
      }),
    ).toBe(true);
  });
});
