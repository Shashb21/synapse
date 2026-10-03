import { AccuracyPausedError, assertAccuracyCanProgress } from "@/accuracy/kernel/omission-pause";
import { NextResponse } from "next/server";
import { z } from "zod";
import { registerAccuracyStack, runAccuracyModule } from "@/accuracy";
import { listCoveragePairs, upsertCoverageDecision } from "@/accuracy/store/coverage-store";
import { getWorkspaceOrgId } from "@/accuracy/store/tenant";
import { AssemblyReviewError } from "@/accuracy/domain/assembly-review";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

registerAccuracyStack();

export async function GET(req: Request) {
  const workspace_id = new URL(req.url).searchParams.get("workspace_id")?.trim();
  if (!workspace_id) {
    return NextResponse.json({ error: "workspace_id required" }, { status: 400 });
  }
  try {
    const org_id = await getWorkspaceOrgId(workspace_id);
    if (!org_id) return NextResponse.json({ error: "Unknown workspace" }, { status: 404 });
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
    if (error instanceof AssemblyReviewError) return NextResponse.json({ ok: false, code: error.code, error: error.message }, { status: error.code === "invalid_input" ? 400 : error.code === "not_found" ? 404 : error.code === "forbidden" ? 403 : 409 });
    const message = error instanceof Error ? error.message : "Coverage pair generation failed";
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
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
    const org_id = await getWorkspaceOrgId(body.workspace_id);
    if (!org_id) return NextResponse.json({ ok: false, error: "Unknown workspace" }, { status: 404 });
    await assertAccuracyCanProgress(body.workspace_id, "coverage_decide");
    await upsertCoverageDecision(body);
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
    if (error instanceof AccuracyPausedError) {
      return NextResponse.json({ ok: false, error: error.message, blockers: error.blockers }, { status: 409 });
    }
    if (error instanceof AssemblyReviewError) return NextResponse.json({ ok: false, code: error.code, error: error.message }, { status: error.code === "invalid_input" ? 400 : error.code === "not_found" ? 404 : error.code === "forbidden" ? 403 : 409 });
    const message = error instanceof Error ? error.message : "Coverage decide failed";
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
