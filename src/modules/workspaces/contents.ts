import { replaceWorkspaceContents, type WorkspaceContents } from "@/lib/iegp/store";
import { resetWorkspaceModules } from "@/modules/kernel/db";
import { setWorkspaceDemo, withWorkspace } from "./store";

/**
 * Replaces everything in the current workspace's schema (IEGP rows and the
 * module tables: runs, placements, room, …) with `contents`, then records on
 * the shared workspaces row whether it now holds demo data. This is the one
 * path behind the /api/iegp "reset" and "load_demo" actions and the
 * "Start with demo data" choice when creating a workspace.
 */
export async function replaceContents(workspaceId: string | null, contents: WorkspaceContents): Promise<void> {
  await replaceWorkspaceContents(contents);
  await resetWorkspaceModules();
  if (workspaceId) await setWorkspaceDemo(workspaceId, contents !== "blank");
}

/** Same, for a workspace that is not the one this request is scoped to (e.g. one just created). */
export function replaceContentsOf(workspaceId: string, contents: WorkspaceContents): Promise<void> {
  return withWorkspace(workspaceId, () => replaceContents(workspaceId, contents));
}

/** Parses the create form's / API's `start` choice. Anything but "demo" starts blank. */
export function startChoice(value: unknown): "blank" | "demo" {
  return value === "demo" ? "demo" : "blank";
}
