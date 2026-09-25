import { NextResponse } from "next/server";
import { listMembers, renameWorkspace } from "@/modules/workspaces/store";
import { errorResponse, readBody, requireMembership } from "../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** One workspace and its members, for anyone who belongs to it. */
export async function GET(_request: Request, { params }: Context) {
  try {
    const { id } = await params;
    const { workspace } = await requireMembership(id);
    return NextResponse.json({
      workspace: {
        id: workspace.id,
        name: workspace.name,
        role: workspace.role,
        created_at: workspace.created_at,
        created_by: workspace.created_by,
      },
      members: await listMembers(id),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Renames the workspace (owner only). */
export async function PATCH(request: Request, { params }: Context) {
  try {
    const { id } = await params;
    const { principal } = await requireMembership(id);
    const body = await readBody(request);
    await renameWorkspace({ workspace_id: id, name: String(body.name ?? ""), by: principal });
    const { workspace } = await requireMembership(id);
    return NextResponse.json({ ok: true, workspace: { id: workspace.id, name: workspace.name, role: workspace.role } });
  } catch (error) {
    return errorResponse(error);
  }
}
