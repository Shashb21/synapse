/** Operator-only provisioning of access to an existing accuracy organization. */
import { NextResponse } from "next/server";
import { z } from "zod";
import { grantOrganizationAccess } from "@/accuracy/store/tenant";
import { can } from "@/modules/auth/roles";
import { sessionContext } from "@/modules/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const grantSchema = z.object({
  subject: z.string().trim().min(1).max(255),
});

/** Create a default-deny tenant grant after an operator identifies the target organization and subject. */
export async function POST(
  request: Request,
  context: { params: Promise<{ org_id: string }> },
) {
  const session = await sessionContext();
  if (!session.signed_in || !session.session) {
    return NextResponse.json({ ok: false, error: "Sign in to provision organization access" }, { status: 401 });
  }
  if (!can(session.role, "manage_organization_access")) {
    return NextResponse.json({ ok: false, error: "You do not have organization access provisioning capability" }, { status: 403 });
  }

  try {
    const { org_id } = await context.params;
    const { subject } = grantSchema.parse(await request.json());
    const granted = await grantOrganizationAccess({ subject, org_id });
    if (!granted) return NextResponse.json({ ok: false, error: "Unknown organization" }, { status: 404 });
    return NextResponse.json({ ok: true, org_id, subject }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not provision organization access";
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
