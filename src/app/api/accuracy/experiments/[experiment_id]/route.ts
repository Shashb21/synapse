/** Authenticated source-workspace-scoped API for one isolated experiment record. */
import { NextResponse } from "next/server";
import { registerAccuracyStack } from "@/accuracy";
import { getExperimentForSourceWorkspace } from "@/accuracy/experiments/records";
import { getAuthorizedWorkspace } from "@/accuracy/store/tenant";
import { sessionContext } from "@/modules/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

registerAccuracyStack();

/** Return every persisted call and evaluation for one source-workspace-scoped experiment. */
export async function GET(request: Request, { params }: { params: Promise<{ experiment_id: string }> }) {
  const session = await sessionContext();
  if (!session.signed_in) return NextResponse.json({ error: "Sign in to access experiments" }, { status: 401 });
  const source_workspace_id = new URL(request.url).searchParams.get("source_workspace_id")?.trim() ?? "";
  const { experiment_id } = await params;
  if (!source_workspace_id || !experiment_id.trim()) {
    return NextResponse.json({ error: "source_workspace_id and experiment_id are required" }, { status: 400 });
  }
  if (!session.session || !await getAuthorizedWorkspace({ workspace_id: source_workspace_id, subject: session.session.subject, role: session.role })) {
    return NextResponse.json({ error: "Source workspace not found" }, { status: 404 });
  }
  const experiment = await getExperimentForSourceWorkspace({ source_workspace_id, experiment_id: experiment_id.trim() });
  if (!experiment) return NextResponse.json({ error: "Experiment not found in source workspace" }, { status: 404 });
  return NextResponse.json({ experiment });
}
