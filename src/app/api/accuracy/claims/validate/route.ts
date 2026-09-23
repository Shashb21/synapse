import { NextResponse } from "next/server";
import { z } from "zod";
import { registerAccuracyStack, runAccuracyModule } from "@/accuracy";
import { getWorkspaceOrgId } from "@/accuracy/store/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

registerAccuracyStack();

const bodySchema = z.object({
  workspace_id: z.string().min(1),
  claim_ids: z.array(z.string().min(1)).min(1),
  action: z.enum(["validate", "reject"]),
  rationale: z.string().min(1),
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
    const result = await runAccuracyModule({
      call_kind: "validation_gate",
      agent_role: "none",
      input: {
        workspace_id: body.workspace_id,
        claim_ids: body.claim_ids,
        action: body.action,
        rationale: body.rationale,
      },
      actor: {
        name: body.actor_name?.trim() || "Accuracy reviewer",
        function: (body.actor_function?.trim() || "medical_affairs") as "medical_affairs",
      },
      org_id,
      workspace_id: body.workspace_id,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Validation failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
