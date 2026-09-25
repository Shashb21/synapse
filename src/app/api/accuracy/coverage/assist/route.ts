import { ownerGate } from "@/modules/auth/owner";
import { NextResponse } from "next/server";
import { z } from "zod";
import { registerAccuracyStack, runAccuracyModule } from "@/accuracy";
import type { CoverageDecision } from "@/accuracy/modules/coverage-decide/schema";
import { mapCoverageOverallToUi } from "@/accuracy/modules/coverage-decide/overall-map";
import { getClaimsByIds } from "@/accuracy/store/claim-store";
import { blockBundleIdsForPair } from "@/accuracy/store/coverage-queue";
import { getWorkspaceOrgId } from "@/accuracy/store/tenant";
import { isTestStub } from "@/modules/kernel/llm";
import { aiOffFromError, refuseWhenAiOff } from "@/app/api/accuracy/_lib/ai-off";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

registerAccuracyStack();

const bodySchema = z.object({
  workspace_id: z.string().min(1),
  gap_id: z.string().min(1),
  tactic_id: z.string().min(1),
  actor_name: z.string().min(1).optional(),
  actor_function: z.string().min(1).optional(),
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
    const body = bodySchema.parse(await req.json());
    const aiOff = await refuseWhenAiOff();
    if (aiOff) return aiOff;
    const org_id = await getWorkspaceOrgId(body.workspace_id);
    if (!org_id) {
      return NextResponse.json({ ok: false, error: "Unknown workspace" }, { status: 404 });
    }

    const claims = await getClaimsByIds(body.workspace_id, [body.gap_id, body.tactic_id]);
    const gap = claims.find((c) => c.id === body.gap_id);
    const tactic = claims.find((c) => c.id === body.tactic_id);
    if (!gap || gap.claim_type !== "gap") {
      return NextResponse.json({ ok: false, error: "Unknown gap_id" }, { status: 400 });
    }
    if (!tactic || tactic.claim_type !== "tactic") {
      return NextResponse.json({ ok: false, error: "Unknown tactic_id" }, { status: 400 });
    }

    const block_bundle_ids =
      body.block_bundle_ids && body.block_bundle_ids.length > 0
        ? body.block_bundle_ids
        : blockBundleIdsForPair(gap, tactic);

    const actor = {
      name: body.actor_name?.trim() || "Coverage assist",
      function: (body.actor_function?.trim() || "medical_affairs") as "medical_affairs",
    };

    const result = await runAccuracyModule<CoverageDecision>({
      call_kind: "coverage_decide",
      agent_role: "proposer",
      input: {
        workspace_id: body.workspace_id,
        gap_id: body.gap_id,
        tactic_id: body.tactic_id,
        block_bundle_ids,
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
    const aiOff = aiOffFromError(error);
    if (aiOff) return aiOff;
    const message = error instanceof Error ? error.message : "Coverage assist failed";
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
