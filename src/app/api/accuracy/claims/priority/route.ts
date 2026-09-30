import { getWorkspaceOrgId } from "@/accuracy/store/tenant";
import { AccuracyPausedError, assertAccuracyCanProgress } from "@/accuracy/kernel/omission-pause";
import { NextResponse } from "next/server";
import { z } from "zod";
import { registerAccuracyStack } from "@/accuracy";
import { claimMetadata, getClaim, updateClaimMetadata } from "@/accuracy/store/claim-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

registerAccuracyStack();

const bodySchema = z.object({
  workspace_id: z.string(),
  claim_id: z.string(),
  priority: z.enum(["high", "medium", "low", "critical", "gated", "addressed"]),
  rationale: z.string().min(3),
});

export async function POST(req: Request) {
  try {
    const body = bodySchema.parse(await req.json());
    const org_id = await getWorkspaceOrgId(body.workspace_id);
    if (!org_id) return NextResponse.json({ ok: false, error: "Unknown workspace" }, { status: 404 });
    await assertAccuracyCanProgress(body.workspace_id, "prioritize");
    const claim = await getClaim(body.workspace_id, body.claim_id);
    if (!claim) {
      return NextResponse.json({ ok: false, error: "Claim not found" }, { status: 404 });
    }
    const meta = claimMetadata(claim);
    await updateClaimMetadata({
      workspace_id: body.workspace_id,
      claim_id: body.claim_id,
      metadata: {
        ...meta,
        priority: body.priority,
        priority_rationale: body.rationale,
      },
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof AccuracyPausedError) {
      return NextResponse.json({ ok: false, error: error.message, blockers: error.blockers }, { status: 409 });
    }
    const message = error instanceof Error ? error.message : "Priority update failed";
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
