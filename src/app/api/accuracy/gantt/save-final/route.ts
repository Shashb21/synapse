import { AccuracyPausedError, assertAccuracyCanProgress } from "@/accuracy/kernel/omission-pause";
import { ownerGate } from "@/modules/auth/owner";
import { NextResponse } from "next/server";
import { z } from "zod";
import { registerAccuracyStack } from "@/accuracy";
import { saveFinalGanttPlan } from "@/accuracy/modules/gantt-project/save-final";
import {
  labActor,
  labErrorMessage,
  labRequestErrorResponse,
  parseLabBody,
  requireLabWorkspace,
} from "@/app/api/accuracy/_lib/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

registerAccuracyStack();

const bodySchema = z.object({
  workspace_id: z.string().min(1),
  note: z.string().min(1),
  status: z.enum(["draft", "final"]).optional(),
  /** Ignored: the plan is credited to the signed-in owner. */
  actor_name: z.string().optional(),
  actor_function: z.string().optional(),
});

export async function POST(request: Request) {
  const denied = await ownerGate();
  if (denied) return denied;
  try {
    const body = await parseLabBody(request, bodySchema);
    await requireLabWorkspace(body.workspace_id);
    await assertAccuracyCanProgress(body.workspace_id, "gantt_project");
    const result = await saveFinalGanttPlan({
      workspace_id: body.workspace_id,
      status: body.status ?? "final",
      note: body.note,
      actor: await labActor(),
    });
    return NextResponse.json({
      ok: true,
      plan: result.plan,
      activities: result.activities,
      snapshot_hash: result.snapshot_hash,
      audit_bundle: result.audit_bundle,
    });
  } catch (error) {
    if (error instanceof AccuracyPausedError) {
      return NextResponse.json({ ok: false, error: error.message, blockers: error.blockers }, { status: 409 });
    }
    const known = labRequestErrorResponse(error);
    if (known) return known;
    const message = labErrorMessage(error, "Save final failed");
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
