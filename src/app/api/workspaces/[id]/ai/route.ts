import { NextResponse } from "next/server";
import { apiErrorResponse, requireCustomerContext } from "@/modules/auth/api-guard";
import { aiState } from "@/modules/kernel/ai-switch";
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
 * Customers no longer switch AI (owner, KAN-53): the Synapse admin turns each AI section on
 * or off for every customer in /admin/control. This endpoint refuses every change.
 */
export async function POST() {
  return forbidden("AI is managed by your Synapse administrator.");
}
