import { currentSchemaName, withWorkspaceTransaction } from "@/lib/iegp/db";
import { replaceWorkspaceContents, type WorkspaceContents } from "@/lib/iegp/store";
import { resetWorkspaceModules } from "@/modules/kernel/db";
import { loadDemoPlan } from "./demo-plan";
import { getWorkspace, setWorkspaceDemo, withWorkspace } from "./store";

/**
 * Replaces everything in the current workspace's schema (IEGP rows and the
 * module tables: runs, placements, room, …) with `contents`, then records on
 * the shared workspaces row whether it now holds demo data. This is the one
 * path behind the /api/iegp "reset" and "load_demo" actions and the
 * "Start with demo data" choice when creating a workspace.
 */
export async function replaceContents(workspaceId: string | null, contents: WorkspaceContents): Promise<void> {
  // All or nothing (KAN-15): a failure part-way leaves the workspace as it was.
  await withWorkspaceTransaction(async () => {
    await replaceWorkspaceContents(contents);
    await resetWorkspaceModules();
    // The full demo also opens prioritized, with a dated timeline to try.
    if (contents === "demo") await loadDemoPlan(workspaceId ?? undefined);
  });
  if (workspaceId) await setWorkspaceDemo(workspaceId, contents !== "blank");
}

/** Same, for a workspace that is not the one this request is scoped to (e.g. one just created). */
export async function replaceContentsOf(workspaceId: string, contents: WorkspaceContents): Promise<void> {
  const workspace = await getWorkspace(workspaceId);
  if (!workspace) throw new Error(`Unknown workspace ${workspaceId}`);
  await withWorkspace(workspaceId, async () => {
    // This wipes a schema: refuse if the query scope did not take (never touch another workspace).
    const schema = await currentSchemaName();
    if (schema !== workspace.schema_name) {
      throw new Error(`Refusing to replace contents: queries resolve to ${schema}, not ${workspace.schema_name}.`);
    }
    await replaceContents(workspaceId, contents);
  });
}

/** Parses the create form's / API's `start` choice. Anything but "demo" starts blank. */
export function startChoice(value: unknown): "blank" | "demo" {
  return value === "demo" ? "demo" : "blank";
}
