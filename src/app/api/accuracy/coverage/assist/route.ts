import { AccuracyPausedError, assertAccuracyCanProgress } from "@/accuracy/kernel/omission-pause";
import { ownerGate } from "@/modules/auth/owner";
import { NextResponse } from "next/server";
import { z } from "zod";
import { registerAccuracyStack, runAccuracyModule } from "@/accuracy";
import type { CoverageDecision } from "@/accuracy/modules/coverage-decide/schema";
import { mapCoverageOverallToUi } from "@/accuracy/modules/coverage-decide/overall-map";
import { CoverageError, requireCoveragePairClaims, requireCoverageEvidence, coveragePairRevisions, coverageFactsForPair } from "@/accuracy/store/coverage-store";
import { blockBundleIdsForPair } from "@/accuracy/store/coverage-queue";
import { isTestStub } from "@/modules/kernel/llm";
import { aiOffFromError, refuseWhenAiOff } from "@/app/api/accuracy/_lib/ai-off";
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

const bodySchema = z.object({
  workspace_id: z.string().min(1),
  gap_id: z.string().min(1),
  tactic_id: z.string().min(1),
  /** Ignored: the run is credited to the signed-in owner. */
  actor_name: z.string().optional(),
  actor_function: z.string().optional(),
  /** Optional override; default = provenance block ids from both claims. */
  block_bundle_ids: z.array(z.string()).optional(),
});

/**
 * Optional LLM assist for one coverage pair. Returns a suggestion only —
 * does not persist; the human still confirms via POST /api/accuracy/coverage.
 */
export async function POST(req: Request) {
  const denied = await ownerGate();
  if (denied) return denied;
  try {
    const body = await parseLabBody(req, bodySchema);
    const aiOff = await refuseWhenAiOff();
    if (aiOff) return aiOff;
    const { org_id } = await requireLabWorkspace(body.workspace_id);

    await assertAccuracyCanProgress(body.workspace_id, "coverage_decide");
    const { gap, tactic } = await requireCoveragePairClaims(body);
    const expected = await coveragePairRevisions(body, { gap, tactic });
    const block_bundle_ids =
      body.block_bundle_ids && body.block_bundle_ids.length > 0
        ? body.block_bundle_ids
        : blockBundleIdsForPair(gap, tactic);

    await requireCoverageEvidence({ ...body, evidence: block_bundle_ids }, { gap, tactic });
    const actor = await labActor();

    const result = await runAccuracyModule<CoverageDecision>({
      call_kind: "coverage_decide",
      agent_role: "proposer",
      input: {
        workspace_id: body.workspace_id,
        gap_id: body.gap_id,
        tactic_id: body.tactic_id,
        block_bundle_ids, facts: coverageFactsForPair({ gap, tactic }),
      },
      actor,
      org_id,
      workspace_id: body.workspace_id,
    });

    const ui_overall = mapCoverageOverallToUi(result.output.overall);
    // Only the test stub skips the model; a production run either used it or threw.
    const mode: "llm" | "stub" = isTestStub() ? "stub" : "llm";

    return NextResponse.json({
      ok: true,
      ...expected,
      suggestion: {
        overall: ui_overall,
        schema_overall: result.output.overall,
        rationale: result.output.rationale,
        confidence: result.output.confidence,
        quote_block_ids: result.output.quote_block_ids,
      },
      block_bundle_ids,
      run_id: result.run_id,
      mode,
      stub: mode === "stub",
    });
  } catch (error) {
    if (error instanceof CoverageError) return NextResponse.json({ ok: false, error: error.message, code: error.code }, { status: 400 });
    const aiOff = aiOffFromError(error);
    if (aiOff) return aiOff;
    if (error instanceof AccuracyPausedError) {
      return NextResponse.json({ ok: false, error: error.message, blockers: error.blockers }, { status: 409 });
    }
    const known = labRequestErrorResponse(error);
    if (known) return known;
    const message = labErrorMessage(error, "Coverage assist failed");
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
