import { NextResponse } from "next/server";
import { safeNext } from "@/modules/auth/redirect";
import { selectWorkspace } from "@/modules/workspaces/session";
import { errorResponse, HttpError, readBody, requireMembership } from "../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Opens a workspace for this session (membership-checked) and says where to go next. */
export async function POST(request: Request) {
  try {
    const body = await readBody(request);
    const workspaceId = String(body.workspace_id ?? "");
    if (!workspaceId) throw new HttpError(400, "Choose a workspace.");
    await requireMembership(workspaceId);
    const workspace = await selectWorkspace(workspaceId);
    return NextResponse.json({
      ok: true,
      workspace: { id: workspace.id, name: workspace.name, role: workspace.role },
      redirect: safeNext(typeof body.next === "string" ? body.next : null),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
