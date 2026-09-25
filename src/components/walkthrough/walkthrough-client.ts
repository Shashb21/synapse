"use client";

/**
 * Browser side of the walkthrough: progress lives on the server (per person,
 * per workspace, see /api/walkthrough); every change is broadcast as a window
 * event so the tour host on the page picks it up at once.
 */

export type WalkthroughProgress = {
  status: "not_started" | "active" | "dismissed" | "done";
  step: number;
  updated_at: string | null;
};

export type WalkthroughAction = "start" | "restart" | "step" | "dismiss" | "finish";

export const WALKTHROUGH_EVENT = "synapse:walkthrough";

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
