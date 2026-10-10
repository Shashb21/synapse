import { expansionScopeSchema } from "@/lib/iegp/tactic-expansions";
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
import { setGapMetadata, setGapSettings } from "@/lib/iegp/store";
import {
  addIdeationProposal,
  decideIdeationProposal,
  editIdeationProposal,
  listIdeationProposals,
  restoreIdeationProposal,
  type ProposalFields,
} from "@/modules/stages/s9-ideation/module";
import { gapTimelineView } from "@/modules/stages/s10-timeline/gap-view";
import { loadState } from "@/lib/iegp/store";
import {decideTacticSuggestion, editTacticSuggestion, listTacticSuggestions} from "@/modules/stages/s3-tactic-extract/suggestions";
import { setExpansionStatus } from "@/lib/iegp/tactic-expansions";
import { TACTIC_STATUSES, TACTIC_TYPES } from "@/lib/iegp/enums";
import { field, fieldLabel, optionalMonths, optionalScore } from "./field-errors";
import {
  acceptTimelineEstimates,
  addTimelineActivity,
  createTimelineActivity,
  latestPlan,
  planHistory,
  removeTimelineActivity,
  reviewTimelineDependency,
  savePlan,
  setTimelineDependencies,
  timelineModel,
  updateTimelineActivity,
} from "@/modules/stages/s10-timeline/module";
import { planIssues } from "@/modules/stages/s10-timeline/plan-checks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireCustomerContext();
  } catch (error) {
    return apiErrorResponse(error);
  }
  const [placements, axes, proposals, timeline, plan, history, state, tactic_suggestions] = await Promise.all([
    listPlacements(),
    loadAxes(),
    listIdeationProposals(),
    timelineModel(),
    latestPlan(),
    planHistory(5),
    loadState(),
    listTacticSuggestions(),
  ]);
  // The gap-grouped view the /timeline page draws (KAN-25).
  const timeline_view = gapTimelineView({ model: timeline, state, placements });
  // What must be resolved before a final save (KAN-85).
  const timeline_issues = planIssues(timeline);
  return NextResponse.json({ placements, axes, proposals, timeline, timeline_view, timeline_issues, plan, history, tactic_suggestions });
}

const bandSchema = z.enum(["high", "medium", "low", "defer"]);
const decisionSchema = z.enum(["accept", "reject"]);
const planStatusSchema = z.enum(["draft", "final"]);
const laneSchema = z.enum(["high", "medium", "low", "unprioritized", "addressed"]);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be a date (YYYY-MM-DD)");
const tacticTypeSchema = z.enum(TACTIC_TYPES);

/** An optional YYYY-MM-DD: absent stays undefined, empty is null. */
function optionalDate(value: unknown, name: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  return field(dateSchema, value, name);
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
  if (body.proposal_kind !== undefined) fields.proposal_kind = field(z.enum(["new", "expansion"]), body.proposal_kind, "proposal_kind");
  if (body.target_tactic_id !== undefined) fields.target_tactic_id = field(z.string().trim().min(1).nullable(), body.target_tactic_id, "target_tactic_id");
  if (body.expansion_scope !== undefined) fields.expansion_scope = field(expansionScopeSchema, body.expansion_scope, "expansion_scope");
  if (body.comparative_rationale !== undefined) fields.comparative_rationale = field(z.string(), body.comparative_rationale, "comparative_rationale");
  for (const key of PROPOSAL_TEXT_FIELDS) {
    if (body[key] !== undefined && body[key] !== null) fields[key] = String(body[key]);
  }
  if (Object.keys(body).some(key => key.startsWith("expansion_")) && body.expansion_scope === undefined) {
    const raw = Object.fromEntries(["name","evidence_question","population","outcomes","geography","data_cut","analysis","instrument","study_design","gap_coverage","cost_effort","timing","feasibility_risks","post_hoc","prospective_enrolment","protocol_amendment","start_date","evidence_available"].map(key => {
      const value = body[`expansion_${key}`];
      if (["post_hoc","prospective_enrolment","protocol_amendment"].includes(key)) return [key,field(z.enum(["true","false"]),value,`expansion_${key}`) === "true"];
      return [key,["start_date","evidence_available"].includes(key) && value === "" ? null : value];
    }));
    fields.expansion_scope = field(expansionScopeSchema,raw,"expansion_scope");
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
      case "decide_tactic_suggestion": {
        assertCan(identity.role, "validate");
        const suggestion = await decideTacticSuggestion({id: field(z.string().trim().min(1), body.suggestion_id, "suggestion_id"), decision: field(z.enum(["expand", "separate", "reject"]), body.decision, "decision"), expected_version: field(z.string().trim().min(1), body.expected_version, "expected_version"), rationale, actor: identity.actor});
        return NextResponse.json({ok: true, suggestion});
      }
      case "edit_tactic_suggestion": {
        assertCan(identity.role, "validate");
        const id = field(z.string().trim().min(1), body.suggestion_id, "suggestion_id");
        const row = (await listTacticSuggestions()).find(r => r.id === id);
        if (!row) throw new Error("Tactic suggestion not found in this workspace.");
        const option = field(z.enum(["expansion", "separate"]), body.option, "option");
        const expansion = {...row.expansion};
        const separate = {...row.separate};
        if (option === "expansion") {
          for (const key of ["name", "evidence_question", "population", "outcomes", "geography", "data_cut", "analysis", "instrument", "study_design", "gap_coverage", "cost_effort", "timing", "feasibility_risks"] as const) {
            if (body[key] !== undefined) expansion[key] = field(z.string(), body[key], key);
          }
          for (const key of ["start_date", "evidence_available"] as const) if (body[key] !== undefined) expansion[key] = body[key] === null ? null : field(z.string(), body[key], key).trim() || null;
          for (const key of ["post_hoc", "prospective_enrolment", "protocol_amendment"] as const) if (body[key] !== undefined) expansion[key] = field(z.enum(["yes", "no"]), body[key], key) === "yes";
        } else {
          for (const key of ["name", "evidence_question"] as const) if (body[key] !== undefined) separate[key] = field(z.string(), body[key], key);
        }
        const suggestion = await editTacticSuggestion({id, expansion: option === "expansion" ? expansion : undefined, separate: option === "separate" ? separate : undefined,
          gap_id: body.gap_id === undefined ? undefined : field(z.string(), body.gap_id, "gap_id"), expected_version: field(z.string().trim().min(1), body.expected_version, "expected_version"), rationale, actor: identity.actor});
        return NextResponse.json({ok: true, suggestion});
      }

      case "set_expansion_status": {
        assertCan(identity.role, "validate");
        const expansion = await setExpansionStatus({
          expansion_id: field(z.string().trim().min(1), body.expansion_id, "expansion_id"),
          status: field(z.enum(TACTIC_STATUSES), body.status, "status"),
          expected_version: field(z.string().trim().min(1), body.expected_version, "expected_version"),
          rationale, actor: identity.actor,
        });
        return NextResponse.json({ok: true, expansion});
      }
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
        // Errors name a score by its axis ("Payer / HTA relevance score …"), not the request field.
        const catalog = await loadAxes();
        const scoreLabel = (axisId: string | undefined, fallback: string) => {
          const axis = catalog.axes.find((candidate) => candidate.id === axisId);
          return axis ? `${axis.label} score` : fallback;
        };
        const axis_scores: Record<string, number> = {};
        if (body.axis_scores && typeof body.axis_scores === "object") {
          for (const [id, value] of Object.entries(body.axis_scores as Record<string, unknown>)) {
            const score = optionalScore(value, scoreLabel(id, `${fieldLabel(id)} score`));
            if (score !== undefined) axis_scores[id] = score;
          }
        }
        const xScore = optionalScore(body.x_score, scoreLabel(xAxis, fieldLabel("x_score")));
        const yScore = optionalScore(body.y_score, scoreLabel(yAxis, fieldLabel("y_score")));
        if (xScore !== undefined) {
          if (!xAxis) throw new Error("Pick the horizontal axis before scoring it.");
          axis_scores[xAxis] = xScore;
        }
        if (yScore !== undefined) {
          if (!yAxis) throw new Error("Pick the vertical axis before scoring it.");
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
      case "set_gap_metadata": {
        assertCan(identity.role, "validate");
        const metadata = await setGapMetadata({
          gap_id: String(body.gap_id ?? ""),
          // A metadata object, or the flat fields a dialog form posts (stakeholders comma-separated).
          metadata:
            body.metadata && typeof body.metadata === "object"
              ? body.metadata
              : {
                  stakeholders: String(body.stakeholders ?? "").split(/[,\n]/),
                  geography: body.geography,
                  regional_nuances: body.regional_nuances,
                  notes: body.notes,
                },
          actor_name: identity.actor.name,
          actor_function: identity.actor.function,
        });
        return NextResponse.json({ ok: true, metadata });
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
      case "restore_proposal": {
        assertCan(identity.role, "ideate");
        const proposal = await restoreIdeationProposal({
          id: String(body.id ?? ""),
          rationale,
          actor: identity.actor,
          workspace_id: identity.workspace?.id,
        });
        return NextResponse.json({ ok: true, proposal });
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
          activity_id: body.activity_id ? field(z.string().trim().min(1), body.activity_id, "activity_id") : undefined,
          expansion_id: body.expansion_id ? field(z.string().trim().min(1), body.expansion_id, "expansion_id") : undefined,
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
      case "review_dependency": {
        // A model's proposed dependency: accept it (it then gates the schedule) or reject it for good.
        assertCan(identity.role, "validate");
        const activity = await reviewTimelineDependency({
          id: String(body.id ?? ""),
          upstream_id: field(z.string().trim().min(1), body.upstream_id, "upstream_id"),
          decision: field(decisionSchema, body.decision, "decision"),
          rationale,
          actor: identity.actor,
          workspace_id: identity.workspace?.id,
        });
        return NextResponse.json({ ok: true, activity });
      }
      case "accept_estimates": {
        // A model's date estimates become the person's own; with no ids, every one left.
        assertCan(identity.role, "validate");
        const ids = body.id ? [String(body.id)] : field(z.array(z.string()), body.ids ?? [], "ids");
        const result = await acceptTimelineEstimates({ ids, rationale, actor: identity.actor, workspace_id: identity.workspace?.id });
        return NextResponse.json({ ok: true, ...result });
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
