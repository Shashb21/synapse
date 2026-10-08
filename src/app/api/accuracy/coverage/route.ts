import { AccuracyPausedError, assertAccuracyCanProgress } from "@/accuracy/kernel/omission-pause";
import { ownerGate } from "@/modules/auth/owner";
import { NextResponse } from "next/server";
import { coverageFactsForPair } from "@/accuracy/store/coverage-store";
import { blockBundleIdsForPair } from "@/accuracy/store/coverage-queue";
import type { CoverageDecision } from "@/accuracy/modules/coverage-decide/schema";
import { refuseWhenAiOff, aiOffFromError } from "@/app/api/accuracy/_lib/ai-off";
import { z } from "zod";
import { registerAccuracyStack, runAccuracyModule } from "@/accuracy";
import {
  listCoveragePage, assessCoveragePage, CoverageError, rejectCoveragePair, type CoveragePage,
  upsertCoverageDecision,
} from "@/accuracy/store/coverage-store";
import {
  labActor, labRevisionAuthor,
  labErrorMessage,
  labRequestErrorResponse,
  readLabJson,
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
    const url = new URL(req.url);
    const page = await listCoveragePage({ workspace_id, cursor: url.searchParams.get("cursor") ?? undefined,
      page_size: url.searchParams.has("page_size") ? Number(url.searchParams.get("page_size")) : undefined });
    return NextResponse.json(coveragePagePayload(page));
  } catch (error) {
    if (error instanceof CoverageError) return coverageErrorResponse(error);
    if (error instanceof AccuracyPausedError) {
      return NextResponse.json({ ok: false, error: error.message, blockers: error.blockers }, { status: 409 });
    }
    const known = labRequestErrorResponse(error);
    if (known) return known;
    const message = labErrorMessage(error, "Coverage pair generation failed");
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}

function coveragePagePayload(page: CoveragePage) {
  return {
    snapshot: page.snapshot, next_cursor: page.next_cursor, progress: page.progress,
    pairs: page.pairs.map((p) => ({
      id: p.id,
      gap_id: p.gap.id,
      gap_statement: p.gap.statement,
      tactic_id: p.tactic.id,
      tactic_statement: p.tactic.statement,
      overall: p.overall,
      rationale: p.rationale,
      validated: p.validated, gap_revision: p.gap_revision, tactic_revision: p.tactic_revision,
      freshness: p.freshness, validation_freshness: p.validation_freshness,
      assessment_state: p.assessment_state, failure_reason: p.failure_reason, pending_reason: p.pending_reason,
      protected: p.protected, evidence: p.evidence,
    })),
  };
}

const decideSchema = z.object({
  action: z.enum(["decide", "reject"]).optional(),
  workspace_id: z.string().min(1), gap_id: z.string().min(1), tactic_id: z.string().min(1),
  overall: z.enum(["pending", "full", "partial", "limited", "not_relevant", "covers", "none", "unknown"]),
  rationale: z.string().trim().min(3), evidence: z.array(z.string().min(1)).optional(),
  expected_gap_revision: z.string().min(1).optional(), expected_tactic_revision: z.string().min(1).optional(),
});
const assessSchema = z.object({
  action: z.literal("assess"), workspace_id: z.string().min(1), cursor: z.string().max(4096).optional(),
  page_size: z.number().int().min(1).max(500).optional(), snapshot: z.string().optional(),
});
function coverageErrorResponse(error: CoverageError) {
  return NextResponse.json({ ok: false, error: { code: error.code, message: error.message,
    restart_without_cursor: error.code === "stale_snapshot" }, code: error.code },
    { status: ["stale_snapshot", "stale_revision", "protected_pair"].includes(error.code) ? 409 : 400 });
}

/**
 * POST /api/accuracy/coverage — human coverage decision for ANY gap↔tactic
 * pair in the workspace (queue pick or manual pair picker). Rationale required.
 */

export async function POST(req: Request) {
  const denied = await ownerGate();
  if (denied) return denied;
  try {
    const raw = await readLabJson(req);
    // Select the action first so validation still reports the actual field/path.
    const body = typeof raw === "object" && raw !== null && "action" in raw && raw.action === "assess"
      ? assessSchema.parse(raw)
      : decideSchema.parse(raw);
    const { org_id } = await requireLabWorkspace(body.workspace_id);
    await assertAccuracyCanProgress(body.workspace_id, "coverage_decide");
    const actor = await labActor();
    if (body.action === "assess") {
      const aiOff = await refuseWhenAiOff();
      if (aiOff) return aiOff;
      const page = await assessCoveragePage({ ...body, assess: async (pair) => {
        const result = await runAccuracyModule<CoverageDecision>({ call_kind: "coverage_decide", agent_role: "proposer",
          input: { workspace_id: body.workspace_id, gap_id: pair.gap.id, tactic_id: pair.tactic.id,
            block_bundle_ids: blockBundleIdsForPair(pair.gap, pair.tactic), facts: coverageFactsForPair(pair) },
          actor, org_id, workspace_id: body.workspace_id });
        return { overall: result.output.overall, rationale: result.output.rationale,
          evidence: result.output.quote_block_ids, run_id: result.run_id };
      } });
      return NextResponse.json({ ok: true, ...coveragePagePayload(page), attempts: page.attempts });
    }
    const author = await labRevisionAuthor();
    const decision = body.action === "reject" ? await rejectCoveragePair({ ...body, actor, author }) : await upsertCoverageDecision({ ...body, actor, author });
    if (decision.awaiting_approval) return NextResponse.json({ ok: true, awaiting_approval: true, assembly_id: decision.assembly_id });
    const derived = await runAccuracyModule({
      call_kind: "status_derive",
      agent_role: "none",
      input: { workspace_id: body.workspace_id, gap_ids: [body.gap_id] },
      actor,
      org_id,
      workspace_id: body.workspace_id,
    });
    return NextResponse.json({ ok: true, statuses: derived.output });
  } catch (error) {
    if (error instanceof CoverageError) return coverageErrorResponse(error);
    const aiOff = aiOffFromError(error);
    if (aiOff) return aiOff;
    if (error instanceof AccuracyPausedError) {
      return NextResponse.json({ ok: false, error: error.message, blockers: error.blockers }, { status: 409 });
    }
    const known = labRequestErrorResponse(error);
    if (known) return known;
    const message = labErrorMessage(error, "Coverage decide failed");
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
