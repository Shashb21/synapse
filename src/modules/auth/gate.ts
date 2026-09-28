/**
 * Optimistic gate for the customer app: a page needs a session and a selected
 * workspace. This only checks that the cookies are present; the signatures,
 * the session row and workspace membership are verified server-side (the db
 * resolver refuses a workspace cookie that does not verify, and the app shells
 * send anyone whose selection is stale back to /workspaces).
 *
 * Cookie names mirror SESSION_COOKIE (modules/auth/session.ts) and
 * WORKSPACE_COOKIE (modules/workspaces/context.ts); they are repeated here so
 * the proxy does not pull server-only modules into its bundle.
 */
export const PROXY_SESSION_COOKIE = "synapse_session";
export const PROXY_WORKSPACE_COOKIE = "synapse_workspace";
/** Set by the proxy on requests whose URL carries `?present=1` (Room presenting a page). */
export const PRESENT_HEADER = "x-synapse-present";

/**
 * Reachable by anyone: sign-in and sign-up (including /api/auth/password/*),
 * OAuth callbacks, and assets.
 */
const PUBLIC_PREFIXES = ["/login", "/signup", "/api/auth", "/api/oauth", "/_next", "/favicon.ico"];
/** The owner tool gates itself by owner role (see the admin routes). */
const ADMIN_PREFIXES = ["/admin", "/api/admin", "/api/accuracy", "/api/control"];
/** Need a session but no workspace: where a workspace is chosen, and your own account. */
const SESSION_ONLY_PREFIXES = ["/workspaces", "/api/workspaces", "/account", "/api/account"];

function under(pathname: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

/** A file in public/ (or any other asset) is never gated. */
function isAsset(pathname: string): boolean {
  return /\.[a-z0-9]{2,5}$/i.test(pathname.split("/").pop() ?? "");
}

export type Gate = "open" | "session" | "workspace";

/** What a path needs before it may be served. */
export function gateFor(pathname: string): Gate {
  if (under(pathname, PUBLIC_PREFIXES) || under(pathname, ADMIN_PREFIXES) || isAsset(pathname)) return "open";
  if (under(pathname, SESSION_ONLY_PREFIXES)) return "session";
  return "workspace";
}
