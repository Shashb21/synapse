import { AccuracyPausedError, assertAccuracyCanProgress } from "@/accuracy/kernel/omission-pause";
import { getWorkspaceOrgId } from "@/accuracy/store/tenant";
import { NextResponse } from "next/server";
import { z } from "zod";
import { registerAccuracyStack } from "@/accuracy";
import { insertClaim, listClaims, type AccuracyClaimType } from "@/accuracy/store/claim-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

registerAccuracyStack();

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const workspace_id = searchParams.get("workspace_id")?.trim() ?? "";
  if (!workspace_id) {
    return NextResponse.json({ error: "workspace_id is required" }, { status: 400 });
  }
  const claim_type = searchParams.get("claim_type")?.trim() as AccuracyClaimType | undefined;
  const claims = await listClaims(workspace_id, {
    claim_type: claim_type === "gap" || claim_type === "tactic" ? claim_type : undefined,
  });
  return NextResponse.json({ claims });
}

const insertSchema = z.object({
  workspace_id: z.string().min(1),
  claim_type: z.enum(["gap", "tactic"]),
  statement: z.string().min(1),
  status: z.string().optional(),
  validated: z.boolean().optional(),
  source_file_id: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

/** Seed / insert a draft claim (tests and early pipeline wiring). */
export async function POST(request: Request) {
  try {
    const body = insertSchema.parse(await request.json());
    const org_id = await getWorkspaceOrgId(body.workspace_id);
    if (!org_id) return NextResponse.json({ error: "Unknown workspace" }, { status: 404 });
    await assertAccuracyCanProgress(body.workspace_id, "validation_gate");
    const claim = await insertClaim({
      workspace_id: body.workspace_id,
      claim_type: body.claim_type,
      statement: body.statement,
      status: body.status,
      validated: body.validated,
      source_file_id: body.source_file_id,
      metadata: body.metadata,
    });
    return NextResponse.json({ ok: true, claim });
  } catch (error) {
    if (error instanceof AccuracyPausedError) {
      return NextResponse.json({ ok: false, error: error.message, blockers: error.blockers }, { status: 409 });
    }
    const message = error instanceof Error ? error.message : "Could not insert claim";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
