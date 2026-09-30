import { AccuracyPausedError, assertAccuracyCanProgress } from "@/accuracy/kernel/omission-pause";
import { NextResponse } from "next/server";
import { z } from "zod";
import { registerAccuracyStack } from "@/accuracy";
import { saveFinalGanttPlan } from "@/accuracy/modules/gantt-project/save-final";
import { getWorkspaceOrgId } from "@/accuracy/store/tenant";
import type { ActorFunction } from "@/lib/iegp/enums";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

registerAccuracyStack();

const bodySchema = z.object({
  workspace_id: z.string().min(1),
  note: z.string().min(1),
  status: z.enum(["draft", "final"]).optional(),
  actor_name: z.string().min(1).optional(),
  actor_function: z.string().min(1).optional(),
});

export async function POST(request: Request) {
  try {
    const body = bodySchema.parse(await request.json());
    const org_id = await getWorkspaceOrgId(body.workspace_id);
    if (!org_id) {
      return NextResponse.json({ error: "Unknown workspace_id" }, { status: 404 });
    }
    await assertAccuracyCanProgress(body.workspace_id, "gantt_project");
    const result = await saveFinalGanttPlan({
      workspace_id: body.workspace_id,
      status: body.status ?? "final",
      note: body.note,
      actor: {
        name: body.actor_name?.trim() || "Accuracy reviewer",
        function: (body.actor_function?.trim() || "medical_affairs") as ActorFunction,
      },
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
    const message = error instanceof Error ? error.message : "Save final failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
