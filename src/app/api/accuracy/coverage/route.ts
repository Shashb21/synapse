import { NextResponse } from "next/server";
import { z } from "zod";
import { registerAccuracyStack, runAccuracyModule } from "@/accuracy";
import {
  listCoveragePairs,
  requireCoveragePairClaims,
  upsertCoverageDecision,
} from "@/accuracy/store/coverage-store";
import { getWorkspaceOrgId } from "@/accuracy/store/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

registerAccuracyStack();

export async function GET(req: Request) {
  const workspace_id = new URL(req.url).searchParams.get("workspace_id")?.trim();
  if (!workspace_id) {
    return NextResponse.json({ error: "workspace_id required" }, { status: 400 });
  }
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
}

const decideSchema = z.object({
  workspace_id: z.string(),
  gap_id: z.string(),
  tactic_id: z.string(),
  overall: z.enum(["covers", "partial", "none", "unknown"]),
  rationale: z.string().trim().min(3),
});

/**
 * POST /api/accuracy/coverage — human coverage decision for ANY gap↔tactic
 * pair in the workspace (queue pick or manual pair picker). Rationale required.
 */

export async function POST(req: Request) {
  try {
    const body = decideSchema.parse(await req.json());
    await requireCoveragePairClaims(body);
    await upsertCoverageDecision(body);
    const org_id = await getWorkspaceOrgId(body.workspace_id);
    let statuses: unknown = null;
    if (org_id) {
      const derived = await runAccuracyModule({
        call_kind: "status_derive",
        agent_role: "none",
        input: { workspace_id: body.workspace_id, gap_ids: [body.gap_id] },
        actor: { name: "Coverage decide", function: "medical_affairs" },
        org_id,
        workspace_id: body.workspace_id,
      });
      statuses = derived.output;
    }
    return NextResponse.json({ ok: true, statuses });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Coverage decide failed";
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
