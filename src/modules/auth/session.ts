import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { and, eq } from "drizzle-orm";
import { ensurePlatformSchema, sharedDb } from "@/modules/kernel/db";
import * as t from "@/modules/kernel/schema";
import { nowIso } from "@/modules/kernel/ids";
import { recordAuditBestEffort } from "@/modules/kernel/audit";
import type { ActorFunction } from "@/lib/iegp/enums";
import { ACTOR_FUNCTIONS } from "@/lib/iegp/enums";
import type { Actor } from "@/modules/kernel/contracts";
import { ROLE_LABELS, isRole, ownerEmails, roleForFunction, testOwnerBypass, type Role } from "./roles";
import { findAccountByEmail, getAccount, isAdminEmail, passwordSessionValid, PASSWORD_PROVIDER, type Account } from "./accounts";
import { hasActiveSeat } from "./customers";
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
/** An identity provider that does not answer in this long fails the sign-in instead of hanging it (KAN-20). */
const IDP_TIMEOUT_MS = 15_000;

async function idpFetch(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(IDP_TIMEOUT_MS) });
  } catch {
    throw new Error("Your sign-in provider could not be reached or did not answer in time. Try signing in again.");
  }
}

export type Session = {
  /**
   * The cookie token. Only its hash is stored (see sessionKey), so a database
   * read alone cannot be replayed as a sign-in. Rows listed by activeSessions
   * carry the hash instead, since the token is not on record.
   */
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

/** What auth_sessions.id holds for a session token: sha256, hex (KAN-20). */
export function sessionKey(token: string): string {
  return createHash("sha256").update(token).digest("hex");
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
    id: sessionKey(id),
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

/**
 * Sessions verified in the last minute, for attributing a change only (KAN-90).
 * Access checks always call `currentSession`, which reads the database. A
 * change's record is often written inside a transaction; with a one-connection
 * pool (Vercel, Vitest) a second query there would wait forever, so the record
 * reuses the session the request's guard already verified.
 */
const RECENT_SESSION_MS = 60_000;
const recentSessions = new Map<string, { session: Session; at: number }>();

function rememberSession(session: Session) {
  if (recentSessions.size > 1_000) {
    const cutoff = Date.now() - RECENT_SESSION_MS;
    for (const [id, entry] of recentSessions) if (entry.at < cutoff) recentSessions.delete(id);
  }
  // Keyed by the session's stored (hashed) key, never the cookie token itself.
  recentSessions.set(sessionKey(session.id), { session, at: Date.now() });
}

/** The session this cookie named when it was last verified, within the last minute. Never for access checks. */
export function recentlyVerifiedSession(id: string): Session | null {
  const entry = recentSessions.get(sessionKey(id));
  if (!entry || Date.now() - entry.at > RECENT_SESSION_MS) return null;
  return entry.session;
}

export async function currentSession(): Promise<Session | null> {
  const jar = await cookies();
  const id = jar.get(SESSION_COOKIE)?.value;
  if (!id) return null;
  await ensurePlatformSchema();
  const key = sessionKey(id);
  recentSessions.delete(key);
  const rows = await sharedDb().select().from(t.authSessions).where(eq(t.authSessions.id, key)).limit(1);
  const row = rows[0];
  if (!row) return null;
  const expired = Date.parse(row.expires_at) < Date.now();
  if (expired || !(await sessionStillAllowed(row))) {
    const gone = await sharedDb().delete(t.authSessions).where(eq(t.authSessions.id, key)).returning({ id: t.authSessions.id });
    // A live session refused mid-way (disabled, seat removed, customer deactivated) is a revocation worth recording.
    if (!expired && gone.length > 0) {
      await recordAuditBestEffort({
        category: "auth",
        action: "auth.session_revoked",
        entity_type: "user",
        entity_id: row.subject,
        actor: { principal: row.email ?? `${row.provider_id}:${row.subject}`, name: row.actor_name, role: row.role },
        workspace_id: null,
        meta: { method: row.provider_id, reason: "no_longer_allowed" },
      });
    }
    return null;
  }
  const session: Session = {
    id,
    provider_id: row.provider_id,
    subject: row.subject,
    email: row.email,
    actor: { name: row.actor_name, function: asFunction(row.actor_function) },
    role: isRole(row.role) ? row.role : "contributor",
    created_at: row.created_at,
    expires_at: row.expires_at,
  };
  rememberSession(session);
  return session;
}

/** The `?error=` code /login shows the no-seat message for (see LOGIN_ERROR_MESSAGES). */
export const NO_SEAT_ERROR = "no_seat";
export const NO_SEAT_MESSAGE = "Your organisation hasn't assigned you a Synapse seat. Ask your administrator.";

/**
 * The only messages /login shows for `?error=` (KAN-28). The callback sends a
 * code, never text: a link carrying any other text gets the generic message, so
 * nobody can make the sign-in page say something it does not.
 */
export const LOGIN_ERROR_MESSAGES = {
  [NO_SEAT_ERROR]: NO_SEAT_MESSAGE,
  cancelled: "The sign-in was cancelled or refused by your identity provider. Try again.",
  expired: "That sign-in was interrupted or took too long. Start again.",
  not_configured: "That sign-in option isn't set up in this deployment.",
  other_directory: "That Microsoft account belongs to another organisation's directory.",
  failed: "Sign-in failed. Try again.",
} as const;

export type LoginErrorCode = keyof typeof LOGIN_ERROR_MESSAGES;

/** The message /login shows for a raw `?error=` value: a known code's, else the generic one. */
export function loginErrorMessage(raw: string | null | undefined): string | null {
  const code = raw?.trim();
  if (!code) return null;
  return Object.hasOwn(LOGIN_ERROR_MESSAGES, code) ? LOGIN_ERROR_MESSAGES[code as LoginErrorCode] : LOGIN_ERROR_MESSAGES.failed;
}

/** The code the callback sends for a failed sign-in; the detail stays in the audit log. */
export function loginErrorCode(error: unknown): LoginErrorCode {
  if (error instanceof NoSeatError) return NO_SEAT_ERROR;
  const message = error instanceof Error ? error.message : "";
  if (/no sign-in is in progress|state mismatch/i.test(message)) return "expired";
  if (/not configured/i.test(message)) return "not_configured";
  if (/another directory/i.test(message)) return "other_directory";
  return "failed";
}

/** SSO refused: the verified email holds no seat on an active customer. Carries no detail on purpose. */
export class NoSeatError extends Error {
  readonly code = NO_SEAT_ERROR;
  /** The verified email that has no seat, for the audit log (never shown to the person). */
  constructor(readonly email: string | null = null) {
    super(NO_SEAT_MESSAGE);
    this.name = "NoSeatError";
  }
}

/**
 * Whether an SSO identity may have a session (KAN-28): its verified email holds
 * a seat on an active customer, or it is a platform admin (OWNER_EMAILS, or an
 * enabled admin account with that email). No verified email, no seat.
 */
export async function seatAllowsSignIn(email: string | null | undefined): Promise<boolean> {
  const address = email?.trim().toLowerCase();
  if (!address) return false;
  if (ownerEmails().includes(address)) return true;
  if (await hasActiveSeat(address)) return true;
  return isAdminEmail(address);
}

/**
 * A test customer account (KAN-59): not staff, but allowed to sign in with a
 * password because its verified email is on a test-only domain (so no real
 * person can hold it) and holds a seat on an active customer. Real customers
 * stay SSO-only.
 */
export async function testSeatPasswordAllowed(
  account: Pick<Account, "email" | "email_verified" | "disabled">,
): Promise<boolean> {
  if (account.disabled || !account.email_verified || !testOnlyAddress(account.email)) return false;
  return hasActiveSeat(account.email);
}

/**
 * Re-checked on every session lookup, so an unassigned seat, a deactivated
 * customer or a demoted staff account stops working even if a session row
 * survived. Demo sessions (development only) need nothing; password sessions
 * need a staff account or a test seat (KAN-59); SSO sessions need a seat (one
 * indexed query).
 */
async function sessionStillAllowed(row: { provider_id: string; subject: string; email: string | null }): Promise<boolean> {
  if (row.provider_id === "demo") return true;
  if (row.provider_id === PASSWORD_PROVIDER) {
    if (await passwordSessionValid(row.subject)) return true;
    const account = await getAccount(row.subject);
    return account ? testSeatPasswordAllowed(account) : false;
  }
  return seatAllowsSignIn(row.email);
}

export async function signOut() {
  const jar = await cookies();
  const id = jar.get(SESSION_COOKIE)?.value;
  if (id) {
    await ensurePlatformSchema();
    const [ended] = await sharedDb().delete(t.authSessions).where(eq(t.authSessions.id, sessionKey(id))).returning();
    if (ended) {
      await recordAuditBestEffort({
        category: "auth",
        action: "auth.logout",
        entity_type: "user",
        entity_id: ended.subject,
        actor: { principal: ended.email ?? `${ended.provider_id}:${ended.subject}`, name: ended.actor_name, role: ended.role },
        workspace_id: null,
        meta: { method: ended.provider_id },
      });
    }
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
  await recordAuditBestEffort({
    category: "auth",
    action: "auth.sso_start",
    actor: { principal: "anonymous", name: "Anonymous", role: null },
    workspace_id: null,
    meta: { method: "sso", provider_id: provider.id },
  });
  return { authorize_url: url.toString() };
}

/**
 * Finishes an SSO sign-in and records it in the audit log (KAN-88): success
 * with the person, or the refusal with its reason. Best-effort, so a logging
 * failure never blocks sign-in.
 */
export async function completeLogin(args: { code: string; state: string }): Promise<Session> {
  const jar = await cookies();
  let provider_id: string | null = null;
  try {
    provider_id = (JSON.parse(jar.get(PENDING_COOKIE)?.value ?? "null") as { provider_id?: string } | null)?.provider_id ?? null;
  } catch {
    provider_id = null;
  }
  try {
    const session = await exchangeLogin(args);
    await recordAuditBestEffort({
      category: "auth",
      action: "auth.login",
      entity_type: "user",
      entity_id: session.subject,
      actor: { principal: session.email ?? `${session.provider_id}:${session.subject}`, name: session.actor.name, role: session.role },
      workspace_id: null,
      meta: { method: "sso", provider_id: session.provider_id, email: session.email },
    });
    return session;
  } catch (error) {
    const email = error instanceof NoSeatError ? error.email : null;
    await recordAuditBestEffort({
      category: "auth",
      action: "auth.login_failed",
      entity_type: "user",
      actor: { principal: email ? email.toLowerCase() : "anonymous", name: "Unknown", role: null },
      workspace_id: null,
      meta: {
        method: "sso",
        provider_id,
        reason: error instanceof NoSeatError ? "no_active_seat" : "refused",
        detail: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
        ...(email ? { email: email.toLowerCase() } : {}),
      },
    });
    throw error;
  }
}

async function exchangeLogin(args: { code: string; state: string }): Promise<Session> {
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
  const tokenRes = await idpFetch(provider.descriptor.token_url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
  });
  const tokenText = await tokenRes.text();
  if (!tokenRes.ok) throw new Error(`Token exchange failed (HTTP ${tokenRes.status}).`);
  const token = JSON.parse(tokenText) as { access_token?: string; id_token?: unknown };
  if (!token.access_token) throw new Error("Token exchange returned no access token.");
  const profileRes = await idpFetch(provider.userinfo_url, {
    headers: { authorization: `Bearer ${token.access_token}`, accept: "application/json" },
  });
  if (!profileRes.ok) throw new Error(`Profile lookup failed (HTTP ${profileRes.status}).`);
  const profile = (await profileRes.json()) as Record<string, unknown>;
  let github_emails: GithubEmail[] | null = null;
  if (provider.id === "github") {
    const emailsRes = await idpFetch(GITHUB_EMAILS_URL, {
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
  // Customers sign in only with a seat their organisation was assigned (KAN-28).
  if (!(await seatAllowsSignIn(sessionArgs.email))) throw new NoSeatError(sessionArgs.email);
  return createSession(await withoutClaimedOperator(sessionArgs));
}

/**
 * A customer's own directory can set the `synapse_role` claim, so an IdP may
 * never grant "operator" (which is platform owner) to a seat holder: only
 * OWNER_EMAILS and admin accounts keep it. Anyone else gets their function's role.
 */
export async function withoutClaimedOperator(
  args: Parameters<typeof createSession>[0],
): Promise<Parameters<typeof createSession>[0]> {
  if (args.role !== "operator") return args;
  const email = args.email?.trim().toLowerCase();
  const platformAdmin = Boolean(email) && (ownerEmails().includes(email!) || (await isAdminEmail(email!)));
  return platformAdmin ? args : { ...args, role: roleForFunction(args.actor_function) };
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
 * (SYNAPSE_TEST_STUB_LLM=1, never production) a supplied `role` is ignored: a
 * demo user is a "contributor". Under the test stub the role (never
 * "operator") is honoured, and without a role it follows the function, so the
 * Playwright/Vitest suites keep their Medical Affairs demo user.
 *
 * A typed email becomes the session's email (and so its workspace principal)
 * only when it is safe to: see demoEmailFor. Otherwise sign-in is refused with
 * the reason; nothing is silently swapped for a generated address.
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
  const session = await createSession({
    provider_id: "demo",
    subject: `demo:${name}`,
    email: await demoEmailFor(name, args.email),
    actor_name: name,
    actor_function: fn,
    role: demoRole(fn, args.role),
  });
  await recordAuditBestEffort({
    category: "auth",
    action: "auth.login",
    entity_type: "user",
    entity_id: session.subject,
    actor: { principal: session.email ?? `demo:${session.subject}`, name, role: session.role },
    workspace_id: null,
    meta: { method: "demo" },
  });
  return session;
}

/** The role a demo sign-in gets (see signInDemo). Never "operator". */
export function demoRole(fn: ActorFunction, requested?: string | null): Role {
  if (!testOwnerBypass()) return "contributor";
  if (requested && isRole(requested) && requested !== "operator") return requested;
  return roleForFunction(fn);
}

/** Top-level domains no real mailbox can have (RFC 2606, RFC 6761; .local is mDNS). */
const TEST_ONLY_TLDS = ["test", "example", "invalid", "localhost", "local"];
/** Second-level domains reserved for documentation (RFC 2606). */
const TEST_ONLY_DOMAINS = ["example.com", "example.net", "example.org"];
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Whether an address is on a domain reserved for testing, so no real person can hold it. */
export function testOnlyAddress(email: string): boolean {
  const address = email.trim().toLowerCase();
  if (!EMAIL_SHAPE.test(address)) return false;
  const domain = address.slice(address.lastIndexOf("@") + 1);
  const tld = domain.slice(domain.lastIndexOf(".") + 1);
  return (
    TEST_ONLY_TLDS.includes(tld) ||
    TEST_ONLY_DOMAINS.some((reserved) => domain === reserved || domain.endsWith(`.${reserved}`))
  );
}

export const DEMO_EMAIL_DOMAIN_MESSAGE =
  "A demo email must be on a test-only domain, such as name@team.test or name@example.com, so it can never be a real person's address. Leave it empty to use a generated one.";
export const DEMO_EMAIL_TAKEN_MESSAGE =
  "That address belongs to a Synapse account or a customer seat, so a demo user can't use it. Pick another test address, or leave it empty.";

/**
 * The email a demo sign-in is known by. Empty: `<name>@demo.synapse.local`.
 * Typed: used as-is (so invites sent to it reach this demo user), but only when
 *
 * - it is on a test-only domain (testOnlyAddress), so it cannot be a real
 *   customer's address and so cannot take over their workspaces or invites
 *   (workspace membership is keyed by email, see principalOf); and
 * - it is not an OWNER_EMAILS address, an email + password account's email
 *   (staff or admin) or a seat holder's email (KAN-28), even a test-only one.
 *
 * Either failure refuses the sign-in. Owner status never comes from it:
 * ownerDecision ignores the email of every demo session.
 */
export async function demoEmailFor(name: string, requested?: string | null): Promise<string> {
  const supplied = requested?.trim().toLowerCase();
  if (!supplied) return demoEmail(name);
  if (!testOnlyAddress(supplied)) throw new Error(DEMO_EMAIL_DOMAIN_MESSAGE);
  if (
    ownerEmails().includes(supplied) ||
    (await findAccountByEmail(supplied).then(Boolean, () => true)) ||
    (await hasActiveSeat(supplied).catch(() => true))
  ) {
    throw new Error(DEMO_EMAIL_TAKEN_MESSAGE);
  }
  return supplied;
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
