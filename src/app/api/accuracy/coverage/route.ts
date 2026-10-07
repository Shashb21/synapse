import { AccuracyPausedError, assertAccuracyCanProgress } from "@/accuracy/kernel/omission-pause";
import { ownerGate } from "@/modules/auth/owner";
import { NextResponse } from "next/server";
import { z } from "zod";
import { registerAccuracyStack, runAccuracyModule } from "@/accuracy";
import {
  listCoveragePairs,
  requireCoveragePairClaims,
  upsertCoverageDecision,
} from "@/accuracy/store/coverage-store";
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

export async function GET(req: Request) {
  const denied = await ownerGate();
  if (denied) return denied;
  const workspace_id = new URL(req.url).searchParams.get("workspace_id")?.trim();
  if (!workspace_id) {
    return NextResponse.json({ error: "workspace_id required" }, { status: 400 });
  }
  try {
    await requireLabWorkspace(workspace_id);
    await assertAccuracyCanProgress(workspace_id, "pair_generate");
    const pairs = await listCoveragePairs(workspace_id);
    return NextResponse.json({
      pairs: pairs.map((p) => ({
        id: p.id,
        gap_id: p.gap.id,
        gap_statement: p.gap.statement,
        tactic_id: p.tactic.id,
        tactic_statement: p.tactic.statement,
        overall: p.overall,
        rationale: p.rationale,
        validated: p.validated,
      })),
    });
  } catch (error) {
    if (error instanceof AccuracyPausedError) {
      return NextResponse.json({ ok: false, error: error.message, blockers: error.blockers }, { status: 409 });
    }
    const known = labRequestErrorResponse(error);
    if (known) return known;
    const message = labErrorMessage(error, "Coverage pair generation failed");
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}

const decideSchema = z.object({
  workspace_id: z.string().min(1),
  gap_id: z.string().min(1),
  tactic_id: z.string().min(1),
  overall: z.enum(["covers", "partial", "none", "unknown"]),
  rationale: z.string().trim().min(3),
});

/**
 * POST /api/accuracy/coverage — human coverage decision for ANY gap↔tactic
 * pair in the workspace (queue pick or manual pair picker). Rationale required.
 */

export async function POST(req: Request) {
  const denied = await ownerGate();
  if (denied) return denied;
  try {
    const body = await parseLabBody(req, decideSchema);
    const { org_id } = await requireLabWorkspace(body.workspace_id);
    await assertAccuracyCanProgress(body.workspace_id, "coverage_decide");
    await requireCoveragePairClaims(body);
    await upsertCoverageDecision(body);
    const derived = await runAccuracyModule({
      call_kind: "status_derive",
      agent_role: "none",
      input: { workspace_id: body.workspace_id, gap_ids: [body.gap_id] },
      actor: await labActor(),
      org_id,
      workspace_id: body.workspace_id,
    });
    return NextResponse.json({ ok: true, statuses: derived.output });
  } catch (error) {
    if (error instanceof AccuracyPausedError) {
      return NextResponse.json({ ok: false, error: error.message, blockers: error.blockers }, { status: 409 });
    }
    const known = labRequestErrorResponse(error);
    if (known) return known;
    const message = labErrorMessage(error, "Coverage decide failed");
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
