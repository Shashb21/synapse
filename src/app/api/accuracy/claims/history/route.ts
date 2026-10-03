/** Read generated item history only within an authenticated, authorized workspace. */
import { NextResponse } from "next/server";
import { ItemHistoryError, readItemHistory } from "@/accuracy/store/item-history-store";
import { getAuthorizedWorkspace } from "@/accuracy/store/tenant";
import { can } from "@/modules/auth/roles";
import { sessionContext } from "@/modules/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Return immutable origins and relationship review capability for the current session. */
export async function GET(request: Request) {
  try {
    const session = await sessionContext();
    if (!session.signed_in) return NextResponse.json({ error: "Sign in to access item history" }, { status: 401 });
    const query = new URL(request.url).searchParams;
    const workspace_id = query.get("workspace_id")?.trim() ?? "";
    const claim_id = query.get("claim_id")?.trim() ?? "";
    if (!workspace_id || !claim_id || query.getAll("workspace_id").length !== 1 || query.getAll("claim_id").length !== 1
      || [...query.keys()].some(key => key !== "workspace_id" && key !== "claim_id")) {
      return NextResponse.json({ error: "Supply one workspace_id and one claim_id" }, { status: 400 });
    }
    if (!session.session || !await getAuthorizedWorkspace({ workspace_id, subject: session.session.subject, role: session.role })) {
      return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
    }
    const history = await readItemHistory(workspace_id, claim_id);
    if (!history) return NextResponse.json({ error: "Item history not found" }, { status: 404 });
    return NextResponse.json({ history, can_decide: can(session.role, "validate") });
  } catch (error) {
    if (error instanceof ItemHistoryError) {
      const status = { invalid_input: 400, not_found: 404, conflict: 409 }[error.code];
      return NextResponse.json({ error: status === 404 ? "Item history not found" : status === 409 ? "Item history conflict" : "Invalid item history request" }, { status });
    }
    console.error("Could not read item history", error);
    return NextResponse.json({ error: "Could not read item history" }, { status: 500 });
  }
}
