import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac, timingSafeEqual } from "node:crypto";
import { sessionSecret } from "@/modules/auth/secret";

/**
 * Which workspace a query belongs to. Every workspace is its own Postgres
 * schema, so a query is scoped by choosing the schema, not by rewriting SQL.
 *
 * Resolution, in order:
 * 1. an explicit `runInWorkspace` scope (tests, scripts, background work);
 * 2. inside a web request, the signed workspace cookie — set only after a
 *    membership check and bound to the signed-in session;
 * 3. outside any request, the `public` schema (the Default workspace).
 */

export const WORKSPACE_COOKIE = "synapse_workspace";
/** Mirrors SESSION_COOKIE in modules/auth/session.ts (kept here to avoid an import cycle). */
const SESSION_COOKIE = "synapse_session";

/** The Default workspace keeps the data that existed before workspaces. */
export const DEFAULT_SCHEMA = "public";

export class NoWorkspaceError extends Error {
  constructor(message = "Choose a workspace first.") {
    super(message);
    this.name = "NoWorkspaceError";
  }
}

const scope = new AsyncLocalStorage<{ workspace_id: string; schema: string }>();

/** Runs `fn` with every query scoped to one workspace schema. */
export function runInWorkspace<T>(workspace: { workspace_id: string; schema: string }, fn: () => T): T {
  return scope.run(workspace, fn);
}

/**
 * How long a workspace selection stays valid. It matches the session lifetime
 * (modules/auth/session.ts), so a copied cookie stops working with the session.
 */
export const WORKSPACE_COOKIE_TTL_MS = 12 * 60 * 60 * 1000;

/** Signed with SESSION_SECRET; production never falls back to a default (see modules/auth/secret.ts). */
function sign(workspaceId: string, expiresAt: number, sessionId: string): string {
  return createHmac("sha256", sessionSecret())
    .update(`${workspaceId}.${expiresAt}.${sessionId}`)
    .digest("base64url");
}

/**
 * The cookie value that selects `workspaceId` for this session:
 * `<workspace id>.<expiry ms>.<hmac>`. The expiry is part of the signed value.
 */
export function workspaceCookieValue(
  workspaceId: string,
  sessionId: string,
  options: { now?: number; ttlMs?: number } = {},
): string {
  const expiresAt = (options.now ?? Date.now()) + (options.ttlMs ?? WORKSPACE_COOKIE_TTL_MS);
  return `${workspaceId}.${expiresAt}.${sign(workspaceId, expiresAt, sessionId)}`;
}

/**
 * The workspace id a cookie selects, when its signature matches the session
 * and it has not expired. Anything else (forged, expired, another session's,
 * or the old unexpiring format) is null.
 */
export function verifyWorkspaceCookie(
  value: string | undefined,
  sessionId: string | undefined,
  now: number = Date.now(),
): string | null {
  if (!value || !sessionId) return null;
  const sigDot = value.lastIndexOf(".");
  if (sigDot <= 0) return null;
  const expDot = value.lastIndexOf(".", sigDot - 1);
  if (expDot <= 0) return null;
  const id = value.slice(0, expDot);
  const expRaw = value.slice(expDot + 1, sigDot);
  if (!/^\d{1,16}$/.test(expRaw)) return null;
  const expiresAt = Number(expRaw);
  const given = Buffer.from(value.slice(sigDot + 1));
  const expected = Buffer.from(sign(id, expiresAt, sessionId));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  if (expiresAt <= now) return null;
  return id;
}

type RequestCookies = { get(name: string): { value: string } | undefined };

async function requestCookies(): Promise<RequestCookies | null> {
  try {
    const { cookies } = await import("next/headers");
    return (await cookies()) as RequestCookies;
  } catch {
    return null; // not inside a request
  }
}

/** The workspace id selected for the current request, or null. */
export async function selectedWorkspaceId(): Promise<string | null> {
  const scoped = scope.getStore();
  if (scoped) return scoped.workspace_id;
  const jar = await requestCookies();
  if (!jar) return null;
  return verifyWorkspaceCookie(jar.get(WORKSPACE_COOKIE)?.value, jar.get(SESSION_COOKIE)?.value);
}

/**
 * The schema the current query runs in. `lookup` maps a workspace id to its
 * schema (it reads the shared workspaces table). A request that carries a
 * workspace cookie that does not verify is refused rather than served the
 * Default workspace.
 */
export async function currentSchema(lookup: (workspaceId: string) => Promise<string | null>): Promise<string> {
  const scoped = scope.getStore();
  if (scoped) return scoped.schema;
  const jar = await requestCookies();
  if (!jar) return DEFAULT_SCHEMA;
  const raw = jar.get(WORKSPACE_COOKIE)?.value;
  if (!raw) return DEFAULT_SCHEMA;
  const id = verifyWorkspaceCookie(raw, jar.get(SESSION_COOKIE)?.value);
  if (!id) throw new NoWorkspaceError("Your workspace selection has expired. Choose a workspace again.");
  const schema = await lookup(id);
  if (!schema) throw new NoWorkspaceError("That workspace no longer exists. Choose another.");
  return schema;
}
