import { NextResponse } from "next/server";
import { assembleObservability } from "@/lib/llm/agentic";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const limitRaw = Number(url.searchParams.get("limit") ?? "200");
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 1000) : 200;
  const payload = await assembleObservability(limit);
  return NextResponse.json({
    ok: true,
    summary: payload.summary,
    calls: payload.calls,
    reauth: payload.reauth,
  });
}
