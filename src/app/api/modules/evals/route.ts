import { ownerGate } from "@/modules/auth/owner";
import { NextResponse } from "next/server";
import { aiOffResponse, stageErrorResponse } from "@/app/api/modules/ai-off";
import { aiEnabled } from "@/modules/kernel/ai-switch";
import { runStage } from "@/modules";
import { STAGE_IDS, type StageId } from "@/modules/kernel/contracts";
import { activeModule } from "@/modules/kernel/registry";
import { recordEvalRun, runStageEvals } from "@/modules/kernel/evals";
import { requestIdentity } from "@/modules/auth/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Runs a stage's own eval harness. Cases execute through the normal run loop with
 * `dry_run` set, so scoring is observable and never writes to the domain store.
 */
export async function POST(request: Request) {
  const denied = await ownerGate();
  if (denied) return denied;
  const body = (await request.json()) as Record<string, unknown>;
  const stage = String(body.stage ?? "") as StageId;
  if (!STAGE_IDS.includes(stage)) {
    return NextResponse.json({ error: `Unknown stage ${body.stage}` }, { status: 400 });
  }
  const identity = await requestIdentity(body);
  try {
    const implementation = await activeModule(stage);
    const manifest = implementation.manifest;
    const aiOnly = (manifest.agentic && !manifest.ai_optional) || manifest.needs_ai;
    if (aiOnly && !(await aiEnabled())) return aiOffResponse();
    if (!implementation.evals) {
      return NextResponse.json(
        { error: `${implementation.manifest.id} does not ship an eval harness yet.` },
        { status: 400 },
      );
    }
    const { metrics, cases } = await runStageEvals(implementation, async (input) => {
      const result = await runStage({
        stage,
        input: { ...(input as Record<string, unknown>), dry_run: true },
        actor: identity.actor,
        role: identity.role,
      });
      return result.output as never;
    });
    if (cases === 0) {
      return NextResponse.json(
        { error: "No gold cases are available yet. Parse a source first." },
        { status: 400 },
      );
    }
    const record = await recordEvalRun({
      stage,
      module_id: implementation.manifest.id,
      module_version: implementation.manifest.version,
      metrics,
      note: `${cases} gold case(s)`,
    });
    return NextResponse.json({ ok: true, cases, metrics, passed: record.passed, eval_run_id: record.id });
  } catch (error) {
    return stageErrorResponse(error, "Eval run failed");
  }
}
