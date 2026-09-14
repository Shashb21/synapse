import { dashboardView, getState, rerunEvals } from "@/lib/store";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET() {
  const state = await getState();
  return NextResponse.json({
    champion_prompt_version: state.champion_prompt_version,
    eval_runs: state.eval_runs,
    gold_count: state.gold.length,
    dashboard: dashboardView(state),
  });
}

export async function POST() {
  const state = await rerunEvals();
  return NextResponse.json({
    champion_prompt_version: state.champion_prompt_version,
    eval_runs: state.eval_runs,
    gold_count: state.gold.length,
    dashboard: dashboardView(state),
  });
}
