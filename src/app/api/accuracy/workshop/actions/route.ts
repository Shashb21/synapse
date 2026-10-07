import { getWorkspaceOrgId } from "@/accuracy/store/tenant";
import { AccuracyPausedError, assertAccuracyCanProgress } from "@/accuracy/kernel/omission-pause";
import { NextResponse } from "next/server";
import { z } from "zod";
import { registerAccuracyStack } from "@/accuracy";
import { parseWorkshopActionKind } from "@/accuracy/modules/workshop/actions";
import { applyWorkshopAction } from "@/accuracy/store/workshop-store";
import type { ActorFunction } from "@/lib/iegp/enums";
import { AssemblyReviewError } from "@/accuracy/domain/assembly-review";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

registerAccuracyStack();

const bodySchema = z.object({
  workspace_id: z.string().min(1),
  snapshot_id: z.string().min(1),
  kind: z.string().min(1),
  gap_id: z.string().min(1),
  rationale: z.string(),
  tactic_id: z.string().optional(),
  overall: z.enum(["covers", "partial", "none", "unknown"]).optional(),
  priority: z.enum(["high", "medium", "low"]).optional(),
  actor_name: z.string().min(1).optional(),
  actor_function: z.string().min(1).optional(),
});

export async function POST(request: Request) {
  try {
    const body = bodySchema.parse(await request.json());
    const org_id = await getWorkspaceOrgId(body.workspace_id);
    if (!org_id) return NextResponse.json({ error: "Unknown workspace_id" }, { status: 404 });
    await assertAccuracyCanProgress(body.workspace_id, "prioritize");
    const snapshot = await applyWorkshopAction({
      workspace_id: body.workspace_id,
      snapshot_id: body.snapshot_id,
      actor: {
        name: body.actor_name?.trim() || "Workshop facilitator",
        function: (body.actor_function?.trim() || "medical_affairs") as ActorFunction,
      },
      action: {
        kind: parseWorkshopActionKind(body.kind),
        gap_id: body.gap_id,
        rationale: body.rationale,
        tactic_id: body.tactic_id,
        overall: body.overall,
        priority: body.priority,
      },
    });
    return NextResponse.json({ ok: true, snapshot });
  } catch (error) {
    if (error instanceof AccuracyPausedError) {
      return NextResponse.json({ ok: false, error: error.message, blockers: error.blockers }, { status: 409 });
    }
    if (error instanceof AssemblyReviewError) return NextResponse.json({ ok: false, code: error.code, error: error.message }, { status: error.code === "invalid_input" ? 400 : error.code === "not_found" ? 404 : error.code === "forbidden" ? 403 : 409 });
    const message = error instanceof Error ? error.message : "Workshop action failed";
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
