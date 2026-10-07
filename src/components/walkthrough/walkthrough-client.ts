"use client";

/**
 * Browser side of the walkthrough: progress lives on the server (per person,
 * per workspace, see /api/walkthrough); every change is broadcast as a window
 * event so the tour host on the page picks it up at once.
 */

import { gateFor } from "@/modules/auth/gate";

export type WalkthroughProgress = {
  status: "not_started" | "active" | "dismissed" | "done";
  step: number;
  updated_at: string | null;
};

export type WalkthroughAction = "start" | "restart" | "step" | "dismiss" | "finish";

export const WALKTHROUGH_EVENT = "synapse:walkthrough";

/** Pages where the tour never shows, even with a workspace open. */
const HIDDEN_PREFIXES = ["/login", "/signin", "/auth", "/workspaces", "/select-workspace"];

/**
 * Whether the tour belongs on this page, and so whether to load its progress.
 * Progress is per person and workspace (/api/walkthrough needs both), so only
 * pages that need a selected workspace qualify: never the public pages
 * (/login and the rest of PUBLIC_PREFIXES), the workspace picker, your account
 * or the owner's /admin pages. Asking there only earns a 401 or 409.
 */
export function walkthroughApplies(pathname: string): boolean {
  if (HIDDEN_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return false;
  return gateFor(pathname) === "workspace";
}

export async function fetchWalkthrough(): Promise<WalkthroughProgress | null> {
  try {
    const res = await fetch("/api/walkthrough", { cache: "no-store" });
    if (!res.ok) return null;
    return ((await res.json()) as { progress: WalkthroughProgress }).progress;
  } catch {
    return null;
  }
}

/** Saves progress and tells the tour host. Resolves to the saved progress (or an optimistic copy offline). */
export async function updateWalkthrough(action: WalkthroughAction, step = 0): Promise<WalkthroughProgress> {
  const optimistic: WalkthroughProgress = {
    status: action === "dismiss" ? "dismissed" : action === "finish" ? "done" : "active",
    step: action === "restart" ? 0 : step,
    updated_at: new Date().toISOString(),
  };
  window.dispatchEvent(new CustomEvent<WalkthroughProgress>(WALKTHROUGH_EVENT, { detail: optimistic }));
  try {
    const res = await fetch("/api/walkthrough", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, step }),
    });
    if (res.ok) return ((await res.json()) as { progress: WalkthroughProgress }).progress;
  } catch {
    // Keep the optimistic state; the next change retries the save.
  }
  return optimistic;
}
