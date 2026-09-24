import { NextResponse } from "next/server";
import { z } from "zod";
import "@/modules";
import { assertCan } from "@/modules/auth/roles";
import { requestIdentity } from "@/modules/auth/request";
import {
  listPlacements,
  movePlacement,
  validatePlacement,
} from "@/modules/stages/s8-prioritization/module";
import { loadAxes, saveScopeAxes } from "@/modules/stages/s8-prioritization/axes";
import { setGapSettings } from "@/lib/iegp/store";
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

const bandSchema = z.enum(["high", "medium", "low"]);
const decisionSchema = z.enum(["accept", "reject"]);
const planStatusSchema = z.enum(["draft", "final"]);
const laneSchema = z.enum(["high", "medium", "low", "addressed"]);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

/** Rejects an unknown value with the field name, so the dialog can show why. */
function field<T>(schema: z.ZodType<T>, value: unknown, name: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`${name}: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
  }
  return parsed.data;
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
          band: field(bandSchema, body.band, "band"),
          rationale,
          actor: identity.actor,
        });
        return NextResponse.json({ ok: true, placement });
      }
      case "move_placement": {
        assertCan(identity.role, "prioritize");
        const placement = await movePlacement({
          gap_id: String(body.gap_id ?? ""),
          x_axis: String(body.x_axis ?? ""),
          y_axis: String(body.y_axis ?? ""),
          x: Number(body.x),
          y: Number(body.y),
          actor: identity.actor,
        });
        return NextResponse.json({ ok: true, placement });
      }
      case "save_scope_axes": {
        assertCan(identity.role, "prioritize");
        const axes = await saveScopeAxes({
          scope: String(body.scope ?? "").trim() || "all",
          x_axis: String(body.x_axis ?? ""),
          y_axis: String(body.y_axis ?? ""),
          actor_name: identity.actor.name,
        });
        return NextResponse.json({ ok: true, axes });
      }
      case "set_gap_settings": {
        assertCan(identity.role, "validate");
        const settings = await setGapSettings({
          gap_id: String(body.gap_id ?? ""),
          settings: Array.isArray(body.settings) ? body.settings.map(String) : [],
          actor_name: identity.actor.name,
          actor_function: identity.actor.function,
        });
        return NextResponse.json({ ok: true, settings });
      }
      case "decide_proposal": {
        assertCan(identity.role, "ideate");
        const result = await decideIdeationProposal({
          id: String(body.id ?? ""),
          decision: field(decisionSchema, body.decision, "decision"),
          rationale,
          actor: identity.actor,
        });
        return NextResponse.json({ ok: true, ...result });
      }
      case "move_activity": {
        assertCan(identity.role, "validate");
        const next = await updateTimelineActivity({
          id: String(body.id ?? ""),
          start_date: body.start_date ? field(dateSchema, body.start_date, "start_date") : undefined,
          end_date: body.end_date ? field(dateSchema, body.end_date, "end_date") : undefined,
          readout_date:
            body.readout_date === undefined
              ? undefined
              : body.readout_date
                ? field(dateSchema, body.readout_date, "readout_date")
                : null,
          lane: body.lane ? field(laneSchema, body.lane, "lane") : undefined,
          rationale,
          actor: identity.actor,
        });
        return NextResponse.json({ ok: true, activity: next });
      }
      case "save_plan": {
        const status = field(planStatusSchema, body.status ?? "draft", "status");
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
