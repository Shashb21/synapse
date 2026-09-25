import { ownerGate } from "@/modules/auth/owner";
import { NextResponse } from "next/server";
import { aiOffResponse, stageErrorResponse } from "@/app/api/modules/ai-off";
import { aiEnabled } from "@/modules/kernel/ai-switch";
import { runStage } from "@/modules";
import { STAGE_IDS, type StageId } from "@/modules/kernel/contracts";
import { activeModule } from "@/modules/kernel/registry";
import { runHillclimbSweep } from "@/modules/kernel/hillclimb-loop";
import { requestIdentity } from "@/modules/auth/request";
import { HILLCLIMB_STAGES } from "@/modules/kernel/prompt-versions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Scores prompt variants against curated gold and updates per-version baselines. */
export async function POST(request: Request) {
  const denied = await ownerGate();
  if (denied) return denied;
  const body = (await request.json()) as Record<string, unknown>;
  const stage = String(body.stage ?? "") as StageId;
  if (!STAGE_IDS.includes(stage)) {
    return NextResponse.json({ error: `Unknown stage ${body.stage}` }, { status: 400 });
  }
  if (!HILLCLIMB_STAGES.includes(stage)) {
    return NextResponse.json({ error: `${stage} does not participate in the hillclimb loop yet.` }, { status: 400 });
  }
  // Hillclimbing scores prompt variants, which only exist to be sent to a model.
  if (!(await aiEnabled())) return aiOffResponse();
  const identity = await requestIdentity(body);
  try {
    const implementation = await activeModule(stage);
    if (!implementation.evals) {
      return NextResponse.json({ error: `${implementation.manifest.id} has no eval harness.` }, { status: 400 });
    }
    const sweep = await runHillclimbSweep(stage, implementation, async (input) => {
      const result = await runStage({
        stage,
        input: { ...(input as Record<string, unknown>), dry_run: true },
        actor: identity.actor,
        role: identity.role,
      });
      return result.output as never;
    });
    return NextResponse.json({ ok: true, ...sweep });
  } catch (error) {
    return stageErrorResponse(error, "Hillclimb sweep failed");
  }
}
