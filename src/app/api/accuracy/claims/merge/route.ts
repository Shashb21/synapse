import { ownerGate } from "@/modules/auth/owner";
import { NextResponse } from "next/server";
import { z } from "zod";
import { registerAccuracyStack } from "@/accuracy";
import {
  dismissMergeProposal,
  manualMergeClaims,
  unmergeClaim,
} from "@/accuracy/store/claim-merge";
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

const bodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("merge"),
    workspace_id: z.string().min(1),
    survivor_id: z.string().min(1),
    duplicate_id: z.string().min(1),
    rationale: z.string(),
    ...actorFieldsSchema,
  }),
  z.object({
    action: z.literal("unmerge"),
    workspace_id: z.string().min(1),
    claim_id: z.string().min(1),
    rationale: z.string(),
    ...actorFieldsSchema,
  }),
  z.object({
    action: z.literal("dismiss"),
    workspace_id: z.string().min(1),
    claim_id: z.string().min(1),
    rationale: z.string(),
    ...actorFieldsSchema,
  }),
]);

/**
 * POST /api/accuracy/claims/merge
 * - `merge`: human merge (confirms a model proposal, or any pair the user picks).
 * - `unmerge`: clear merged_into, restore status; the pair is never auto-merged again.
 * - `dismiss`: reject a model merge proposal ("not the same item").
 */
export async function POST(request: Request) {
  const denied = await ownerGate();
  if (denied) return denied;
  try {
    const body = await parseLabBody(request, bodySchema);
    await requireLabWorkspace(body.workspace_id);
    const actor = await labActor();
    if (body.action === "merge") {
      const result = await manualMergeClaims({
        workspace_id: body.workspace_id,
        survivor_id: body.survivor_id,
        duplicate_id: body.duplicate_id,
        rationale: body.rationale,
        actor,
      });
      return NextResponse.json({ ok: true, action: body.action, ...result });
    }
    if (body.action === "unmerge") {
      const result = await unmergeClaim({
        workspace_id: body.workspace_id,
        claim_id: body.claim_id,
        rationale: body.rationale,
        actor,
      });
      return NextResponse.json({ ok: true, action: body.action, ...result });
    }
    const claim = await dismissMergeProposal({
      workspace_id: body.workspace_id,
      claim_id: body.claim_id,
      rationale: body.rationale,
      actor,
    });
    return NextResponse.json({ ok: true, action: body.action, claim });
  } catch (error) {
    const known = labRequestErrorResponse(error);
    if (known) return known;
    const message = labErrorMessage(error, "Merge action failed");
    const status = /^Unknown claim/.test(message) ? 404 : 400;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
