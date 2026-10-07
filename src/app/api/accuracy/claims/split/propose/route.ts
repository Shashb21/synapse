import { NextResponse } from "next/server";
import { z } from "zod";
import { ownerGate } from "@/modules/auth/owner";
import { registerAccuracyStack, runAccuracyModule } from "@/accuracy";
import { AccuracyPausedError } from "@/accuracy/kernel/omission-pause";
import { labActor, parseLabBody, requireLabWorkspace } from "@/app/api/accuracy/_lib/request";
import { aiOffFromError, refuseWhenAiOff } from "@/app/api/accuracy/_lib/ai-off";
import { splitErrorResponse } from "../errors";
import type { SplitProposal } from "@/accuracy/store/partial-split-store";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
registerAccuracyStack();
const schema = z.object({ workspace_id: z.string().min(1), gap_id: z.string().min(1) });
export async function POST(request: Request) {
  const denied = await ownerGate(); if (denied) return denied;
  try {
    const body = await parseLabBody(request, schema);
    const aiOff = await refuseWhenAiOff(); if (aiOff) return aiOff;
    const { org_id } = await requireLabWorkspace(body.workspace_id);
    const result = await runAccuracyModule<{ proposal: SplitProposal | null }>({ call_kind: "partial_split", agent_role: "proposer",
      input: body, actor: await labActor(), org_id, workspace_id: body.workspace_id });
    return NextResponse.json({ ok: true, proposal: result.output.proposal, run_id: result.run_id });
  } catch (error) {
    const aiOff = aiOffFromError(error); if (aiOff) return aiOff;
    if (error instanceof AccuracyPausedError) return NextResponse.json({ ok: false, blockers: error.blockers }, { status: 409 });
    return splitErrorResponse(error);
  }
}
