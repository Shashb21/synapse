import type { ActorFunction } from "@/lib/iegp/enums";
import { currentSchemaName } from "@/lib/iegp/db";
import { loadState, replaceWorkspaceContents, type WorkspaceContents } from "@/lib/iegp/store";
import type { IegpState } from "@/lib/iegp/types";
import { resetWorkspaceModules } from "@/modules/kernel/db";
import { recordAudit } from "@/modules/kernel/audit";
import { loadDemoPlan } from "./demo-plan";
import { getWorkspace, setWorkspaceDemo, withWorkspace } from "./store";

/** What the audit log keeps of a workspace's contents: counts, never the contents. */
function contentCounts(state: IegpState) {
  return {
    asset: state.asset.name || null,
    objectives: state.objectives.length,
    sources: state.sources.length,
    needs: state.needs.length,
    gaps: state.gaps.length,
    tactics: state.tactics.length,
    coverages: state.coverages.length,
    audit_entries: state.audit.length,
    gap_versions: state.gap_versions.length,
  };
}

const RESET_ACTIONS: Record<WorkspaceContents, string> = {
  blank: "workspace.reset_blank",
  demo: "workspace.load_demo",
  demo_setup: "workspace.load_demo_setup",
};

/**
 * Replaces everything in the current workspace's schema (IEGP rows and the
 * module tables: runs, placements, room, …) with `contents`, then records on
 * the shared workspaces row whether it now holds demo data. This is the one
 * path behind the /api/iegp "reset" and "load_demo" actions and the
 * "Start with demo data" choice when creating a workspace.
 *
 * The workspace's own audit and gap version history survive (KAN-89); the
 * reset is recorded there and in the platform audit log, with counts of what
 * the workspace held before and after.
 */
export async function replaceContents(
  workspaceId: string | null,
  contents: WorkspaceContents,
  actor?: { name: string; function: ActorFunction },
): Promise<void> {
  const before = contentCounts(await loadState());
  await replaceWorkspaceContents(contents, actor);
  await resetWorkspaceModules();
  // The full demo also opens prioritized, with a dated timeline to try.
  if (contents === "demo") await loadDemoPlan(workspaceId ?? undefined);
  if (workspaceId) await setWorkspaceDemo(workspaceId, contents !== "blank");
  await recordAudit({
    category: "workspace",
    action: RESET_ACTIONS[contents],
    entity_type: "workspace",
    entity_id: workspaceId,
    workspace_id: workspaceId,
    before,
    after: contentCounts(await loadState()),
  });
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
