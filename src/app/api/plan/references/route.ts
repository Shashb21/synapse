import { NextResponse } from "next/server";
import { requireCustomerContext, apiErrorResponse } from "@/modules/auth/api-guard";
import { loadState } from "@/lib/iegp/store";
import { inspectJudgementReferences } from "@/lib/iegp/judgement-references";
import { listPlacements } from "@/modules/stages/s8-prioritization/module";

export async function GET(request: Request) {
  try {
    await requireCustomerContext();
    const gapId = new URL(request.url).searchParams.get("gap_id") ?? "";
    const state = await loadState();
    if (!state.gaps.some(gap => gap.id === gapId && !gap.retired)) return NextResponse.json({ error: "Gap not found" }, { status: 404 });
    const placement = (await listPlacements()).find(row => row.gap_id === gapId);
    const references = inspectJudgementReferences(state, [gapId], placement?.suggested_references);
    return NextResponse.json({ references, version: placement?.version ?? null });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
