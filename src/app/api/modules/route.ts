import { NextResponse } from "next/server";
import { stageErrorResponse } from "@/app/api/modules/ai-off";
import { runStage } from "@/modules";
import { STAGE_IDS, type StageId } from "@/modules/kernel/contracts";
import { stageWiring } from "@/modules/kernel/registry";
import { listRuns, stageHealth } from "@/modules/kernel/observability";
import { routeConfigs } from "@/modules/kernel/routing";
import { readJsonBody, requireCustomerContext } from "@/modules/auth/api-guard";
import { ownerGate } from "@/modules/auth/owner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Lab observability (wiring, runs, health, routes): owner only. */
export async function GET() {
  const denied = await ownerGate();
  if (denied) return denied;
  const [wiring, runs, health, routes] = await Promise.all([
    stageWiring(),
    listRuns({ limit: 20 }),
    stageHealth(),
    routeConfigs(),
  ]);
  return NextResponse.json({ wiring, runs, health, routes });
}

/**
 * Plain stage runs stay open to customers (S8 re-suggest, S9 ideation, S10
 * timeline run from their pages), behind a verified session and workspace
 * membership. runStage checks the stage's capability against the session role.
 */
export async function POST(request: Request) {
  try {
    const body = await readJsonBody(request);
    const identity = await requireCustomerContext({ body });
    const stage = String(body.stage ?? "") as StageId;
    if (!STAGE_IDS.includes(stage)) {
      return NextResponse.json({ error: `Unknown stage ${body.stage}` }, { status: 400 });
    }
    const result = await runStage({
      stage,
      input: (body.input as unknown) ?? {},
      actor: identity.actor,
      role: identity.role,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return stageErrorResponse(error, "Stage run failed");
  }
}
