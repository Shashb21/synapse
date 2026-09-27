import { NextResponse } from "next/server";
import { apiErrorResponse, readJsonBody, requireCustomerContext } from "@/modules/auth/api-guard";
import { aiState } from "@/modules/kernel/ai-switch";
import { setWorkspaceAiEnabled, WorkspaceAiForbiddenError } from "@/modules/workspaces/ai-setting";
import { memberRole } from "@/modules/workspaces/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

function forbidden(message: string) {
  return NextResponse.json({ error: message, code: "forbidden" }, { status: 403 });
}

/** The workspace's AI assistance setting and the platform switch, for any member. */
export async function GET(_request: Request, { params }: Context) {
  try {
    const { id } = await params;
    const context = await requireCustomerContext({ workspace: false });
    const role = await memberRole(id, context.principal);
    if (!role) return forbidden("You are not a member of this workspace.");
    return NextResponse.json({ ok: true, ai: await aiState(id), role });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/**
 * Turns AI assistance on or off for this workspace only: `{ enabled }`. The
 * workspace owner only; the actor on the audit line is the signed-in person.
 */
export async function POST(request: Request, { params }: Context) {
  try {
    const { id } = await params;
    const body = await readJsonBody(request);
    const context = await requireCustomerContext({ workspace: false, body });
    if (typeof body.enabled !== "boolean") {
      return NextResponse.json({ error: "enabled must be true or false.", code: "invalid_json" }, { status: 400 });
    }
    const ai = await setWorkspaceAiEnabled({
      workspace_id: id,
      enabled: body.enabled,
      principal: context.principal,
      actor: context.actor,
    });
    return NextResponse.json({ ok: true, ai });
  } catch (error) {
    if (error instanceof WorkspaceAiForbiddenError) return forbidden(error.message);
    return apiErrorResponse(error);
  }
}
