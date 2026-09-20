import { randomUUID } from "node:crypto";
import type { ReauthEvent, ReauthHook } from "./types";
import { recordReauthEvent } from "./tracking";

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
  const stamped: ReauthEvent = {
    ...event,
    id: event.id ?? `RAUTH-${randomUUID().slice(0, 8)}`,
    at: event.at ?? new Date().toISOString(),
  };
  history.push(stamped);
  if (history.length > HISTORY_CAP) history.splice(0, history.length - HISTORY_CAP);
  await recordReauthEvent(stamped);
  for (const hook of hooks) {
    try {
      await hook(stamped);
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
