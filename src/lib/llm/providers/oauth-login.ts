import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { LlmProviderId } from "@/lib/llm/catalog";
import { clearProviderCredential, persistProviderCredential } from "@/lib/llm/provider-store";

type Pending = {
  provider: LlmProviderId;
  verifier?: string;
  state?: string;
  device_code?: string;
  interval?: number;
  created_at: number;
};

function pendingPath(provider: LlmProviderId): string {
  return (
    process.env[`LLM_PKCE_${provider.toUpperCase()}_PATH`]?.trim() ||
    join(process.cwd(), `data/runtime/oauth-${provider}.json`)
  );
}

function readPending(provider: LlmProviderId): Pending | null {
  try {
    const path = pendingPath(provider);
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as Pending;
  } catch {
    return null;
  }
}

function writePending(pending: Pending | null, provider: LlmProviderId) {
  const path = pendingPath(provider);
  if (!pending) {
    try {
      if (existsSync(path)) unlinkSync(path);
    } catch {
      /* ignore */
    }
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(pending)}\n`, { encoding: "utf8", mode: 0o600 });
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function startOpenRouterLogin(): { authorize_url: string } {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  writePending({ provider: "openrouter", verifier, created_at: Date.now() }, "openrouter");
  const params = new URLSearchParams({
    code_challenge: challenge,
    code_challenge_method: "S256",
    key_label: "Synapse IEGP",
  });
  return { authorize_url: `https://openrouter.ai/auth?${params.toString()}` };
}

export async function completeOpenRouterLogin(code: string, fetchImpl: typeof fetch = fetch) {
  const pending = readPending("openrouter");
  if (!pending?.verifier) throw new Error("No pending OpenRouter login. Click Start OpenRouter login first.");
  const res = await fetchImpl("https://openrouter.ai/api/v1/auth/keys", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      code: code.trim(),
      code_verifier: pending.verifier,
      code_challenge_method: "S256",
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { key?: string; error?: { message?: string } };
  if (!res.ok || !body.key) {
    throw new Error(body.error?.message || `OpenRouter OAuth exchange failed (HTTP ${res.status}).`);
  }
  persistProviderCredential("openrouter", { accessToken: body.key, source: "dashboard" });
  writePending(null, "openrouter");
}

const GROK_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const GROK_SCOPE =
  "openid profile email offline_access grok-cli:access api:access conversations:read conversations:write";

export async function startGrokLogin(fetchImpl: typeof fetch = fetch) {
  const res = await fetchImpl("https://auth.x.ai/oauth2/device/code", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ client_id: GROK_CLIENT_ID, scope: GROK_SCOPE }).toString(),
  });
  const body = (await res.json().catch(() => ({}))) as {
    device_code?: string;
    user_code?: string;
    verification_uri?: string;
    verification_uri_complete?: string;
    interval?: number;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !body.device_code || !body.user_code) {
    throw new Error(body.error_description || body.error || `Grok device login failed (HTTP ${res.status}).`);
  }
  writePending(
    {
      provider: "grok",
      device_code: body.device_code,
      interval: body.interval ?? 5,
      created_at: Date.now(),
    },
    "grok",
  );
  return {
    user_code: body.user_code,
    verification_uri: body.verification_uri || "https://auth.x.ai/device",
    verification_uri_complete: body.verification_uri_complete,
    interval: body.interval ?? 5,
    expires_in: body.expires_in,
  };
}

export async function pollGrokLogin(fetchImpl: typeof fetch = fetch) {
  const pending = readPending("grok");
  if (!pending?.device_code) throw new Error("No pending Grok login. Click Start Grok login first.");
  const res = await fetchImpl("https://auth.x.ai/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: pending.device_code,
      client_id: GROK_CLIENT_ID,
    }).toString(),
  });
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (body.error === "authorization_pending" || res.status === 428) {
    return { pending: true as const };
  }
  if (!res.ok || !body.access_token) {
    throw new Error(body.error_description || body.error || `Grok token poll failed (HTTP ${res.status}).`);
  }
  persistProviderCredential("grok", {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: typeof body.expires_in === "number" ? Date.now() + body.expires_in * 1000 : undefined,
    source: "dashboard",
  });
  writePending(null, "grok");
  return { pending: false as const };
}

export function saveProviderPaste(
  provider: Exclude<LlmProviderId, "claude_code">,
  args: { access_token?: string; refresh_token?: string },
) {
  const access = args.access_token?.trim();
  if (!access) throw new Error("Paste an OAuth access token.");
  persistProviderCredential(provider, {
    accessToken: access,
    refreshToken: args.refresh_token?.trim() || undefined,
    source: "dashboard",
  });
}

export function logoutProvider(provider: Exclude<LlmProviderId, "claude_code">) {
  clearProviderCredential(provider);
  writePending(null, provider);
}
