import { NextResponse } from "next/server";
import { inviteMember, listMembers, removeMember } from "@/modules/workspaces/store";
import { errorResponse, HttpError, readBody, requireMembership } from "../../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Context) {
  try {
    const { id } = await params;
    await requireMembership(id);
    return NextResponse.json({ members: await listMembers(id) });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Invites someone by email (any member may invite); they see the workspace when they sign in. */
export async function POST(request: Request, { params }: Context) {
  try {
    const { id } = await params;
    const { principal } = await requireMembership(id);
    const body = await readBody(request);
    await inviteMember({ workspace_id: id, email: String(body.email ?? ""), by: principal });
    return NextResponse.json({ ok: true, members: await listMembers(id) }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Removes a member (owner only). The person is named by `principal` in the body or the query. */
export async function DELETE(request: Request, { params }: Context) {
  try {
    const { id } = await params;
    const { principal } = await requireMembership(id);
    const body = await readBody(request);
    const target = String(body.principal ?? new URL(request.url).searchParams.get("principal") ?? "").trim();
    if (!target) throw new HttpError(400, "Say who to remove.");
    await removeMember({ workspace_id: id, principal: target, by: principal });
    return NextResponse.json({ ok: true, members: await listMembers(id) });
  } catch (error) {
    return errorResponse(error);
  }
}
