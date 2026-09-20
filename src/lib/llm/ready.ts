import { loadClaudeCodeCredential } from "@/lib/llm/agentic/oauth";
import {
  LLM_MODULES,
  LLM_PROVIDERS,
  type LlmModuleId,
  type LlmProviderId,
  providerLoginHint,
} from "@/lib/llm/catalog";
import { loadProviderCredential, tokenHint } from "@/lib/llm/provider-store";
import { getLlmSettings } from "@/lib/llm/settings";

export function providerReady(provider: LlmProviderId): boolean {
  if (provider === "claude_code") return Boolean(loadClaudeCodeCredential());
  return Boolean(loadProviderCredential(provider));
}

/** True if the module's routed provider is ready, or (no module) any routed provider is ready. */
export function hasAgenticLlm(moduleId?: LlmModuleId): boolean {
  const settings = getLlmSettings();
  if (moduleId) return providerReady(settings.routes[moduleId].provider);
  const routed = new Set(LLM_MODULES.map((id) => settings.routes[id].provider));
  if ([...routed].some((id) => providerReady(id))) return true;
  return LLM_PROVIDERS.some((id) => providerReady(id));
}

export type ProviderAuthSnapshot = {
  provider: LlmProviderId;
  ready: boolean;
  auth_mode: "oauth" | "none";
  oauth: boolean;
  source: string | null;
  token_hint: string | null;
  expires_at: number | null;
  has_refresh_token: boolean;
  hint: string | null;
};

export function providerAuthSnapshot(provider: LlmProviderId): ProviderAuthSnapshot {
  if (provider === "claude_code") {
    const cred = loadClaudeCodeCredential();
    return {
      provider,
      ready: Boolean(cred),
      auth_mode: cred ? "oauth" : "none",
      oauth: Boolean(cred),
      source: cred?.source ?? null,
      token_hint: cred ? tokenHint(cred.accessToken) : null,
      expires_at: cred?.expiresAt ?? null,
      has_refresh_token: Boolean(cred?.refreshToken),
      hint: cred ? null : providerLoginHint("claude_code"),
    };
  }
  const cred = loadProviderCredential(provider);
  return {
    provider,
    ready: Boolean(cred),
    auth_mode: cred ? "oauth" : "none",
    oauth: Boolean(cred),
    source: cred?.source ?? null,
    token_hint: cred ? tokenHint(cred.accessToken) : null,
    expires_at: cred?.expiresAt ?? null,
    has_refresh_token: Boolean(cred?.refreshToken),
    hint: cred ? null : providerLoginHint(provider),
  };
}

export function allProviderSnapshots(): Record<LlmProviderId, ProviderAuthSnapshot> {
  return {
    claude_code: providerAuthSnapshot("claude_code"),
    grok: providerAuthSnapshot("grok"),
    openrouter: providerAuthSnapshot("openrouter"),
  };
}
