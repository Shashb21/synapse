import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  CLAUDE_CODE_OAUTH_AUTHORIZE_URL,
  CLAUDE_CODE_OAUTH_CLIENT_ID,
  CLAUDE_CODE_OAUTH_REDIRECT_URI,
  CLAUDE_CODE_OAUTH_SCOPES,
  CLAUDE_CODE_OAUTH_TOKEN_URL,
  type ClaudeCodeOAuthCredential,
} from "./types";
import {
  clearClaudeCodeCredential,
  parseClaudeCodeCredential,
  persistClaudeCodeCredential,
} from "./oauth";
import { agenticAuthStatus, agenticGateway } from "./gateway";
import { emitReauth } from "./reauth";

export type PendingPkce = {
  state: string;
  verifier: string;
  created_at: number;
};

export type LoginResult = {
  ok: true;
  path: string;
  auth: ReturnType<typeof agenticAuthStatus>;
};

function pkcePath(): string {
  return (
    process.env.CLAUDE_CODE_PKCE_PATH?.trim() ||
    join(process.cwd(), "data/runtime/oauth-pkce.json")
  );
}

let pending: PendingPkce | null = null;

export function readPendingPkce(): PendingPkce | null {
  if (pending) return pending;
  const path = pkcePath();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as PendingPkce;
    if (parsed?.state && parsed?.verifier) {
      pending = parsed;
      return parsed;
    }
  } catch {
    return null;
  }
  return null;
}

export function writePendingPkce(next: PendingPkce | null) {
  pending = next;
  const path = pkcePath();
  if (!next) {
    try {
      if (existsSync(path)) unlinkSync(path);
    } catch {
      // best-effort
    }
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next)}\n`, { encoding: "utf8", mode: 0o600 });
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function buildAuthorizeUrl(pkce: { state: string; verifier: string }): string {
  const challenge = base64url(createHash("sha256").update(pkce.verifier).digest());
  const params = new URLSearchParams({
    code: "true",
    client_id: process.env.ANTHROPIC_OAUTH_CLIENT_ID?.trim() || CLAUDE_CODE_OAUTH_CLIENT_ID,
    response_type: "code",
    redirect_uri: CLAUDE_CODE_OAUTH_REDIRECT_URI,
    scope: CLAUDE_CODE_OAUTH_SCOPES,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: pkce.state,
  });
  return `${CLAUDE_CODE_OAUTH_AUTHORIZE_URL}?${params.toString()}`;
}

export function startClaudeCodeLogin(): { authorize_url: string; state: string } {
  const pkce: PendingPkce = {
    state: randomBytes(16).toString("hex"),
    verifier: base64url(randomBytes(32)),
    created_at: Date.now(),
  };
  writePendingPkce(pkce);
  return { authorize_url: buildAuthorizeUrl(pkce), state: pkce.state };
}

export function parseAuthorizationPaste(raw: string): { code: string; state?: string } {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("Paste the code#state string from the Claude callback page.");
  try {
    if (/^https?:\/\//i.test(trimmed)) {
      const url = new URL(trimmed);
      const code = url.searchParams.get("code") ?? "";
      const state = url.searchParams.get("state") ?? undefined;
      if (code) return { code, state };
    }
  } catch {
    // not a URL
  }
  if (trimmed.includes("#")) {
    const [code, state] = trimmed.split("#", 2);
    if (code?.trim()) return { code: code.trim(), state: state?.trim() };
  }
  return { code: trimmed };
}

export async function exchangeAuthorizationCode(args: {
  code: string;
  state?: string;
  fetchImpl?: typeof fetch;
}): Promise<ClaudeCodeOAuthCredential> {
  const pkce = readPendingPkce();
  if (!pkce) {
    throw new Error("No pending Claude login. Click Start Claude login first.");
  }
  const state = args.state || pkce.state;
  if (args.state && args.state !== pkce.state) {
    throw new Error("OAuth state did not match the pending login. Start Claude login again.");
  }
  const res = await (args.fetchImpl ?? fetch)(CLAUDE_CODE_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": "claude-cli/2.1.85 (external, synapse)",
      origin: "https://claude.ai",
      referer: "https://claude.ai/",
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code: args.code,
      redirect_uri: CLAUDE_CODE_OAUTH_REDIRECT_URI,
      client_id: process.env.ANTHROPIC_OAUTH_CLIENT_ID?.trim() || CLAUDE_CODE_OAUTH_CLIENT_ID,
      code_verifier: pkce.verifier,
      state,
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
      body.error_description || body.error || `Claude OAuth exchange failed (HTTP ${res.status}).`,
    );
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: typeof body.expires_in === "number" ? Date.now() + body.expires_in * 1000 : undefined,
    source: "dashboard",
  };
}

function applyCredential(credential: ClaudeCodeOAuthCredential): LoginResult {
  const path = persistClaudeCodeCredential({ ...credential, source: "dashboard" });
  agenticGateway.resetSession();
  void emitReauth({ type: "refreshed", expiresAt: credential.expiresAt });
  return { ok: true, path, auth: agenticAuthStatus() };
}

export async function completeClaudeCodeLogin(paste: string, fetchImpl?: typeof fetch): Promise<LoginResult> {
  const parsed = parseAuthorizationPaste(paste);
  const cred = await exchangeAuthorizationCode({ ...parsed, fetchImpl });
  const result = applyCredential(cred);
  writePendingPkce(null);
  return result;
}

export function savePastedClaudeCodeSession(args: {
  access_token?: string;
  refresh_token?: string;
  credentials_json?: string;
}): LoginResult {
  const jsonRaw = args.credentials_json?.trim();
  if (jsonRaw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonRaw);
    } catch {
      throw new Error("Credentials JSON is invalid.");
    }
    const cred = parseClaudeCodeCredential(parsed, "dashboard");
    if (!cred) throw new Error("Credentials JSON is missing claudeAiOauth.accessToken.");
    if (args.refresh_token?.trim()) cred.refreshToken = args.refresh_token.trim();
    return applyCredential(cred);
  }
  const access = args.access_token?.trim();
  if (!access) throw new Error("Paste an access token (sk-ant-oat…) or a credentials JSON blob.");
  return applyCredential({
    accessToken: access,
    refreshToken: args.refresh_token?.trim() || undefined,
    source: "dashboard",
  });
}

export function logoutClaudeCodeSession(): LoginResult {
  clearClaudeCodeCredential();
  agenticGateway.resetSession();
  writePendingPkce(null);
  return { ok: true, path: "", auth: agenticAuthStatus() };
}
