import { getWorkspaceOrgId } from "@/accuracy/store/tenant";
import { AccuracyPausedError, assertAccuracyCanProgress } from "@/accuracy/kernel/omission-pause";
import { NextResponse } from "next/server";
import { registerAccuracyStack } from "@/accuracy";
import {
  auditBundleFromPlan,
  projectWorkspaceGantt,
  snapshotHashForPlan,
  workspaceLatestPlan,
} from "@/accuracy/modules/gantt-project/save-final";
import { AssemblyReviewError } from "@/accuracy/domain/assembly-review";

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
    const org_id = await getWorkspaceOrgId(workspace_id);
    if (!org_id) return NextResponse.json({ error: "Unknown workspace" }, { status: 404 });
    await assertAccuracyCanProgress(workspace_id, "gantt_project");
    const [projection, plan] = await Promise.all([
      projectWorkspaceGantt(workspace_id),
      workspaceLatestPlan(workspace_id),
    ]);
    return NextResponse.json({
      ...projection,
      plan,
      snapshot_hash: plan ? snapshotHashForPlan(plan) : null,
      audit_bundle: plan ? auditBundleFromPlan(plan) : null,
    });
  } catch (error) {
    if (error instanceof AccuracyPausedError) {
      return NextResponse.json({ ok: false, error: error.message, blockers: error.blockers }, { status: 409 });
    }
    if (error instanceof AssemblyReviewError) return NextResponse.json({ ok: false, code: error.code, error: error.message }, { status: error.code === "invalid_input" ? 400 : error.code === "not_found" ? 404 : error.code === "forbidden" ? 403 : 409 });
    const message = error instanceof Error ? error.message : "Gantt projection failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
