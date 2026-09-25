import { NextResponse } from "next/server";
import { currentSession } from "@/modules/auth/session";
import { principalOf } from "@/modules/workspaces/session";
import { getWalkthrough, saveWalkthrough, WALKTHROUGH_STATUSES, type WalkthroughStatus } from "@/lib/iegp/walkthrough";

export const runtime = "nodejs";

/** Progress is per person: the signed-in principal, else the typed demo name. */
async function principal(fallback?: unknown): Promise<string> {
  const session = await currentSession().catch(() => null);
  if (session) return principalOf(session);
  const name = typeof fallback === "string" ? fallback.trim() : "";
  return `guest:${name || "anonymous"}`;
}

export async function GET(request: Request) {
  try {
    const who = await principal(new URL(request.url).searchParams.get("actor_name"));
    return NextResponse.json({ progress: await getWalkthrough(who) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed" }, { status: 400 });
  }
}

/** Body: { action: "start" | "restart" | "step" | "dismiss" | "finish", step?, actor_name? }. */
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const who = await principal(body.actor_name);
    const step = Number(body.step) || 0;
    const action = String(body.action ?? "");
    const next: Record<string, { status: WalkthroughStatus; step: number }> = {
      start: { status: "active", step },
      restart: { status: "active", step: 0 },
      step: { status: "active", step },
      dismiss: { status: "dismissed", step },
      finish: { status: "done", step },
    };
    const target = next[action];
    if (!target || !WALKTHROUGH_STATUSES.includes(target.status)) {
      return NextResponse.json({ error: `Unknown action ${action}` }, { status: 400 });
    }
    return NextResponse.json({ progress: await saveWalkthrough(who, target) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed" }, { status: 400 });
  }
}
