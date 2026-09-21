import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, ensurePlatformSchema } from "@/modules/kernel/db";
import * as t from "@/modules/kernel/schema";
import { nowIso } from "@/modules/kernel/ids";
import { PROVIDERS, findProvider, providerConfigured, type LlmProvider } from "./provider";

export type ConnectionStatus = "disconnected" | "pending" | "connected" | "error";

export type ProviderConnection = {
  provider_id: string;
  label: string;
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
    const status: ConnectionStatus =
      provider.auth === "none"
        ? "connected"
        : ((stored?.status as ConnectionStatus | undefined) ?? "disconnected");
    return {
      provider_id: provider.id,
      label: provider.label,
      auth: provider.auth,
      configured: providerConfigured(provider),
      status,
      account_label: stored?.account_label ?? null,
      scopes: (stored?.scopes as string[] | undefined) ?? provider.oauth?.scopes ?? [],
      expires_at: stored?.expires_at ?? null,
      connected_by: stored?.connected_by ?? null,
      connected_at: stored?.connected_at ?? null,
      detail: stored?.detail ?? null,
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
  return (stored?.status as ConnectionStatus | undefined) ?? "disconnected";
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
  const clientId = process.env[provider.oauth.client_id_env]?.trim();
  if (!clientId) {
    throw new Error(
      `${provider.label} needs ${provider.oauth.client_id_env} in the environment before it can be connected.`,
    );
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
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", args.redirect_uri);
  url.searchParams.set("scope", provider.oauth.scopes.join(" "));
  url.searchParams.set("state", state);
  if (provider.oauth.pkce) {
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
  }
  return { authorize_url: url.toString() };
}

async function exchange(provider: LlmProvider, body: URLSearchParams) {
  if (!provider.oauth) throw new Error("provider has no OAuth descriptor");
  const res = await fetch(provider.oauth.token_url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`token endpoint HTTP ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
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
  const clientId = process.env[provider.oauth.client_id_env]!.trim();
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: args.code,
    client_id: clientId,
    redirect_uri: pending.redirect_uri,
    code_verifier: pending.code_verifier,
  });
  const secret = provider.oauth.client_secret_env
    ? process.env[provider.oauth.client_secret_env]?.trim()
    : undefined;
  if (secret) body.set("client_secret", secret);
  const token = await exchange(provider, body);
  if (!token.access_token) {
    throw new Error(token.error_description ?? token.error ?? "token endpoint returned no token");
  }
  await upsert({
    provider_id: provider.id,
    status: "connected",
    scopes: provider.oauth.scopes,
    account_label: pending.redirect_uri.includes("://")
      ? new URL(provider.oauth.token_url).host
      : null,
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

/** Returns a usable access token, refreshing first when it is close to expiry. */
export async function accessToken(provider_id: string): Promise<string | null> {
  const provider = findProvider(provider_id);
  if (!provider?.oauth) return null;
  const stored = await row(provider_id);
  if (!stored?.access_token) return null;
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
    return null;
  }
  const clientId = process.env[provider.oauth.client_id_env]?.trim();
  if (!clientId) return null;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: stored.refresh_token,
    client_id: clientId,
  });
  const secret = provider.oauth.client_secret_env
    ? process.env[provider.oauth.client_secret_env]?.trim()
    : undefined;
  if (secret) body.set("client_secret", secret);
  const token = await exchange(provider, body);
  if (!token.access_token) return null;
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
