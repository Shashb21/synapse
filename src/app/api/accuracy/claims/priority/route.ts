import { ownerGate } from "@/modules/auth/owner";
import { NextResponse } from "next/server";
import { z } from "zod";
import { registerAccuracyStack } from "@/accuracy";
import { CLAIM_PRIORITIES, updateClaim } from "@/accuracy/store/claim-edit";
import { actorFieldsSchema, actorFromBody } from "@/accuracy/store/claim-patch-schema";

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
    const body = bodySchema.parse(await req.json());
    try {
      const result = await updateClaim({
        workspace_id: body.workspace_id,
        claim_id: body.claim_id,
        patch: { priority: body.priority },
        rationale: body.rationale,
        actor: actorFromBody(body, "Accuracy planner"),
      });
      return NextResponse.json({ ok: true, changed: result.changed });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Priority update failed";
      if (/^Unknown claim/.test(message)) {
        return NextResponse.json({ ok: false, error: "Claim not found" }, { status: 404 });
      }
      if (message === "No changes to save.") {
        return NextResponse.json({ ok: true, changed: [] });
      }
      throw error;
    }
  } catch (error) {
    const message =
      error instanceof z.ZodError
        ? error.issues.map((issue) => issue.message).join("; ")
        : error instanceof Error
          ? error.message
          : "Priority update failed";
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
