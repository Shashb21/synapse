import { appendAudit } from "@/lib/iegp/store";
import { aiState, type AiState } from "@/modules/kernel/ai-switch";
import type { Actor } from "@/modules/kernel/contracts";
import { runInWorkspace } from "./context";
import { getWorkspace, memberRole, setWorkspaceAiColumn } from "./store";

/**
 * A workspace's "AI assistance" setting. Only its owner changes it, and the
 * change is audited in that workspace. It never reaches another workspace, and
 * the platform master switch (/admin/control) still overrides it.
 */

/** The audit entity and actions a change files (the workspace's own audit table). */
export const WORKSPACE_AI_AUDIT = { entity_type: "workspace", on: "ai_enabled", off: "ai_disabled" } as const;

export class WorkspaceAiForbiddenError extends Error {
  constructor(message = "Only the workspace owner can turn AI assistance on or off.") {
    super(message);
    this.name = "WorkspaceAiForbiddenError";
  }
}

export async function setWorkspaceAiEnabled(args: {
  workspace_id: string;
  enabled: boolean;
  /** Who is asking, for the owner check (email or provider subject). */
  principal: string;
  /** The signed-in person, recorded on the audit line. */
  actor: Actor;
}): Promise<AiState> {
  const [workspace, role] = await Promise.all([getWorkspace(args.workspace_id), memberRole(args.workspace_id, args.principal)]);
  if (!workspace || !role) throw new WorkspaceAiForbiddenError("You are not a member of this workspace.");
  if (role !== "owner") throw new WorkspaceAiForbiddenError();
  const changed = workspace.ai_enabled !== args.enabled;
  await setWorkspaceAiColumn(workspace.id, args.enabled);
  if (changed) {
    await runInWorkspace({ workspace_id: workspace.id, schema: workspace.schema_name }, () =>
      appendAudit(
        args.actor.name,
        args.actor.function,
        WORKSPACE_AI_AUDIT.entity_type,
        workspace.id,
        args.enabled ? WORKSPACE_AI_AUDIT.on : WORKSPACE_AI_AUDIT.off,
        args.enabled ? "AI assistance turned on for this workspace." : "AI assistance turned off for this workspace.",
      ),
    );
  }
  return aiState(workspace.id);
}
