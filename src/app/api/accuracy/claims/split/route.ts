import { NextResponse } from "next/server";
import { z } from "zod";
import { ownerGate } from "@/modules/auth/owner";
import { listAccuracySplitOperations, readAccuracySplitInputs } from "@/accuracy/store/partial-split-store";
import { requireLabWorkspace } from "@/app/api/accuracy/_lib/request";
import { splitErrorResponse } from "./errors";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const schema = z.object({ workspace_id: z.string().min(1), gap_id: z.string().min(1).optional() });
/** History and current revision/evidence inputs also support the manual path while AI is off. */
export async function GET(request: Request) {
  const denied = await ownerGate(); if (denied) return denied;
  try {
    const url = new URL(request.url);
    const query = schema.parse({ workspace_id: url.searchParams.get("workspace_id"), gap_id: url.searchParams.get("gap_id") ?? undefined });
    await requireLabWorkspace(query.workspace_id);
    const operations = await listAccuracySplitOperations(query.workspace_id);
    if (!query.gap_id) return NextResponse.json({ ok: true, operations });
    const input = await readAccuracySplitInputs({ workspace_id: query.workspace_id, gap_id: query.gap_id });
    return NextResponse.json({ ok: true, operations, ...input.revisions,
      parent: input.parent, supporting_coverage: input.supporting, permitted_evidence: input.evidence });
  } catch (error) { return splitErrorResponse(error); }
}
