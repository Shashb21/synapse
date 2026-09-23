import { NextResponse } from "next/server";
import { z } from "zod";
import { registerAccuracyStack } from "@/accuracy";
import { getClaim, setTacticTiming } from "@/accuracy/store/claim-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

registerAccuracyStack();

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

const bodySchema = z.object({
  workspace_id: z.string().min(1),
  claim_id: z.string().min(1),
  start: isoDay,
  end: isoDay,
  rationale: z.string().min(3),
});

/**
 * Write start/end onto a tactic claim so validated coverage/plan work continues into Gantt.
 */
export async function POST(req: Request) {
  try {
    const body = bodySchema.parse(await req.json());
    const claim = await getClaim(body.workspace_id, body.claim_id);
    if (!claim) {
      return NextResponse.json({ ok: false, error: "Claim not found" }, { status: 404 });
    }
    if (claim.claim_type !== "tactic") {
      return NextResponse.json(
        { ok: false, error: "Timing can only be set on tactic claims." },
        { status: 400 },
      );
    }
    const updated = await setTacticTiming({
      workspace_id: body.workspace_id,
      claim_id: body.claim_id,
      start: body.start,
      end: body.end,
      rationale: body.rationale,
      actor: { name: "user", function: "medical_affairs" },
    });
    return NextResponse.json({
      ok: true,
      claim_id: updated.id,
      start: (updated.metadata as { start?: string }).start ?? body.start,
      end: (updated.metadata as { end?: string }).end ?? body.end,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Timing update failed";
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
