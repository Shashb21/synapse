import { NextResponse } from "next/server";
import { z } from "zod";
import { ownerGate } from "@/modules/auth/owner";
import { rollbackAccuracySplit } from "@/accuracy/store/partial-split-store";
import { labActor, parseLabBody, requireLabWorkspace } from "@/app/api/accuracy/_lib/request";
import { splitErrorResponse } from "../errors";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const schema = z.object({ workspace_id: z.string().min(1), operation_id: z.string().min(1), rationale: z.string().trim().min(3) });
export async function POST(request: Request) {
  const denied = await ownerGate(); if (denied) return denied;
  try {
    const body = await parseLabBody(request, schema);
    await requireLabWorkspace(body.workspace_id);
    await rollbackAccuracySplit({ ...body, actor: await labActor() });
    return NextResponse.json({ ok: true });
  } catch (error) { return splitErrorResponse(error); }
}
