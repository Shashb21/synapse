import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { and, eq } from "drizzle-orm";
import { ensurePlatformSchema, sharedDb } from "@/modules/kernel/db";
import * as t from "@/modules/kernel/schema";
import { nowIso } from "@/modules/kernel/ids";
import type { ActorFunction } from "@/lib/iegp/enums";
import { ACTOR_FUNCTIONS } from "@/lib/iegp/enums";
import type { Actor } from "@/modules/kernel/contracts";
import { signupAllowed } from "./signup-policy";
import { ROLE_LABELS, isRole, roleForFunction, testOwnerBypass, type Role } from "./roles";
import {
  configuredIdentityProviders,
  demoMode,
  demoSignInAllowed,
  emailDomainAllowed,
  GITHUB_EMAILS_URL,
  identityProvider,
  idpRefusal,
  idTokenClaims,
  resolveIdentity,
  type GithubEmail,
  type IdentityProvider,
} from "./idp";

export const SESSION_COOKIE = "synapse_session";
const PENDING_COOKIE = "synapse_oauth_pending";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export type Session = {
  id: string;
  provider_id: string;
  subject: string;
  email: string | null;
  actor: Actor;
  role: Role;
  created_at: string;
  expires_at: string;
};

export type SessionContext = {
  session: Session | null;
  actor: Actor;
  role: Role;
  /** True when no identity provider is configured and the typed-name gate stands in. */
  demo: boolean;
  signed_in: boolean;
};

function base64Url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function asFunction(value: string | undefined | null): ActorFunction {
  return ACTOR_FUNCTIONS.includes((value ?? "") as ActorFunction)
    ? (value as ActorFunction)
    : "medical_affairs";
}

export async function createSession(args: {
  provider_id: string;
  subject: string;
  email?: string | null;
  actor_name: string;
  actor_function: ActorFunction;
  role: Role;
}): Promise<Session> {
  await ensurePlatformSchema();
  const id = base64Url(randomBytes(24));
  const created_at = nowIso();
  const expires_at = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  await sharedDb().insert(t.authSessions).values({
    id,
    provider_id: args.provider_id,
    subject: args.subject,
    email: args.email ?? null,
    actor_name: args.actor_name,
    actor_function: args.actor_function,
    role: args.role,
    created_at,
    expires_at,
  });
  const jar = await cookies();
  jar.set(SESSION_COOKIE, id, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_TTL_MS / 1000,
  });
  return {
    id,
    provider_id: args.provider_id,
    subject: args.subject,
    email: args.email ?? null,
    actor: { name: args.actor_name, function: args.actor_function },
    role: args.role,
    created_at,
    expires_at,
  };
}

export async function currentSession(): Promise<Session | null> {
  const jar = await cookies();
  const id = jar.get(SESSION_COOKIE)?.value;
  if (!id) return null;
  await ensurePlatformSchema();
  const rows = await sharedDb().select().from(t.authSessions).where(eq(t.authSessions.id, id)).limit(1);
  const row = rows[0];
  if (!row) return null;
  if (Date.parse(row.expires_at) < Date.now()) {
    await sharedDb().delete(t.authSessions).where(eq(t.authSessions.id, id));
    return null;
  }
  return {
    id: row.id,
    provider_id: row.provider_id,
    subject: row.subject,
    email: row.email,
    actor: { name: row.actor_name, function: asFunction(row.actor_function) },
    role: isRole(row.role) ? row.role : "contributor",
    created_at: row.created_at,
    expires_at: row.expires_at,
  };
}

export async function signOut() {
  const jar = await cookies();
  const id = jar.get(SESSION_COOKIE)?.value;
  if (id) {
    await ensurePlatformSchema();
    await sharedDb().delete(t.authSessions).where(eq(t.authSessions.id, id));
  }
  jar.delete(SESSION_COOKIE);
}

/**
 * Identity for a request. When an identity provider is configured, the session
 * is the source of truth. In demo mode the app keeps its typed-name behaviour
 * and acts with the primary role.
 */
export async function sessionContext(): Promise<SessionContext> {
  const session = await currentSession();
  if (session) {
    return { session, actor: session.actor, role: session.role, demo: demoMode(), signed_in: true };
  }
  const demo = demoMode();
  return {
    session: null,
    actor: { name: demo ? "Unsigned (demo)" : "Anonymous", function: "medical_affairs" },
    role: demo ? "medical_affairs" : "viewer",
    demo,
    signed_in: false,
  };
}

export function roleLabel(role: Role): string {
  return ROLE_LABELS[role];
}

export async function beginLogin(args: {
  provider_id: string;
  redirect_uri: string;
}): Promise<{ authorize_url: string }> {
  const provider = identityProvider(args.provider_id);
  if (!provider) throw new Error(`Unknown identity provider ${args.provider_id}`);
  const clientId = process.env[provider.descriptor.client_id_env]?.trim();
  if (!clientId) throw new Error(`${provider.label} sign-in is not configured in this deployment.`);
  const refusal = idpRefusal(provider);
  if (refusal) throw new Error(refusal);
  const verifier = base64Url(randomBytes(48));
  const state = base64Url(randomBytes(16));
  const jar = await cookies();
  jar.set(PENDING_COOKIE, JSON.stringify({ provider_id: provider.id, state, verifier, redirect_uri: args.redirect_uri }), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 600,
    secure: process.env.NODE_ENV === "production",
  });
  const url = new URL(provider.descriptor.authorize_url);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", args.redirect_uri);
  url.searchParams.set("scope", provider.descriptor.scopes.join(" "));
  url.searchParams.set("state", state);
  if (provider.descriptor.pkce) {
    url.searchParams.set(
      "code_challenge",
      base64Url(createHash("sha256").update(verifier).digest()),
    );
    url.searchParams.set("code_challenge_method", "S256");
  }
  return { authorize_url: url.toString() };
}

export async function completeLogin(args: { code: string; state: string }): Promise<Session> {
  const jar = await cookies();
  const raw = jar.get(PENDING_COOKIE)?.value;
  if (!raw) throw new Error("No sign-in is in progress.");
  const pending = JSON.parse(raw) as {
    provider_id: string;
    state: string;
    verifier: string;
    redirect_uri: string;
  };
  if (pending.state !== args.state) throw new Error("Sign-in state mismatch.");
  const provider = identityProvider(pending.provider_id);
  if (!provider) throw new Error("Unknown identity provider.");
  const refusal = idpRefusal(provider);
  if (refusal) throw new Error(refusal);
  const clientId = process.env[provider.descriptor.client_id_env]?.trim();
  if (!clientId) throw new Error(`${provider.label} sign-in is not configured in this deployment.`);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: args.code,
    client_id: clientId,
    redirect_uri: pending.redirect_uri,
  });
  if (provider.descriptor.pkce) body.set("code_verifier", pending.verifier);
  const secret = provider.descriptor.client_secret_env
    ? process.env[provider.descriptor.client_secret_env]?.trim()
    : undefined;
  if (secret) body.set("client_secret", secret);
  const tokenRes = await fetch(provider.descriptor.token_url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
  });
  const tokenText = await tokenRes.text();
  if (!tokenRes.ok) throw new Error(`Token exchange failed (HTTP ${tokenRes.status}).`);
  const token = JSON.parse(tokenText) as { access_token?: string; id_token?: unknown };
  if (!token.access_token) throw new Error("Token exchange returned no access token.");
  const profileRes = await fetch(provider.userinfo_url, {
    headers: { authorization: `Bearer ${token.access_token}`, accept: "application/json" },
  });
  if (!profileRes.ok) throw new Error(`Profile lookup failed (HTTP ${profileRes.status}).`);
  const profile = (await profileRes.json()) as Record<string, unknown>;
  let github_emails: GithubEmail[] | null = null;
  if (provider.id === "github") {
    const emailsRes = await fetch(GITHUB_EMAILS_URL, {
      headers: { authorization: `Bearer ${token.access_token}`, accept: "application/json" },
    });
    const list = emailsRes.ok ? ((await emailsRes.json().catch(() => null)) as unknown) : null;
    github_emails = Array.isArray(list) ? (list as GithubEmail[]) : null;
  }
  const sessionArgs = loginIdentity({
    provider,
    profile,
    id_token_claims: idTokenClaims(token.id_token),
    github_emails,
  });
  jar.delete(PENDING_COOKIE);
  return createSession(sessionArgs);
}

/**
 * The session a completed OAuth sign-in gets. Only a verified email is kept
 * (else the subject `provider:id` is the principal), and ALLOWED_EMAIL_DOMAINS
 * is enforced here. Throws when the sign-in must be refused.
 */
export function loginIdentity(args: {
  provider: IdentityProvider;
  profile: Record<string, unknown>;
  id_token_claims?: Record<string, unknown>;
  github_emails?: GithubEmail[] | null;
}): Parameters<typeof createSession>[0] {
  const { provider, profile } = args;
  const refusal = idpRefusal(provider);
  if (refusal) throw new Error(refusal);
  const identity = resolveIdentity(args);
  if (!emailDomainAllowed(identity.email)) {
    throw new Error(
      identity.email
        ? "Your account's email domain is not allowed to sign in to this deployment."
        : "Sign-in needs a verified email address on an allowed domain.",
    );
  }
  const claimedRole = provider.role_claim ? profile[provider.role_claim] : undefined;
  const fn = asFunction(typeof profile.synapse_function === "string" ? profile.synapse_function : null);
  return {
    provider_id: provider.id,
    subject: identity.subject,
    email: identity.email,
    actor_name: identity.name,
    actor_function: fn,
    role: isRole(typeof claimedRole === "string" ? claimedRole : undefined)
      ? (claimedRole as Role)
      : roleForFunction(fn),
  };
}

/** The address a demo user is known by, so workspace invites work in local preview. */
export function demoEmail(actorName: string): string {
  const slug = actorName.trim().toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.+|\.+$/g, "");
  return `${slug || "demo"}@demo.synapse.local`;
}

/**
 * Demo sign-in for local preview and tests: the typed name is the identity.
 * Never available in a production build, identity provider or not.
 *
 * The caller cannot choose its privileges. Outside the test stub
 * (SYNAPSE_TEST_STUB_LLM=1, never production) a supplied `role` and `email`
 * are ignored: a demo user is a "contributor" known as `<name>@demo.synapse.local`.
 * Under the test stub the role (never "operator") and email are honoured, and
 * without a role it follows the function, so the Playwright/Vitest suites keep
 * their Medical Affairs demo user.
 */
export async function signInDemo(args: {
  actor_name: string;
  actor_function: ActorFunction;
  role?: Role;
  email?: string | null;
}): Promise<Session> {
  if (!demoSignInAllowed()) {
    throw new Error("Demo sign-in is not available in production. Sign in with your organisation's account.");
  }
  const name = args.actor_name.trim();
  if (!name) throw new Error("Enter a name to continue as a demo user.");
  const fn = asFunction(args.actor_function);
  return createSession({
    provider_id: "demo",
    subject: `demo:${name}`,
    email: demoEmailFor(name, args.email),
    actor_name: name,
    actor_function: fn,
    role: demoRole(fn, args.role),
  });
}

/** The role a demo sign-in gets (see signInDemo). Never "operator". */
export function demoRole(fn: ActorFunction, requested?: string | null): Role {
  if (!testOwnerBypass()) return "contributor";
  if (requested && isRole(requested) && requested !== "operator") return requested;
  return roleForFunction(fn);
}

/** The email a demo sign-in is known by: the supplied one only under the test stub. */
export function demoEmailFor(name: string, requested?: string | null): string {
  const supplied = requested?.trim().toLowerCase();
  return testOwnerBypass() && supplied ? supplied : demoEmail(name);
}

export async function activeSessions(): Promise<Session[]> {
  await ensurePlatformSchema();
  const rows = await sharedDb().select().from(t.authSessions);
  return rows
    .filter((row) => Date.parse(row.expires_at) > Date.now())
    .map((row) => ({
      id: row.id,
      provider_id: row.provider_id,
      subject: row.subject,
      email: row.email,
      actor: { name: row.actor_name, function: asFunction(row.actor_function) },
      role: isRole(row.role) ? row.role : "contributor",
      created_at: row.created_at,
      expires_at: row.expires_at,
    }));
}

export function loginOptions() {
  return {
    /** Offer "continue as a demo user": development and tests only, never production. */
    demo: demoSignInAllowed(),
    /** Self sign-up with email and password (ALLOW_SIGNUP, default open). */
    signup: signupAllowed(),
    providers: configuredIdentityProviders().map((provider) => ({
      id: provider.id,
      label: provider.label,
    })),
  };
}

export async function sessionsForSubject(subject: string) {
  await ensurePlatformSchema();
  return sharedDb()
    .select()
    .from(t.authSessions)
    .where(and(eq(t.authSessions.subject, subject)));
}
