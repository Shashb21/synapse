import { ownerGate } from "@/modules/auth/owner";
/** Authenticated, workspace-scoped API for one agent run's recorded progression. */
import { NextResponse } from "next/server";
import { readAgentProgression, registerAccuracyStack } from "@/accuracy";
import { sessionContext } from "@/modules/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

registerAccuracyStack();

/** Return exact snapshots and linked observations for one run. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ run_id: string }> },
) {
  const session = await sessionContext();
  if (!session.signed_in) {
    return NextResponse.json({ error: "Sign in to inspect run progression" }, { status: 401 });
  }

  const denied = await ownerGate();
  if (denied) return denied;
  const { run_id } = await params;
  const workspace_id = new URL(request.url).searchParams.get("workspace_id")?.trim() ?? "";
  if (!workspace_id || !run_id?.trim()) {
    return NextResponse.json({ error: "workspace_id and run_id are required" }, { status: 400 });
  }

  try {
    const progression = await readAgentProgression({ run_id: run_id.trim(), workspace_id });
    if (!progression) {
      return NextResponse.json({ error: "Run not found in workspace" }, { status: 404 });
    }
    return NextResponse.json({ progression });
  } catch {
    return NextResponse.json({ error: "Could not load run progression" }, { status: 500 });
  }
}
