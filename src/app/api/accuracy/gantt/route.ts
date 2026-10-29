import { ownerGate } from "@/modules/auth/owner";
import { NextResponse } from "next/server";
import { registerAccuracyStack } from "@/accuracy";
import {
  readWorkspaceGantt,
} from "@/accuracy/modules/gantt-project/save-final";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

registerAccuracyStack();

export async function GET(request: Request) {
  const denied = await ownerGate();
  if (denied) return denied;
  const { searchParams } = new URL(request.url);
  const workspace_id = searchParams.get("workspace_id")?.trim() ?? "";
  if (!workspace_id) {
    return NextResponse.json({ error: "workspace_id is required" }, { status: 400 });
  }
  try {
    return NextResponse.json(await readWorkspaceGantt(workspace_id));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Gantt projection failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
