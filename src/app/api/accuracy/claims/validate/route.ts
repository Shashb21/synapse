import { ownerGate } from "@/modules/auth/owner";
import { NextResponse } from "next/server";
import { z } from "zod";
import { registerAccuracyStack, runAccuracyModule } from "@/accuracy";
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
  claim_ids: z.array(z.string().min(1)).min(1),
  action: z.enum(["validate", "reject"]),
  rationale: z.string().min(1),
  /** Ignored: the decision is credited to the signed-in owner. */
  actor_name: z.string().optional(),
  actor_function: z.string().optional(),
});

export async function POST(request: Request) {
  const denied = await ownerGate();
  if (denied) return denied;
  try {
    const body = await parseLabBody(request, bodySchema);
    const { org_id } = await requireLabWorkspace(body.workspace_id);
    const result = await runAccuracyModule({
      call_kind: "validation_gate",
      agent_role: "none",
      input: {
        workspace_id: body.workspace_id,
        claim_ids: body.claim_ids,
        action: body.action,
        rationale: body.rationale,
      },
      actor: await labActor(),
      org_id,
      workspace_id: body.workspace_id,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const known = labRequestErrorResponse(error);
    if (known) return known;
    const message = labErrorMessage(error, "Validation failed");
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
