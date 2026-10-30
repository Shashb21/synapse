import { customerErrorMessage } from "@/modules/kernel/stage-errors";
import { ownerGate } from "@/modules/auth/owner";
import { NextResponse } from "next/server";
import { z } from "zod";
import { registerAccuracyStack } from "@/accuracy";
import { CLAIM_PRIORITIES, updateClaim } from "@/accuracy/store/claim-edit";
import { actorFieldsSchema } from "@/accuracy/store/claim-patch-schema";
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
  workspace_id: z.string(),
  claim_id: z.string(),
  priority: z.enum(CLAIM_PRIORITIES),
  /** User-typed reason (min 3 chars) — never auto-generated. */
  rationale: z.string().trim().min(3, "A short rationale is required for a priority change."),
  ...actorFieldsSchema,
});

export async function POST(req: Request) {
  const denied = await ownerGate();
  if (denied) return denied;
  try {
    const body = await parseLabBody(req, bodySchema);
    await requireLabWorkspace(body.workspace_id);
    const actor = await labActor();
    try {
      const result = await updateClaim({
        workspace_id: body.workspace_id,
        claim_id: body.claim_id,
        patch: { priority: body.priority },
        rationale: body.rationale,
        actor,
      });
      return NextResponse.json({ ok: true, changed: result.changed });
    } catch (error) {
      const message = customerErrorMessage(error);
      if (message === "No changes to save.") {
        return NextResponse.json({ ok: true, changed: [] });
      }
      throw error;
    }
  } catch (error) {
    const known = labRequestErrorResponse(error);
    if (known) return known;
    const message = labErrorMessage(error, "We couldn’t confirm the priority update. Check the claim’s current priority before saving it again.");
    return NextResponse.json({ ok: false, safe_error: true, error: message }, { status: 400 });
  }
}
