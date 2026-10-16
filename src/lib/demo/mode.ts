import { scopedWorkspaceId } from "@/modules/workspaces/context";
import { getWorkspace } from "@/modules/workspaces/store";

/**
 * Client demo mode (KAN-138). A workspace an admin has put in demo mode
 * replays the recorded demo run for every AI step instead of calling a model.
 */

const TTL_MS = 5_000;
const cache = new Map<string, { at: number; on: boolean }>();

/** Whether this workspace (default: the one the current query is scoped to) is in client demo mode. */
export async function isDemoModeWorkspace(workspaceId?: string | null): Promise<boolean> {
  const id = workspaceId ?? (await scopedWorkspaceId().catch(() => null));
  if (!id) return false;
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.on;
  const on = (await getWorkspace(id).catch(() => null))?.demo_mode === true;
  cache.set(id, { at: Date.now(), on });
  return on;
}

/** Forgets cached demo-mode flags (after the admin switch, and in tests). */
export function forgetDemoMode(workspaceId?: string): void {
  if (workspaceId) cache.delete(workspaceId);
  else cache.clear();
}

/**
 * Recording run: a demo-mode workspace calls the real model so its calls can be
 * exported as the recording (scripts/export-demo-recording.ts). Never in production.
 */
export function isRecordingDemo(): boolean {
  return process.env.SYNAPSE_DEMO_RECORD === "1" && process.env.NODE_ENV !== "production";
}

/** True when this workspace's AI steps are served from the recording. */
export async function replaysDemo(workspaceId?: string | null): Promise<boolean> {
  return !isRecordingDemo() && (await isDemoModeWorkspace(workspaceId));
}
