import { ownerGate } from "@/modules/auth/owner";
import { NextResponse } from "next/server";
import {
  listAccuracyRuns,
  registerAccuracyStack,
  summarizeAccuracyRunCost,
} from "@/accuracy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

registerAccuracyStack();

export async function GET(request: Request) {
  const denied = await ownerGate();
  if (denied) return denied;
  const { searchParams } = new URL(request.url);
  const workspace_id = searchParams.get("workspace_id")?.trim() ?? "";
  if (!workspace_id) {
    return NextResponse.json({ error: "workspace_id is required" }, { status: 400 });
  }
  const limit = Math.min(100, Math.max(1, Number(searchParams.get("limit") ?? 40)));
  const [runs, rollup] = await Promise.all([
    listAccuracyRuns(workspace_id, limit),
    summarizeAccuracyRunCost(workspace_id),
  ]);
  return NextResponse.json({ runs, rollup });
}
