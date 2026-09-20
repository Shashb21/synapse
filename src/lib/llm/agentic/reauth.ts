import type { ReauthEvent, ReauthHook } from "./types";

const hooks = new Set<ReauthHook>();
const history: ReauthEvent[] = [];
const HISTORY_CAP = 50;

export function registerReauthHook(hook: ReauthHook): () => void {
  hooks.add(hook);
  return () => {
    hooks.delete(hook);
  };
}

export function clearReauthHooks() {
  hooks.clear();
}

export function reauthHistory(): ReauthEvent[] {
  return [...history];
}

export function clearReauthHistory() {
  history.length = 0;
}

export async function emitReauth(event: ReauthEvent): Promise<void> {
  history.push(event);
  if (history.length > HISTORY_CAP) history.splice(0, history.length - HISTORY_CAP);
  for (const hook of hooks) {
    try {
      await hook(event);
    } catch {
      // Hooks must not break agentic calls.
    }
  }
}

/** Default hook: log the event without tokens. */
export function defaultReauthLogHook(event: ReauthEvent): void {
  const line = `[agentic-reauth] ${event.type}${
    event.type === "refresh_failed" || event.type === "unauthorized" ? `: ${event.error}` : ""
  }`;
  if (event.type === "refresh_failed" || event.type === "unauthorized") {
    console.error(line);
  } else {
    console.info(line);
  }
}
