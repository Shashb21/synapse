/** Authenticated contributor proposals and atomic decisions for generated item identities. */
import { NextResponse } from "next/server";
import { z } from "zod";
import { ItemHistoryError, decideItemRelationship, proposeItemRelationship } from "@/accuracy/store/item-history-store";
import { getAuthorizedWorkspace } from "@/accuracy/store/tenant";
import { can } from "@/modules/auth/roles";
import { sessionContext } from "@/modules/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const id = z.string().trim().min(1);
const ids = z.array(id).min(1).refine(values => new Set(values).size === values.length, "Claim IDs must be distinct");
const common = { workspace_id: id, rationale: z.string().trim().min(3) };
const relationshipRequest = z.union([
  z.object({ ...common, action: z.literal("propose"), kind: z.enum(["same_item", "split", "merge"]),
    predecessor_ids: ids, successor_ids: ids }).strict(),
  z.object({ ...common, action: z.enum(["confirm", "reject"]), proposal_id: id }).strict(),
]);

/** Validate strict client fields, resolve workspace access, and attach the server actor. */
export async function POST(request: Request) {
  try {
    const session = await sessionContext();
    if (!session.signed_in) return NextResponse.json({ error: "Sign in to review item relationships" }, { status: 401 });
    if (!can(session.role, "validate")) return NextResponse.json({ error: "You do not have validation capability" }, { status: 403 });
    let raw: unknown;
    try { raw = await request.json(); }
    catch (error) {
      if (error instanceof SyntaxError) return NextResponse.json({ error: "Invalid relationship request" }, { status: 400 });
      throw error;
    }
    const parsed = relationshipRequest.safeParse(raw);
    if (!parsed.success) return NextResponse.json({ error: "Invalid relationship request" }, { status: 400 });
    const body = parsed.data;
    if (!session.session || !await getAuthorizedWorkspace({ workspace_id: body.workspace_id, subject: session.session.subject, role: session.role })) {
      return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
    }
    if (body.action === "propose") {
      const proposal = await proposeItemRelationship({ ...body, actor: session.actor });
      return NextResponse.json({ proposal }, { status: 201 });
    }
    const histories = await decideItemRelationship({ ...body, actor: session.actor });
    return NextResponse.json({ histories });
  } catch (error) {
    if (error instanceof ItemHistoryError) {
      const status = { invalid_input: 400, not_found: 404, conflict: 409 }[error.code];
      return NextResponse.json({ error: status === 404 ? "Relationship item or proposal not found" : status === 409 ? "Relationship decision conflicts with current history" : "Invalid relationship request" }, { status });
    }
    console.error("Could not review item relationship", error);
    return NextResponse.json({ error: "Could not review item relationship" }, { status: 500 });
  }
}
