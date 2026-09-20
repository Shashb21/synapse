import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  CLAUDE_CODE_DEFAULT_CLI_VERSION,
  CLAUDE_CODE_IDENTITY_PROMPT,
  CLAUDE_CODE_OAUTH_BETAS,
  CLAUDE_CODE_OAUTH_CLIENT_ID,
  CLAUDE_CODE_OAUTH_TOKEN_URL,
  FINGERPRINT_SALT,
  type ClaudeCodeOAuthCredential,
} from "./types";

const KEYCHAIN_SERVICE = "Claude Code-credentials";
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export function claudeCodeCliVersion(): string {
  return process.env.CLAUDE_CODE_CLI_VERSION?.trim() || CLAUDE_CODE_DEFAULT_CLI_VERSION;
}

export function isOAuthAccessToken(value: string | undefined): boolean {
  return Boolean(value?.startsWith("sk-ant-oat"));
}

export function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CLAUDE_CODE_CREDENTIALS_PATH?.trim();
  if (override) return override;
  return join(homedir(), ".claude", ".credentials.json");
}

export function computeFingerprint(messageText: string, version: string): string {
  const chars = [4, 7, 20].map((i) => (i < messageText.length ? messageText[i]! : "0")).join("");
  return createHash("sha256")
    .update(FINGERPRINT_SALT + chars + version, "utf8")
    .digest("hex")
    .slice(0, 3);
}

export function attributionBlockText(messageText: string, version = claudeCodeCliVersion()): string {
  const fingerprint = computeFingerprint(messageText, version);
  return `x-anthropic-billing-header: cc_version=${version}.${fingerprint}; cc_entrypoint=cli;`;
}

export function oauthSystemBlocks(args: { system: string; user: string }): { type: "text"; text: string }[] {
  return [
    { type: "text", text: attributionBlockText(args.user) },
    { type: "text", text: CLAUDE_CODE_IDENTITY_PROMPT },
    { type: "text", text: args.system },
  ];
}

export function parseClaudeCodeCredential(
  raw: unknown,
  source: ClaudeCodeOAuthCredential["source"],
  path?: string,
): ClaudeCodeOAuthCredential | null {
  if (!raw || typeof raw !== "object") return null;
  const outer = raw as Record<string, unknown>;
  const inner =
    outer.claudeAiOauth && typeof outer.claudeAiOauth === "object"
      ? (outer.claudeAiOauth as Record<string, unknown>)
      : outer;
  const accessToken =
    (typeof inner.accessToken === "string" && inner.accessToken) ||
    (typeof inner.access_token === "string" && inner.access_token) ||
    undefined;
  if (!accessToken) return null;
  const refreshToken =
    (typeof inner.refreshToken === "string" && inner.refreshToken) ||
    (typeof inner.refresh_token === "string" && inner.refresh_token) ||
    undefined;
  const expiresAt =
    typeof inner.expiresAt === "number"
      ? inner.expiresAt
      : typeof inner.expires_at === "number"
        ? inner.expires_at
        : undefined;
  const subscriptionType =
    typeof inner.subscriptionType === "string"
      ? inner.subscriptionType
      : typeof inner.subscription_type === "string"
        ? inner.subscription_type
        : undefined;
  const scopes = Array.isArray(inner.scopes)
    ? inner.scopes.filter((s): s is string => typeof s === "string")
    : undefined;
  return { accessToken, refreshToken, expiresAt, subscriptionType, scopes, source, path };
}

function readEnvCredential(env: NodeJS.ProcessEnv): ClaudeCodeOAuthCredential | null {
  const accessToken = env.CLAUDE_CODE_OAUTH_TOKEN?.trim() || env.CLAUDE_CODE_ACCESS_TOKEN?.trim();
  if (!accessToken) return null;
  const expiresRaw = env.CLAUDE_CODE_OAUTH_EXPIRES_AT?.trim();
  const expiresAt = expiresRaw ? Number(expiresRaw) : undefined;
  return {
    accessToken,
    refreshToken: env.CLAUDE_CODE_REFRESH_TOKEN?.trim() || undefined,
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : undefined,
    source: "env",
  };
}

function readFileCredential(path: string): ClaudeCodeOAuthCredential | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parseClaudeCodeCredential(parsed, "file", path);
  } catch {
    return null;
  }
}

function readKeychainCredential(): ClaudeCodeOAuthCredential | null {
  if (process.platform !== "darwin") return null;
  try {
    const out = execFileSync(
      "security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 },
    );
    return parseClaudeCodeCredential(JSON.parse(out), "keychain");
  } catch {
    return null;
  }
}

function mergeCredentials(
  primary: ClaudeCodeOAuthCredential | null,
  fallback: ClaudeCodeOAuthCredential | null,
): ClaudeCodeOAuthCredential | null {
  if (!primary) return fallback;
  if (!fallback) return primary;
  return {
    ...fallback,
    ...primary,
    refreshToken: primary.refreshToken || fallback.refreshToken,
    expiresAt: primary.expiresAt ?? fallback.expiresAt,
    source: primary.source === fallback.source ? primary.source : "merged",
    path: primary.path ?? fallback.path,
  };
}

export function loadClaudeCodeCredential(
  env: NodeJS.ProcessEnv = process.env,
): ClaudeCodeOAuthCredential | null {
  const file = readFileCredential(credentialsPath(env));
  const envCred = readEnvCredential(env);
  const keychain = readKeychainCredential();
  return mergeCredentials(envCred, mergeCredentials(file, keychain));
}

export function credentialExpiring(
  credential: ClaudeCodeOAuthCredential,
  now = Date.now(),
  marginMs = REFRESH_MARGIN_MS,
): boolean {
  if (credential.expiresAt == null) return false;
  return now >= credential.expiresAt - marginMs;
}

export function persistClaudeCodeCredential(
  credential: ClaudeCodeOAuthCredential,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const path = credential.path || credentialsPath(env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const payload = {
    claudeAiOauth: {
      accessToken: credential.accessToken,
      refreshToken: credential.refreshToken ?? null,
      expiresAt: credential.expiresAt ?? null,
      scopes: credential.scopes ?? [],
      subscriptionType: credential.subscriptionType ?? null,
    },
  };
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  env.CLAUDE_CODE_OAUTH_TOKEN = credential.accessToken;
  if (credential.refreshToken) env.CLAUDE_CODE_REFRESH_TOKEN = credential.refreshToken;
  if (credential.expiresAt != null) env.CLAUDE_CODE_OAUTH_EXPIRES_AT = String(credential.expiresAt);
  return path;
}

export function oauthRequestHeaders(accessToken: string, requestId: string, sessionId: string): Record<string, string> {
  return {
    accept: "application/json",
    "content-type": "application/json",
    authorization: `Bearer ${accessToken}`,
    "anthropic-version": "2023-06-01",
    "anthropic-beta": CLAUDE_CODE_OAUTH_BETAS.join(","),
    "user-agent": `claude-cli/${claudeCodeCliVersion()} (external, synapse)`,
    "x-app": "cli",
    "x-claude-code-session-id": sessionId,
    "x-client-request-id": requestId,
  };
}

export async function refreshClaudeCodeCredential(
  credential: ClaudeCodeOAuthCredential,
  fetchImpl: typeof fetch = fetch,
): Promise<ClaudeCodeOAuthCredential> {
  if (!credential.refreshToken) {
    throw new Error(
      "Claude Code OAuth access token expired and no refresh token is available. Run `claude /login` or set CLAUDE_CODE_REFRESH_TOKEN.",
    );
  }
  const res = await fetchImpl(CLAUDE_CODE_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": `claude-cli/${claudeCodeCliVersion()} (external, synapse)`,
    },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: credential.refreshToken,
      client_id: process.env.ANTHROPIC_OAUTH_CLIENT_ID?.trim() || CLAUDE_CODE_OAUTH_CLIENT_ID,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !body.access_token) {
    throw new Error(
      body.error_description ||
        body.error ||
        `Claude Code OAuth refresh failed (HTTP ${res.status}). Run \`claude /login\`.`,
    );
  }
  const refreshed: ClaudeCodeOAuthCredential = {
    ...credential,
    accessToken: body.access_token,
    refreshToken: body.refresh_token || credential.refreshToken,
    expiresAt: typeof body.expires_in === "number" ? Date.now() + body.expires_in * 1000 : credential.expiresAt,
    source: credential.source,
  };
  try {
    persistClaudeCodeCredential(refreshed);
  } catch {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = refreshed.accessToken;
    if (refreshed.refreshToken) process.env.CLAUDE_CODE_REFRESH_TOKEN = refreshed.refreshToken;
  }
  return refreshed;
}
