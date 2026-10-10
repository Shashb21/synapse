import { NextResponse } from "next/server";
import "@/modules";
import { ownerGate } from "@/modules/auth/owner";
import { withAdminWorkspace } from "@/modules/workspaces/admin-context";
import { findGapOrphans } from "@/lib/iegp/gap-record";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Rows in the console's workspace that point at a retired or missing gap when
 * they should follow a live one (KAN-97). Owner only. A healthy plan has none.
 */
export async function GET(request: Request) {
  const denied = await ownerGate();
  if (denied) return denied;
  try {
    const workspaceId = new URL(request.url).searchParams.get("workspace_id");
    return await withAdminWorkspace(async (workspace) => {
      const orphans = await findGapOrphans();
      return NextResponse.json(
        { workspace_id: workspace.id, count: orphans.length, orphans },
        { headers: { "cache-control": "no-store" } },
      );
    }, workspaceId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not check the plan.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
