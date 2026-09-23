import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, ensurePlatformSchema } from "@/modules/kernel/db";
import * as t from "@/modules/kernel/schema";
import { nowIso } from "@/modules/kernel/ids";
import {
  publicOAuthClient,
  resolveOAuthClientId,
  resolveOAuthClientSecret,
} from "./oauth-clients";
import { PROVIDERS, findProvider, providerConfigured, type LlmProvider } from "./provider";
import { hasProviderApiKey, providerApiKey, providerApiKeyEnvName } from "./api-keys";

export type ConnectionStatus = "disconnected" | "pending" | "connected" | "error";

export type ProviderConnection = {
  provider_id: string;
  label: string;
  summary: string;
  tier: LlmProvider["tier"];
  auth: LlmProvider["auth"];
  configured: boolean;
  status: ConnectionStatus;
  account_label: string | null;
  scopes: string[];
  expires_at: string | null;
  connected_by: string | null;
  connected_at: string | null;
  detail: string | null;
  models: string[];
  default_model: string;
};

type PendingDetail = { state: string; code_verifier: string; redirect_uri: string };

function base64Url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function createPkcePair() {
  const verifier = base64Url(randomBytes(48));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

async function row(provider_id: string) {
  await ensurePlatformSchema();
  const rows = await db()
    .select()
    .from(t.oauthConnections)
    .where(eq(t.oauthConnections.provider_id, provider_id))
    .limit(1);
  return rows[0] ?? null;
}

export async function listConnections(): Promise<ProviderConnection[]> {
  await ensurePlatformSchema();
  const rows = await db().select().from(t.oauthConnections);
  return PROVIDERS.map((provider) => {
    const stored = rows.find((candidate) => candidate.provider_id === provider.id);
    const envKey = hasProviderApiKey(provider.id);
    let status: ConnectionStatus =
      provider.auth === "none"
        ? "connected"
        : ((stored?.status as ConnectionStatus | undefined) ?? "disconnected");
    let detail = stored?.detail ?? null;
    if (status !== "connected" && envKey) {
      status = "connected";
      detail = `Using server ${providerApiKeyEnvName(provider.id)} (env)`;
    }
    return {
      provider_id: provider.id,
      label: provider.label,
      summary: provider.summary,
      tier: provider.tier,
      auth: provider.auth,
      configured: providerConfigured(provider) || envKey,
      status,
      account_label: stored?.account_label ?? (envKey ? "env API key" : null),
      scopes: (stored?.scopes as string[] | undefined) ?? provider.oauth?.scopes ?? [],
      expires_at: stored?.expires_at ?? null,
      connected_by: stored?.connected_by ?? (envKey ? "environment" : null),
      connected_at: stored?.connected_at ?? null,
      detail,
      models: provider.models,
      default_model: provider.default_model,
    };
  });
}

export async function connectionStatus(provider_id: string): Promise<ConnectionStatus> {
  const provider = findProvider(provider_id);
  if (!provider) return "error";
  if (provider.auth === "none") return "connected";
  const stored = await row(provider_id);
  const status = (stored?.status as ConnectionStatus | undefined) ?? "disconnected";
  if (status === "connected") return "connected";
  if (hasProviderApiKey(provider_id)) return "connected";
  return status;
}

async function upsert(values: typeof t.oauthConnections.$inferInsert) {
  await ensurePlatformSchema();
  await db()
    .insert(t.oauthConnections)
    .values(values)
    .onConflictDoUpdate({ target: t.oauthConnections.provider_id, set: values });
}

/**
 * Starts an authorization-code + PKCE flow and returns the URL the browser must
 * visit. The verifier is stored server-side until the callback arrives.
 */
export async function beginOauth(args: {
  provider_id: string;
  redirect_uri: string;
  actor_name: string;
}): Promise<{ authorize_url: string }> {
  const provider = findProvider(args.provider_id);
  if (!provider?.oauth) throw new Error(`${args.provider_id} does not use OAuth`);
  const clientId = resolveOAuthClientId(provider);
  if (!clientId && !provider.oauth.client_id_optional) {
    throw new Error(`${provider.label} does not have an OAuth client id configured.`);
  }
  const { verifier, challenge } = createPkcePair();
  const state = base64Url(randomBytes(16));
  const detail: PendingDetail = { state, code_verifier: verifier, redirect_uri: args.redirect_uri };
  await upsert({
    provider_id: provider.id,
    status: "pending",
    scopes: provider.oauth.scopes,
    account_label: null,
    access_token: null,
    refresh_token: null,
    expires_at: null,
    connected_by: args.actor_name,
    connected_at: null,
    detail: JSON.stringify(detail),
  });
  const url = new URL(provider.oauth.authorize_url);
  if (!provider.oauth.omit_response_type) url.searchParams.set("response_type", "code");
  if (!provider.oauth.omit_client_id && clientId) url.searchParams.set("client_id", clientId);
  url.searchParams.set(provider.oauth.redirect_param ?? "redirect_uri", args.redirect_uri);
  if (!provider.oauth.omit_scope && provider.oauth.scopes.length > 0) {
    url.searchParams.set("scope", provider.oauth.scopes.join(" "));
  }
  url.searchParams.set("state", state);
  if (provider.oauth.pkce) {
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
  }
  const extras = publicOAuthClient(provider.id)?.authorize_params;
  if (extras) {
    for (const [key, value] of Object.entries(extras)) {
      url.searchParams.set(key, value);
    }
  }
  return { authorize_url: url.toString() };
}

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

/**
 * Token exchange. Most providers speak form-encoded OAuth 2.0; OpenRouter posts
 * JSON and returns the credential under its own field name.
 */
async function exchange(provider: LlmProvider, params: Record<string, string>) {
  if (!provider.oauth) throw new Error("provider has no OAuth descriptor");
  const json = provider.oauth.token_style === "json";
  const res = await fetch(provider.oauth.token_url, {
    method: "POST",
    headers: {
      "content-type": json ? "application/json" : "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: json ? JSON.stringify(params) : new URLSearchParams(params),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`token endpoint HTTP ${res.status}: ${text.slice(0, 300)}`);
  const payload = JSON.parse(text) as Record<string, unknown>;
  const field = provider.oauth.token_field ?? "access_token";
  return {
    access_token: typeof payload[field] === "string" ? (payload[field] as string) : undefined,
    refresh_token: typeof payload.refresh_token === "string" ? payload.refresh_token : undefined,
    expires_in: typeof payload.expires_in === "number" ? payload.expires_in : undefined,
    error: typeof payload.error === "string" ? payload.error : undefined,
    error_description:
      typeof payload.error_description === "string" ? payload.error_description : undefined,
  } satisfies TokenResponse;
}

export async function completeOauth(args: {
  provider_id: string;
  code: string;
  state: string;
}): Promise<ProviderConnection> {
  const provider = findProvider(args.provider_id);
  if (!provider?.oauth) throw new Error(`${args.provider_id} does not use OAuth`);
  const stored = await row(args.provider_id);
  const pending = stored?.detail ? (JSON.parse(stored.detail) as PendingDetail) : null;
  if (!pending || pending.state !== args.state) {
    throw new Error("OAuth state does not match a pending authorization");
  }
  const clientId = resolveOAuthClientId(provider);
  const params: Record<string, string> = {
    code: args.code,
    code_verifier: pending.code_verifier,
  };
  if (!provider.oauth.omit_response_type) params.grant_type = "authorization_code";
  if (!provider.oauth.omit_client_id && clientId) params.client_id = clientId;
  if (!provider.oauth.redirect_param) params.redirect_uri = pending.redirect_uri;
  const secret = resolveOAuthClientSecret(provider);
  if (secret) params.client_secret = secret;
  const tokenExtras = publicOAuthClient(provider.id)?.token_params;
  if (tokenExtras) Object.assign(params, tokenExtras);
  const token = await exchange(provider, params);
  if (!token.access_token) {
    throw new Error(token.error_description ?? token.error ?? "token endpoint returned no token");
  }
  await upsert({
    provider_id: provider.id,
    status: "connected",
    scopes: provider.oauth.scopes,
    account_label: new URL(provider.oauth.authorize_url).host,
    access_token: token.access_token,
    refresh_token: token.refresh_token ?? null,
    expires_at: token.expires_in
      ? new Date(Date.now() + token.expires_in * 1000).toISOString()
      : null,
    connected_by: stored?.connected_by ?? null,
    connected_at: nowIso(),
    detail: null,
  });
  const connections = await listConnections();
  return connections.find((connection) => connection.provider_id === provider.id)!;
}

export async function disconnect(provider_id: string) {
  await ensurePlatformSchema();
  await db().delete(t.oauthConnections).where(eq(t.oauthConnections.provider_id, provider_id));
}

/** Returns a usable access token, refreshing first when it is close to expiry.
 * Falls back to a server-side API key when OAuth is not connected. */
export async function accessToken(provider_id: string): Promise<string | null> {
  const provider = findProvider(provider_id);
  if (!provider?.oauth) {
    return providerApiKey(provider_id);
  }
  const stored = await row(provider_id);
  if (!stored?.access_token) {
    return providerApiKey(provider_id);
  }
  const expiresAt = stored.expires_at ? Date.parse(stored.expires_at) : null;
  const stale = expiresAt !== null && expiresAt - Date.now() < 60_000;
  if (!stale) return stored.access_token;
  if (!stored.refresh_token) {
    await upsert({
      provider_id,
      status: "error",
      scopes: (stored.scopes as string[]) ?? [],
      detail: "Access token expired and no refresh token is stored. Reconnect.",
      access_token: null,
      refresh_token: null,
      expires_at: null,
      account_label: stored.account_label,
      connected_by: stored.connected_by,
      connected_at: stored.connected_at,
    });
    return providerApiKey(provider_id);
  }
  const clientId = resolveOAuthClientId(provider);
  if (!clientId && !provider.oauth.client_id_optional) {
    return providerApiKey(provider_id);
  }
  const params: Record<string, string> = {
    grant_type: "refresh_token",
    refresh_token: stored.refresh_token,
  };
  if (clientId) params.client_id = clientId;
  const secret = resolveOAuthClientSecret(provider);
  if (secret) params.client_secret = secret;
  const token = await exchange(provider, params);
  if (!token.access_token) return providerApiKey(provider_id);
  await upsert({
    provider_id,
    status: "connected",
    scopes: (stored.scopes as string[]) ?? provider.oauth.scopes,
    account_label: stored.account_label,
    access_token: token.access_token,
    refresh_token: token.refresh_token ?? stored.refresh_token,
    expires_at: token.expires_in
      ? new Date(Date.now() + token.expires_in * 1000).toISOString()
      : null,
    connected_by: stored.connected_by,
    connected_at: stored.connected_at,
    detail: null,
  });
  return token.access_token;
}

/** How credentials were obtained for a live completion. */
export async function authKindFor(
  provider_id: string,
): Promise<"oauth" | "api_key" | null> {
  const provider = findProvider(provider_id);
  if (!provider) return null;
  if (provider.auth === "none") return null;
  const stored = await row(provider_id);
  if (stored?.status === "connected" && stored.access_token) return "oauth";
  if (hasProviderApiKey(provider_id)) return "api_key";
  return null;
}
