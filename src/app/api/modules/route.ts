import { NextResponse } from "next/server";
import { runStage } from "@/modules";
import { STAGE_IDS, type StageId } from "@/modules/kernel/contracts";
import { stageWiring } from "@/modules/kernel/registry";
import { listRuns, stageHealth } from "@/modules/kernel/observability";
import { routeConfigs } from "@/modules/kernel/routing";
import { requestIdentity } from "@/modules/auth/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const [wiring, runs, health, routes] = await Promise.all([
    stageWiring(),
    listRuns({ limit: 20 }),
    stageHealth(),
    routeConfigs(),
  ]);
  return NextResponse.json({ wiring, runs, health, routes });
}

export async function POST(request: Request) {
  const body = (await request.json()) as Record<string, unknown>;
  const stage = String(body.stage ?? "") as StageId;
  if (!STAGE_IDS.includes(stage)) {
    return NextResponse.json({ error: `Unknown stage ${body.stage}` }, { status: 400 });
  }
  const identity = await requestIdentity(body);
  try {
    const result = await runStage({
      stage,
      input: (body.input as unknown) ?? {},
      actor: identity.actor,
      role: identity.role,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Stage run failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
