import { NextResponse } from "next/server";
import { registerAccuracyStack } from "@/accuracy";
import { projectWorkspaceGantt, workspaceLatestPlan } from "@/accuracy/modules/gantt-project/save-final";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

registerAccuracyStack();

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const workspace_id = searchParams.get("workspace_id")?.trim() ?? "";
  if (!workspace_id) {
    return NextResponse.json({ error: "workspace_id is required" }, { status: 400 });
  }
  try {
    const [projection, plan] = await Promise.all([
      projectWorkspaceGantt(workspace_id),
      workspaceLatestPlan(workspace_id),
    ]);
    return NextResponse.json({ ...projection, plan });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Gantt projection failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
