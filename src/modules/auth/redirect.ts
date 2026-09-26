/**
 * Where to send someone after sign-in or after choosing a workspace. Only
 * same-site paths are honoured, so a crafted `next` cannot bounce a person to
 * another origin, and the auth pages themselves are never a destination.
 */
export function safeNext(value: string | null | undefined, fallback = "/"): string {
  const next = (value ?? "").trim();
  if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return fallback;
  if (/^\/(login|workspaces|api\/auth)(\/|\?|$)/.test(next)) return fallback;
  return next;
}

/** Cookie that carries `next` across the identity provider round-trip. */
export const LOGIN_NEXT_COOKIE = "synapse_login_next";

/** Where a fresh sign-in lands: the workspace picker, remembering where they were headed. */
export function afterSignIn(next: string | null | undefined): string {
  const target = safeNext(next, "");
  return target ? `/workspaces?next=${encodeURIComponent(target)}` : "/workspaces";
}
