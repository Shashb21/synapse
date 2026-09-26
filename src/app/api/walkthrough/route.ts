import { NextResponse } from "next/server";
import { apiErrorResponse, readJsonBody, requireCustomerContext } from "@/modules/auth/api-guard";
import { getWalkthrough, saveWalkthrough, WALKTHROUGH_STATUSES, type WalkthroughStatus } from "@/lib/iegp/walkthrough";

export const runtime = "nodejs";

/**
 * Progress is per person per workspace: the signed-in principal. There is no
 * typed-name fallback; only the Vitest anonymous path (see api-guard) names a
 * guest from the request.
 */
export async function GET(request: Request) {
  try {
    const actor_name = new URL(request.url).searchParams.get("actor_name");
    const { principal } = await requireCustomerContext({ body: { actor_name } });
    return NextResponse.json({ progress: await getWalkthrough(principal) });
  } catch (error) {
    return apiErrorResponse(error, "Failed");
  }
}

/** Body: { action: "start" | "restart" | "step" | "dismiss" | "finish", step? }. */
export async function POST(request: Request) {
  try {
    const body = await readJsonBody(request);
    const { principal } = await requireCustomerContext({ body });
    const step = Number(body.step) || 0;
    const action = String(body.action ?? "");
    const next: Record<string, { status: WalkthroughStatus; step: number }> = {
      start: { status: "active", step },
      restart: { status: "active", step: 0 },
      step: { status: "active", step },
      dismiss: { status: "dismissed", step },
      finish: { status: "done", step },
    };
    const target = Object.hasOwn(next, action) ? next[action] : undefined;
    if (!target || !WALKTHROUGH_STATUSES.includes(target.status)) {
      return NextResponse.json({ error: `Unknown action ${action}` }, { status: 400 });
    }
    return NextResponse.json({ progress: await saveWalkthrough(principal, target) });
  } catch (error) {
    return apiErrorResponse(error, "Failed");
  }
}
