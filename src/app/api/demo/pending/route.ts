import { NextResponse } from "next/server";
import "@/modules";
import { apiErrorResponse, requireCustomerContext } from "@/modules/auth/api-guard";
import { isDemoModeWorkspace } from "@/lib/demo/mode";
import { displayedGapStatus, isLiveGap } from "@/lib/iegp/engine";
import { loadState } from "@/lib/iegp/store";
import { listPlacements } from "@/modules/stages/s8-prioritization/module";
import { listIdeationProposals } from "@/modules/stages/s9-ideation/module";
import { timelineModel } from "@/modules/stages/s10-timeline/module";
import { planIssues } from "@/modules/stages/s10-timeline/plan-checks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What each walkthrough step still waits on, for "Accept all as in demo"
 * (KAN-138). Client-demo workspaces only: the shortcut then makes the same
 * calls a presenter's clicks would.
 */
export async function GET() {
  try {
    await requireCustomerContext();
    if (!(await isDemoModeWorkspace())) {
      return NextResponse.json({ error: "Only a client-demo workspace has demo shortcuts.", code: "not_demo" }, { status: 403 });
    }
    const [state, placements, proposals, timeline] = await Promise.all([
      loadState(),
      listPlacements(),
      listIdeationProposals(),
      timelineModel(),
    ]);
    const live = state.gaps.filter(isLiveGap);
    return NextResponse.json(
      {
        gaps: {
          partial: live
            .filter((gap) => displayedGapStatus(gap) === "validated_partial")
            .map((gap) => ({ id: gap.id, name: gap.name, statement: gap.statement })),
          unvalidated: live
            .filter((gap) => !gap.human_validated && ["validated_open", "validated_addressed"].includes(displayedGapStatus(gap)))
            .map((gap) => gap.id),
          wizard_complete: state.asset.wizard_complete === true,
          tactics_unlocked: state.asset.tactics_unlocked === true,
        },
        prioritize: {
          suggested: placements
            .filter((p) => !p.validated && p.suggested_band && live.some((gap) => gap.id === p.gap_id))
            .map((p) => ({ gap_id: p.gap_id, band: p.suggested_band })),
        },
        ideation: { proposed: proposals.filter((p) => p.status === "proposed").map((p) => p.id) },
        timeline: {
          dependencies: timeline.activities.flatMap((activity) =>
            (activity.meta.proposed_dependencies ?? []).map((dep) => ({ id: activity.id, upstream_id: dep.id })),
          ),
          estimates: planIssues(timeline).some((issue) => issue.kind === "estimate" || issue.kind === "stale_estimate"),
        },
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
