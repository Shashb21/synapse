import "@/modules";
import { redirect } from "next/navigation";
import { loadWorkspaceTag } from "@/components/workspaces/workspace-tag-data";
import { selectedWorkspaceId } from "@/modules/workspaces/context";
import { getWorkspace } from "@/modules/workspaces/store";

/** Scopes the same-browser presenter ↔ audience channel to this workspace. */
export async function roomWorkspace(): Promise<{ key: string; name: string | null }> {
  const id = await selectedWorkspaceId().catch(() => null);
  if (!id) return { key: "default", name: null };
  const workspace = await getWorkspace(id).catch(() => null);
  return { key: id, name: workspace?.name ?? null };
}

/**
 * The page check every app shell makes (KAN-18): the proxy only sees that the
 * cookies exist, so the Room verifies the session and workspace itself before
 * it reads any plan data.
 */
export async function requireRoomAccess(next: string): Promise<void> {
  const workspace = await loadWorkspaceTag();
  if (workspace.state === "signed_out") redirect(`/login?next=${encodeURIComponent(next)}`);
  if (workspace.state !== "ready") redirect(`/workspaces?next=${encodeURIComponent(next)}`);
}
