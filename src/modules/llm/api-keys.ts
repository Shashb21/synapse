/**
 * Optional server-side API keys for Claude / Grok / OpenAI.
 * Prefer OAuth when connected; fall back to these env vars when present.
 * Never expose or invent secrets — operators inject keys into the environment.
 */

const PROVIDER_API_KEY_ENV: Record<string, string> = {
  "xai-grok": "XAI_API_KEY",
  "anthropic-claude": "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
};

export function providerApiKeyEnvName(providerId: string): string | undefined {
  return PROVIDER_API_KEY_ENV[providerId];
}

export function providerApiKey(providerId: string): string | null {
  const envName = PROVIDER_API_KEY_ENV[providerId];
  if (!envName) return null;
  const value = process.env[envName]?.trim();
  return value || null;
}

export function hasProviderApiKey(providerId: string): boolean {
  return Boolean(providerApiKey(providerId));
}

/** Providers that accept an optional env API key as an OAuth alternative. */
export function apiKeyRoutableProviderIds(): string[] {
  return Object.keys(PROVIDER_API_KEY_ENV);
}
