import { dashboardView, resetState } from "@/lib/store";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST() {
  const state = await resetState();
  return NextResponse.json({ ok: true, dashboard: dashboardView(state) });
}
