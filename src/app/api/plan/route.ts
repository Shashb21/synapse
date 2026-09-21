import { NextResponse } from "next/server";
import "@/modules";
import { assertCan } from "@/modules/auth/roles";
import { requestIdentity } from "@/modules/auth/request";
import { listPlacements, validatePlacement } from "@/modules/stages/s8-prioritization/module";
import { loadAxes } from "@/modules/stages/s8-prioritization/axes";
import { decideIdeationProposal, listIdeationProposals } from "@/modules/stages/s9-ideation/module";
import {
  latestPlan,
  planHistory,
  savePlan,
  timelineModel,
  updateTimelineActivity,
} from "@/modules/stages/s10-timeline/module";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const [placements, axes, proposals, timeline, plan, history] = await Promise.all([
    listPlacements(),
    loadAxes(),
    listIdeationProposals(),
    timelineModel(),
    latestPlan(),
    planHistory(5),
  ]);
  return NextResponse.json({ placements, axes, proposals, timeline, plan, history });
}

export async function POST(request: Request) {
  const body = (await request.json()) as Record<string, unknown>;
  const action = String(body.action ?? "");
  const identity = await requestIdentity(body);
  const rationale = String(body.rationale ?? body.note ?? "").trim();

  try {
    switch (action) {
      case "validate_band": {
        assertCan(identity.role, "prioritize");
        const placement = await validatePlacement({
          gap_id: String(body.gap_id ?? ""),
          band: body.band as "high" | "medium" | "low",
          rationale,
          actor: identity.actor,
        });
        return NextResponse.json({ ok: true, placement });
      }
      case "decide_proposal": {
        assertCan(identity.role, "ideate");
        const result = await decideIdeationProposal({
          id: String(body.id ?? ""),
          decision: body.decision === "reject" ? "reject" : "accept",
          rationale,
          actor: identity.actor,
        });
        return NextResponse.json({ ok: true, ...result });
      }
      case "move_activity": {
        assertCan(identity.role, "validate");
        const next = await updateTimelineActivity({
          id: String(body.id ?? ""),
          start_date: body.start_date ? String(body.start_date) : undefined,
          end_date: body.end_date ? String(body.end_date) : undefined,
          readout_date:
            body.readout_date === undefined ? undefined : body.readout_date ? String(body.readout_date) : null,
          lane: body.lane ? String(body.lane) : undefined,
          rationale,
          actor: identity.actor,
        });
        return NextResponse.json({ ok: true, activity: next });
      }
      case "save_plan": {
        const status = body.status === "final" ? "final" : "draft";
        assertCan(identity.role, status === "final" ? "save_final" : "export");
        const plan = await savePlan({ status, note: rationale, actor: identity.actor });
        return NextResponse.json({ ok: true, plan });
      }
      default:
        return NextResponse.json({ error: `Unknown action ${action}` }, { status: 400 });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Plan action failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
