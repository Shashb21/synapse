import { dashboardView, getState } from "@/lib/store";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET() {
  const state = await getState();
  return NextResponse.json(dashboardView(state));
}
