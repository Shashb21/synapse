import { NextResponse } from "next/server";
import { listExtractRuns } from "@/lib/iegp/extract/store";

export const runtime = "nodejs";

export async function GET() {
  const runs = await listExtractRuns(80);
  return NextResponse.json({ runs });
}
