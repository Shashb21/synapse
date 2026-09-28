import { NextResponse } from "next/server";
import { z } from "zod";
import "@/modules";
import { assertCan } from "@/modules/auth/roles";
import { aiEnabled } from "@/modules/kernel/ai-switch";
import { apiErrorResponse, readJsonBody, requireCustomerContext } from "@/modules/auth/api-guard";
import {
  listPlacements,
  movePlacement,
  setPlacement,
  validatePlacement,
} from "@/modules/stages/s8-prioritization/module";
import { loadAxes, saveScopeAxes } from "@/modules/stages/s8-prioritization/axes";
import { setGapSettings } from "@/lib/iegp/store";
import {
  addIdeationProposal,
  decideIdeationProposal,
  editIdeationProposal,
  listIdeationProposals,
  type ProposalFields,
} from "@/modules/stages/s9-ideation/module";
import { gapTimelineView } from "@/modules/stages/s10-timeline/gap-view";
import { loadState } from "@/lib/iegp/store";
import { TACTIC_TYPES } from "@/lib/iegp/enums";
import {
  addTimelineActivity,
  createTimelineActivity,
  latestPlan,
  planHistory,
  removeTimelineActivity,
  savePlan,
  setTimelineDependencies,
  timelineModel,
  updateTimelineActivity,
} from "@/modules/stages/s10-timeline/module";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireCustomerContext();
  } catch (error) {
    return apiErrorResponse(error);
  }
  const [placements, axes, proposals, timeline, plan, history, state] = await Promise.all([
    listPlacements(),
    loadAxes(),
    listIdeationProposals(),
    timelineModel(),
    latestPlan(),
    planHistory(5),
    loadState(),
  ]);
  // The gap-grouped view the /timeline page draws (KAN-25).
  const timeline_view = gapTimelineView({ model: timeline, state, placements });
  return NextResponse.json({ placements, axes, proposals, timeline, timeline_view, plan, history });
}

const bandSchema = z.enum(["high", "medium", "low"]);
const decisionSchema = z.enum(["accept", "reject"]);
const planStatusSchema = z.enum(["draft", "final"]);
const laneSchema = z.enum(["high", "medium", "low", "unprioritized", "addressed"]);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
const tacticTypeSchema = z.enum(TACTIC_TYPES);

/** An optional YYYY-MM-DD: absent stays undefined, empty is null. */
function optionalDate(value: unknown, name: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  return field(dateSchema, value, name);
}

/** Rejects an unknown value with the field name, so the dialog can show why. */
function field<T>(schema: z.ZodType<T>, value: unknown, name: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`${name}: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
  }
  return parsed.data;
}

/** An optional 0–100 score: empty or absent is "not given". */
function optionalScore(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null || String(value).trim() === "") return undefined;
  const score = Number(value);
  if (!Number.isFinite(score) || score < 0 || score > 100) throw new Error(`${name}: expected a number from 0 to 100`);
  return score;
}

/** Months for an idea's timing: empty is null (left for S10), absent is unchanged. */
function optionalMonths(value: unknown, name: string): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || String(value).trim() === "") return null;
  const months = Number(value);
  if (!Number.isFinite(months)) throw new Error(`${name}: expected a number of months`);
  return months;
}

const PROPOSAL_TEXT_FIELDS = [
  "name",
  "type",
  "evidence_question",
  "idea_rationale",
  "population",
  "comparator",
  "outcomes",
  "data_source",
  "study_design",
  "timing_rationale",
] as const;

/** The idea fields present on the request; absent ones are left as they are. */
function proposalFieldsOf(body: Record<string, unknown>): ProposalFields {
  const fields: ProposalFields = {};
  for (const key of PROPOSAL_TEXT_FIELDS) {
    if (body[key] !== undefined && body[key] !== null) fields[key] = String(body[key]);
  }
  const duration = optionalMonths(body.duration_months, "duration_months");
  if (duration !== undefined) fields.duration_months = duration;
  const lag = optionalMonths(body.readout_lag_months, "readout_lag_months");
  if (lag !== undefined) fields.readout_lag_months = lag;
  return fields;
}

export async function POST(request: Request) {
  try {
    const body = await readJsonBody(request);
    const action = String(body.action ?? "");
    // The actor is the signed-in person; each action checks its own capability.
    const identity = await requireCustomerContext({ body });
    const rationale = String(body.rationale ?? body.note ?? "").trim();
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
      case "set_placement": {
        assertCan(identity.role, "prioritize");
        const xAxis = String(body.x_axis ?? "").trim() || undefined;
        const yAxis = String(body.y_axis ?? "").trim() || undefined;
        const axis_scores: Record<string, number> = {};
        if (body.axis_scores && typeof body.axis_scores === "object") {
          for (const [id, value] of Object.entries(body.axis_scores as Record<string, unknown>)) {
            const score = optionalScore(value, id);
            if (score !== undefined) axis_scores[id] = score;
          }
        }
        const xScore = optionalScore(body.x_score, "x_score");
        const yScore = optionalScore(body.y_score, "y_score");
        if (xScore !== undefined) {
          if (!xAxis) throw new Error("x_score needs x_axis");
          axis_scores[xAxis] = xScore;
        }
        if (yScore !== undefined) {
          if (!yAxis) throw new Error("y_score needs y_axis");
          axis_scores[yAxis] = yScore;
        }
        const placement = await setPlacement({
          gap_id: String(body.gap_id ?? ""),
          axis_scores,
          x_axis: xAxis,
          y_axis: yAxis,
          band: body.band ? field(bandSchema, body.band, "band") : undefined,
          validate: body.validate === true || body.validate === "yes" || body.validate === "true",
          rationale,
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
          fields: proposalFieldsOf(body),
        });
        return NextResponse.json({ ok: true, ...result });
      }
      case "edit_proposal": {
        assertCan(identity.role, "ideate");
        const proposal = await editIdeationProposal({
          id: String(body.id ?? ""),
          fields: proposalFieldsOf(body),
          rationale,
          actor: identity.actor,
        });
        return NextResponse.json({ ok: true, proposal });
      }
      case "add_proposal": {
        assertCan(identity.role, "ideate");
        const fields = proposalFieldsOf(body);
        const proposal = await addIdeationProposal({
          gap_id: String(body.gap_id ?? ""),
          fields: {
            ...fields,
            name: fields.name ?? "",
            type: fields.type ?? "",
            evidence_question: fields.evidence_question ?? "",
          },
          rationale,
          actor: identity.actor,
        });
        return NextResponse.json({ ok: true, proposal });
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
          // "band" hands the lane back to the validated band.
          lane: body.lane ? field(laneSchema.or(z.literal("band")), body.lane, "lane") : undefined,
          schedule_rationale:
            body.schedule_rationale === undefined ? undefined : String(body.schedule_rationale ?? ""),
          rationale,
          actor: identity.actor,
          workspace_id: identity.workspace?.id,
        });
        return NextResponse.json({ ok: true, activity: next });
      }
      case "add_activity": {
        assertCan(identity.role, "validate");
        const activity = await addTimelineActivity({
          tactic_id: String(body.tactic_id ?? ""),
          start_date: body.start_date ? field(dateSchema, body.start_date, "start_date") : undefined,
          end_date: body.end_date ? field(dateSchema, body.end_date, "end_date") : undefined,
          readout_date:
            body.readout_date === undefined
              ? undefined
              : body.readout_date
                ? field(dateSchema, body.readout_date, "readout_date")
                : null,
          lane: body.lane ? field(laneSchema, body.lane, "lane") : undefined,
          schedule_rationale: body.schedule_rationale ? String(body.schedule_rationale) : undefined,
          rationale,
          actor: identity.actor,
          workspace_id: identity.workspace?.id,
        });
        return NextResponse.json({ ok: true, activity });
      }
      case "create_activity": {
        // A new tactic under a gap, made from the timeline: an edit and an idea.
        assertCan(identity.role, "validate");
        assertCan(identity.role, "ideate");
        const created = await createTimelineActivity({
          gap_id: String(body.gap_id ?? ""),
          name: String(body.name ?? ""),
          type: field(tacticTypeSchema, body.type, "type"),
          evidence_question: String(body.evidence_question ?? ""),
          start_date: optionalDate(body.start_date, "start_date") ?? undefined,
          end_date: optionalDate(body.end_date, "end_date") ?? undefined,
          readout_date: optionalDate(body.readout_date, "readout_date") ?? null,
          schedule_rationale: body.schedule_rationale ? String(body.schedule_rationale) : null,
          rationale,
          actor: identity.actor,
          workspace_id: identity.workspace?.id,
        });
        return NextResponse.json({ ok: true, ...created });
      }
      case "remove_activity": {
        assertCan(identity.role, "validate");
        const removed = await removeTimelineActivity({ id: String(body.id ?? ""), rationale, actor: identity.actor, workspace_id: identity.workspace?.id });
        return NextResponse.json({ ok: true, ...removed });
      }
      case "set_dependencies": {
        assertCan(identity.role, "validate");
        const dependsOn = field(z.array(z.string()), body.depends_on ?? [], "depends_on");
        const reasons = field(z.record(z.string(), z.string()), body.reasons ?? {}, "reasons");
        const activity = await setTimelineDependencies({
          id: String(body.id ?? ""),
          depends_on: dependsOn,
          reasons,
          rationale,
          actor: identity.actor,
          workspace_id: identity.workspace?.id,
        });
        return NextResponse.json({ ok: true, activity });
      }
      case "save_plan": {
        const status = field(planStatusSchema, body.status ?? "draft", "status");
        // A draft is an edit to the plan; only Medical Affairs saves it as final.
        assertCan(identity.role, status === "final" ? "save_final" : "validate");
        try {
          const plan = await savePlan({ status, note: rationale, actor: identity.actor, workspace_id: identity.workspace?.id });
          return NextResponse.json({ ok: true, plan });
        } catch (error) {
          // With AI off nothing rebuilds or estimates: the remedy is by hand.
          const message = error instanceof Error ? error.message : "";
          if (/Rebuild the timeline before saving/.test(message) && !(await aiEnabled().catch(() => true))) {
            throw new Error(
              message.replace(
                /Rebuild the timeline before saving it as final\.?/,
                "Date them by hand or remove them before saving it as final.",
              ),
            );
          }
          throw error;
        }
      }
      default:
        return NextResponse.json({ error: `Unknown action ${action}` }, { status: 400 });
    }
  } catch (error) {
    return apiErrorResponse(error, "Plan action failed");
  }
}
