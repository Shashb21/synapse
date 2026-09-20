import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { LlmProviderId } from "@/lib/llm/catalog";

export type ProviderCredential = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  source: "env" | "file" | "dashboard";
};

type Store = Partial<Record<LlmProviderId, ProviderCredential>>;

function storePath(): string {
  return (
    process.env.LLM_OAUTH_STORE?.trim() || join(homedir(), ".synapse", "llm-oauth.json")
  );
}

function readStore(): Store {
  try {
    const path = storePath();
    if (!existsSync(path)) return {};
    return JSON.parse(readFileSync(path, "utf8")) as Store;
  } catch {
    return {};
  }
}

function writeStore(store: Store) {
  const path = storePath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

const ENV_ACCESS: Record<LlmProviderId, string[]> = {
  claude_code: ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_ACCESS_TOKEN"],
  grok: ["GROK_OAUTH_TOKEN", "XAI_OAUTH_TOKEN"],
  openrouter: ["OPENROUTER_OAUTH_TOKEN", "OPENROUTER_API_KEY"],
};

const ENV_REFRESH: Record<LlmProviderId, string[]> = {
  claude_code: ["CLAUDE_CODE_REFRESH_TOKEN"],
  grok: ["GROK_REFRESH_TOKEN", "XAI_REFRESH_TOKEN"],
  openrouter: [],
};

export function loadProviderCredential(provider: LlmProviderId): ProviderCredential | null {
  if (provider === "claude_code") {
    return null;
  }
  for (const name of ENV_ACCESS[provider]) {
    const accessToken = process.env[name]?.trim();
    if (accessToken) {
      const refreshToken = ENV_REFRESH[provider].map((n) => process.env[n]?.trim()).find(Boolean);
      return { accessToken, refreshToken, source: "env" };
    }
  }
  return readStore()[provider] ?? null;
}

export function persistProviderCredential(provider: LlmProviderId, cred: ProviderCredential) {
  const store = readStore();
  store[provider] = { ...cred, source: "dashboard" };
  writeStore(store);
  const accessName = ENV_ACCESS[provider][0];
  if (accessName) process.env[accessName] = cred.accessToken;
  const refreshName = ENV_REFRESH[provider][0];
  if (refreshName && cred.refreshToken) process.env[refreshName] = cred.refreshToken;
}

export function clearProviderCredential(provider: LlmProviderId) {
  const store = readStore();
  delete store[provider];
  writeStore(store);
  for (const name of ENV_ACCESS[provider]) delete process.env[name];
  for (const name of ENV_REFRESH[provider]) delete process.env[name];
}

export function tokenHint(token: string): string {
  return `${token.slice(0, Math.min(12, token.length))}… (${token.length} chars)`;
}
