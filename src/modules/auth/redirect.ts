/**
 * Where to send someone after sign-in or after choosing a workspace. Only
 * same-site paths are honoured, so a crafted `next` cannot bounce a person to
 * another origin, and the auth pages themselves are never a destination.
 */
export function safeNext(value: string | null | undefined, fallback = "/"): string {
  const next = (value ?? "").trim();
  if (!isSameOriginPath(next)) return fallback;
  if (/^\/(login|workspaces|api\/auth)(\/|\?|#|$)/i.test(decodeAll(next))) return fallback;
  return next;
}

const PROBE_ORIGIN = "https://synapse.invalid";

/** Undo percent-encoding until it settles, so `%2F%2F` or `%252F` cannot hide a `//`. */
function decodeAll(value: string): string {
  let current = value;
  for (let i = 0; i < 5; i += 1) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      return current;
    }
    if (decoded === current) return current;
    current = decoded;
  }
  return current;
}

/**
 * True only for a path on this site: one leading slash, no second slash or
 * backslash after it (raw or encoded), no control characters, no scheme, and
 * a browser resolving it against our origin stays on our origin (KAN-20).
 */
function isSameOriginPath(next: string): boolean {
  if (!next.startsWith("/")) return false;
  const decoded = decodeAll(next);
  for (const form of [next, decoded]) {
    // Browsers strip tabs and newlines and treat `\` like `/`, so `/\t/evil` is `//evil`.
    if (/[\u0000-\u001f\u007f\\]/.test(form)) return false;
    if (!form.startsWith("/") || form.startsWith("//")) return false;
  }
  try {
    const resolved = new URL(next, PROBE_ORIGIN);
    return resolved.origin === PROBE_ORIGIN;
  } catch {
    return false;
  }
}

/** Cookie that carries `next` across the identity provider round-trip. */
export const LOGIN_NEXT_COOKIE = "synapse_login_next";

/** Where a fresh sign-in lands: the workspace picker, remembering where they were headed. */
export function afterSignIn(next: string | null | undefined): string {
  const target = safeNext(next, "");
  return target ? `/workspaces?next=${encodeURIComponent(target)}` : "/workspaces";
}

/**
 * Where an owner's sign-in lands (KAN-58): the admin console, or the page they
 * were headed to. Staff email + password sign-in is only for admins and
 * operators (KAN-28), so it always lands here, not on the workspace picker.
 */
export function afterOwnerSignIn(next: string | null | undefined): string {
  return safeNext(next, "") || "/admin";
}
