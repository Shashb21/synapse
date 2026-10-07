import { adminWorkspace } from "@/modules/workspaces/admin-context";

/**
 * The workspace the owner console reads per-workspace data from (pipeline,
 * runs, evals): the one picked at /admin/workspace, else the owner's own app
 * selection, else the Default one (modules/workspaces/admin-context.ts).
 */
export async function adminWorkspaceName(): Promise<string> {
  try {
    return (await adminWorkspace()).name;
  } catch {
    return "Default";
  }
}
