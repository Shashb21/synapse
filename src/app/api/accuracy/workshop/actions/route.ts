import { ownerGate } from "@/modules/auth/owner";
import { NextResponse } from "next/server";
import { z } from "zod";
import { registerAccuracyStack } from "@/accuracy";
import { parseWorkshopActionKind } from "@/accuracy/modules/workshop/actions";
import { applyWorkshopAction } from "@/accuracy/store/workshop-store";
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
  snapshot_id: z.string().min(1),
  kind: z.string().min(1),
  gap_id: z.string().min(1),
  rationale: z.string(),
  tactic_id: z.string().optional(),
  overall: z.enum(["covers", "partial", "none", "unknown"]).optional(),
  priority: z.enum(["high", "medium", "low"]).optional(),
  /** Ignored: the action is credited to the signed-in owner. */
  actor_name: z.string().optional(),
  actor_function: z.string().optional(),
});

export async function POST(request: Request) {
  const denied = await ownerGate();
  if (denied) return denied;
  try {
    const body = await parseLabBody(request, bodySchema);
    await requireLabWorkspace(body.workspace_id);
    const snapshot = await applyWorkshopAction({
      workspace_id: body.workspace_id,
      snapshot_id: body.snapshot_id,
      actor: await labActor(),
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
    const known = labRequestErrorResponse(error);
    if (known) return known;
    const message = labErrorMessage(error, "Workshop action failed");
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
