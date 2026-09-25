import { selectedWorkspaceId } from "@/modules/workspaces/context";
import { DEFAULT_WORKSPACE_ID, getWorkspace } from "@/modules/workspaces/store";

/**
 * The workspace the owner console reads per-workspace data from (pipeline,
 * runs, evals): whichever one the owner has selected, else the Default one.
 */
export async function adminWorkspaceName(): Promise<string> {
  try {
    const id = (await selectedWorkspaceId()) ?? DEFAULT_WORKSPACE_ID;
    const workspace = await getWorkspace(id);
    return workspace?.name ?? "Default";
  } catch {
    return "Default";
  }
}
