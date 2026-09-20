import { NextResponse } from "next/server";
import { agenticCallLog, agenticCallSummary } from "@/lib/llm/agentic";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const limitRaw = Number(url.searchParams.get("limit") ?? "50");
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;
  const calls = agenticCallLog().slice(-limit);
  return NextResponse.json({ ok: true, summary: agenticCallSummary(), calls });
}
