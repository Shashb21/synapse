import { NextResponse } from "next/server";
import "@/modules";
import { ApiGuardError, readJsonBody } from "@/modules/auth/api-guard";
import { ownerGate } from "@/modules/auth/owner";
import { recordAudit } from "@/modules/kernel/audit";
import { replaceContentsOf } from "@/modules/workspaces/contents";
import { getWorkspace, setWorkspaceDemoMode } from "@/modules/workspaces/store";
import { forgetDemoMode } from "@/lib/demo/mode";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `{ workspace_id, enabled }` turns client demo mode on or off (KAN-138). On:
 * the workspace replays the recorded demo run instead of calling a model, and
 * restarts at the walkthrough's start (setup done, no sources). Off: only the
 * flag is cleared; the contents stay. Platform owner only.
 */
export async function POST(request: Request) {
  const denied = await ownerGate();
  if (denied) return denied;
  try {
    const body = await readJsonBody(request);
    const workspaceId = typeof body.workspace_id === "string" ? body.workspace_id.trim() : "";
    if (typeof body.enabled !== "boolean") return NextResponse.json({ error: "enabled must be true or false" }, { status: 400 });
    const workspace = workspaceId ? await getWorkspace(workspaceId) : null;
    if (!workspace) return NextResponse.json({ error: "Choose a workspace." }, { status: 404 });
    if (body.enabled) {
      await setWorkspaceDemoMode(workspace.id, true);
      forgetDemoMode(workspace.id);
      await replaceContentsOf(workspace.id, "client_demo");
    } else {
      await setWorkspaceDemoMode(workspace.id, false);
      forgetDemoMode(workspace.id);
    }
    await recordAudit({
      category: "workspace",
      action: body.enabled ? "workspace.demo_mode_on" : "workspace.demo_mode_off",
      entity_type: "workspace",
      entity_id: workspace.id,
      workspace_id: workspace.id,
      before: { demo_mode: workspace.demo_mode },
      after: { demo_mode: body.enabled },
    });
    return NextResponse.json({ ok: true, workspace_id: workspace.id, demo_mode: body.enabled });
  } catch (error) {
    if (error instanceof ApiGuardError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not change demo mode." }, { status: 400 });
  }
}
