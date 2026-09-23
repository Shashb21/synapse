import { NextResponse } from "next/server";
import { z } from "zod";
import { registerAccuracyStack } from "@/accuracy";
import { listCoveragePairs, upsertCoverageDecision } from "@/accuracy/store/coverage-store";

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
  rationale: z.string().min(3),
});

export async function POST(req: Request) {
  try {
    const body = decideSchema.parse(await req.json());
    await upsertCoverageDecision(body);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Coverage decide failed";
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
