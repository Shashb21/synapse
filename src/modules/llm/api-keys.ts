import { PROVIDERS, type LlmProvider } from "./provider";

/**
 * The single source of LLM credentials: one server-side API key per provider,
 * read from the environment (KAN-65). There is no provider login. Operators set
 * keys in .env.local or the host's settings; Synapse never asks for, stores,
 * logs, returns or renders a key's value. A status says only whether a key is
 * set and which env var it comes from.
 */

const PROVIDER_API_KEY_ENV: Record<string, string> = {
  "anthropic-claude": "ANTHROPIC_API_KEY",
  "xai-grok": "XAI_API_KEY",
  openai: "OPENAI_API_KEY",
  "google-gemini": "GEMINI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

export function providerApiKeyEnvName(providerId: string): string | undefined {
  return PROVIDER_API_KEY_ENV[providerId];
}

/** The key itself. Server-only: hand it to `complete()` and nowhere else. */
export function providerApiKey(providerId: string): string | null {
  const envName = PROVIDER_API_KEY_ENV[providerId];
  if (!envName) return null;
  const value = process.env[envName]?.trim();
  return value || null;
}

export function hasProviderApiKey(providerId: string): boolean {
  return Boolean(providerApiKey(providerId));
}

/** Every provider that reads a key from the environment. */
export function apiKeyRoutableProviderIds(): string[] {
  return Object.keys(PROVIDER_API_KEY_ENV);
}

/** True when this provider can be routed to: it needs no key, or its key is set. */
export function providerConfigured(provider: LlmProvider): boolean {
  if (provider.auth === "none") return true;
  return hasProviderApiKey(provider.id);
}

/** Why a provider cannot be routed to, naming the env var to set. */
export function missingKeyReason(provider: Pick<LlmProvider, "id" | "label">): string {
  const envName = providerApiKeyEnvName(provider.id);
  return envName
    ? `${provider.label}: no API key (set ${envName} in the server environment)`
    : `${provider.label}: no API key env var is defined for this provider`;
}

export type ProviderKeyStatus = "configured" | "missing";

/** What the admin console may show about a provider's credential. Never the value. */
export type ProviderKeyView = {
  provider_id: string;
  label: string;
  summary: string;
  tier: LlmProvider["tier"];
  auth: LlmProvider["auth"];
  status: ProviderKeyStatus;
  /** The env var the key is read from; null for a provider that needs none. */
  key_env: string | null;
  models: string[];
  default_model: string;
};

/** Key presence for every provider, read fresh from the environment. */
export function listProviderKeys(): ProviderKeyView[] {
  return PROVIDERS.map((provider) => ({
    provider_id: provider.id,
    label: provider.label,
    summary: provider.summary,
    tier: provider.tier,
    auth: provider.auth,
    status: providerConfigured(provider) ? "configured" : "missing",
    key_env: provider.auth === "none" ? null : (providerApiKeyEnvName(provider.id) ?? null),
    models: provider.models,
    default_model: provider.default_model,
  }));
}
