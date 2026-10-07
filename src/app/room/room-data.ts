import "@/modules";
import { selectedWorkspaceId } from "@/modules/workspaces/context";
import { getWorkspace } from "@/modules/workspaces/store";

/** Scopes the same-browser presenter ↔ audience channel to this workspace. */
export async function roomWorkspace(): Promise<{ key: string; name: string | null }> {
  const id = await selectedWorkspaceId().catch(() => null);
  if (!id) return { key: "default", name: null };
  const workspace = await getWorkspace(id).catch(() => null);
  return { key: id, name: workspace?.name ?? null };
}
