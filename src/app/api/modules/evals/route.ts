import { ownerGate } from "@/modules/auth/owner";
import { NextResponse } from "next/server";
import { aiOffResponse, stageErrorResponse } from "@/app/api/modules/ai-off";
import { aiEnabled } from "@/modules/kernel/ai-switch";
import "@/modules";
import { STAGE_IDS, type StageId } from "@/modules/kernel/contracts";
import { activeModule } from "@/modules/kernel/registry";
import { runOwnerDiagnostics } from "@/modules/kernel/hillclimb-loop";
import { requestIdentity } from "@/modules/auth/request";
import { apiErrorResponse, readJsonBody } from "@/modules/auth/api-guard";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * Runs a stage's own eval harness. Cases execute through the normal run loop with
 * `dry_run` set, so scoring is observable and never writes to the domain store.
 */
export async function POST(request: Request) {
  const denied = await ownerGate();
  if (denied) return denied;
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    return apiErrorResponse(error);
  }
  const stage = String(body.stage ?? "") as StageId;
  if (!STAGE_IDS.includes(stage)) {
    return NextResponse.json({ safe_error: true, error: "Choose an available AI task and try again." }, { status: 400 });
  }
  const identity = await requestIdentity(body);
  try {
    const implementation = await activeModule(stage);
    const manifest = implementation.manifest;
    const aiOnly = (manifest.agentic && !manifest.ai_optional) || manifest.needs_ai;
    if (aiOnly && !(await aiEnabled())) return aiOffResponse();
    if (!implementation.evals) {
      return NextResponse.json(
        { safe_error: true, error: `${implementation.manifest.id} does not ship an eval harness yet.` },
        { status: 400 },
      );
    }
    const harness = await runOwnerDiagnostics(implementation, identity, body.workspace_id, false);
    const summary = harness.variants[0];
    if (!summary) return NextResponse.json({ safe_error: true, error: harness.reason }, { status: 400 });
    return NextResponse.json({ ok: true, ...summary, group_id: harness.group_id });
  } catch (error) {
    return stageErrorResponse(error, "Eval run failed");
  }
}
