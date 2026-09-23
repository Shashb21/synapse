import { NextResponse } from "next/server";
import { registerAccuracyStack } from "@/accuracy";
import { listWorkspaces } from "@/accuracy/store/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

registerAccuracyStack();

export async function GET() {
  const workspaces = await listWorkspaces();
  return NextResponse.json({ workspaces });
}
