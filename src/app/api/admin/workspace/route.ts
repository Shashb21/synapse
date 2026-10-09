import { NextResponse } from "next/server";
import { ApiGuardError, readJsonBody } from "@/modules/auth/api-guard";
import { ownerGate, ownerOnlyJson } from "@/modules/auth/owner";
import {
  adminReturnPath,
  adminWorkspace,
  clearAdminWorkspace,
  NotOwnerError,
  selectAdminWorkspace,
  UnknownWorkspaceError,
} from "@/modules/workspaces/admin-context";
import { listAllWorkspaces } from "@/modules/workspaces/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };

function failure(error: unknown): NextResponse {
  if (error instanceof NotOwnerError) return ownerOnlyJson();
  if (error instanceof UnknownWorkspaceError) return NextResponse.json({ error: error.message }, { status: 404 });
  if (error instanceof ApiGuardError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  const message = error instanceof Error ? error.message : "Workspace request failed.";
  return NextResponse.json({ error: message }, { status: 400 });
}

/** Every customer workspace and the console's current one. Owner only (KAN-62). */
export async function GET() {
  const denied = await ownerGate();
  if (denied) return denied;
  try {
    const [current, workspaces] = await Promise.all([adminWorkspace(), listAllWorkspaces()]);
    return NextResponse.json(
      {
        current: { id: current.id, name: current.name, source: current.source },
        workspaces: workspaces.map(({ id, name, created_by, created_at, demo, member_count }) => ({
          id,
          name,
          created_by,
          created_at,
          demo,
          member_count,
        })),
      },
      { headers: NO_STORE },
    );
  } catch (error) {
    return failure(error);
  }
}

/** `{ workspace_id, next }` makes it the console's working workspace and says where to go back to. Owner only. */
export async function POST(request: Request) {
  const denied = await ownerGate();
  if (denied) return denied;
  try {
    const body = await readJsonBody(request, { allowEmpty: true });
    const workspaceId = typeof body.workspace_id === "string" ? body.workspace_id.trim() : "";
    if (!workspaceId) return NextResponse.json({ error: "Choose a workspace." }, { status: 400 });
    const workspace = await selectAdminWorkspace(workspaceId);
    return NextResponse.json({
      ok: true,
      workspace: { id: workspace.id, name: workspace.name },
      redirect: adminReturnPath(typeof body.next === "string" ? body.next : null),
    });
  } catch (error) {
    return failure(error);
  }
}

/** Forgets the console's pick (back to the app selection, else Default). Owner only. */
export async function DELETE() {
  const denied = await ownerGate();
  if (denied) return denied;
  try {
    await clearAdminWorkspace();
    return NextResponse.json({ ok: true });
  } catch (error) {
    return failure(error);
  }
}
