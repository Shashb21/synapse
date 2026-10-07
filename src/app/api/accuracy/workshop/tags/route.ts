import { AccuracyPausedError, assertAccuracyCanProgress } from "@/accuracy/kernel/omission-pause";
import { ownerGate } from "@/modules/auth/owner";
import { NextResponse } from "next/server";
import { z } from "zod";
import { registerAccuracyStack } from "@/accuracy";
import { addFacilitatorTag, assignFacilitatorTag } from "@/accuracy/store/workshop-store";
import {
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
  action: z.enum(["add_tag", "assign"]),
  label: z.string().optional(),
  gap_id: z.string().optional(),
  tag_id: z.string().optional(),
});

export async function POST(request: Request) {
  const denied = await ownerGate();
  if (denied) return denied;
  try {
    const body = await parseLabBody(request, bodySchema);
    await requireLabWorkspace(body.workspace_id);
    await assertAccuracyCanProgress(body.workspace_id, "prioritize");
    if (body.action === "add_tag") {
      const snapshot = await addFacilitatorTag({
        workspace_id: body.workspace_id,
        snapshot_id: body.snapshot_id,
        label: body.label ?? "",
      });
      return NextResponse.json({ ok: true, snapshot });
    }
    const snapshot = await assignFacilitatorTag({
      workspace_id: body.workspace_id,
      snapshot_id: body.snapshot_id,
      gap_id: body.gap_id ?? "",
      tag_id: body.tag_id ?? "",
    });
    return NextResponse.json({ ok: true, snapshot });
  } catch (error) {
    if (error instanceof AccuracyPausedError) {
      return NextResponse.json({ ok: false, error: error.message, blockers: error.blockers }, { status: 409 });
    }
    const known = labRequestErrorResponse(error);
    if (known) return known;
    const message = labErrorMessage(error, "Could not update facilitator tags");
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
