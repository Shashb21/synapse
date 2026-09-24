import { NextResponse } from "next/server";
import {
  acceptMapping,
  acceptResidualGap,
  assignGapToBreakoutGroup,
  assignTacticToGap,
  clearGapStatusOverride,
  completeWizard,
  saveProductSetup,
  createAddressedGap,
  createBreakoutGroup,
  createGap,
  createProposedTactic,
  deleteBreakoutGroup,
  createNeed,
  editNeed,
  moveNeedToGap,
  unlinkNeedFromGap,
  TACTIC_EDIT_FIELDS,
  recordMissedTactic,
  lockCoverageDimension,
  lockCoverageOverall,
  confirmCoverageReview,
  lockGapStatus,
  lockNeed,
  lockPriority,
  lockResidual,
  lockRoadmapItem,
  lockTactic,
  lockTacticReview,
  modifyGap,
  modifyTactic,
  modifyResidualGap,
  parkGap,
  unparkGap,
  rejectMapping,
  rejectResidualGap,
  requireMappingRowStatus,
  resetSeed,
  saveMappingTableRow,
  overrideGapStatus,
  rewritePartialGap,
  splitPartialGap,
  unassignGapFromBreakoutGroup,
  unassignTacticFromGap,
  unlockTacticsStage,
  validateGap,
} from "@/lib/iegp/store";
import type { ActorFunction, EvidenceDomain } from "@/lib/iegp/enums";
import { COVERAGE_DIMENSIONS, type CoverageDimension, type DimensionValue, type OverallCoverage } from "@/lib/iegp/enums";
import { resetWorkspaceModules } from "@/modules/kernel/db";
import { recordEdit, requireRationale, type EditAction } from "@/modules/kernel/edit-records";
import type { StageId } from "@/modules/kernel/contracts";
import { requestIdentity } from "@/modules/auth/request";
import type { SourceType } from "@/lib/iegp/enums";
import { ingestThroughStages } from "./ingest-pipeline";
import { promoteGapCandidate, promoteTacticCandidate } from "./promote-candidates";

export const runtime = "nodejs";

function idList(...values: (string | undefined)[]): string[] {
  return [
    ...new Set(
      values
        .flatMap((value) => (value || "").split(","))
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  ];
}

const RATIONALE_REQUIRED = "A short rationale is required for every edit.";

function rationaleOf(body: Record<string, string>): string {
  return (body.rationale || body.note || "").trim();
}

/**
 * A person's coverage verdict sent with a mapping: `overall` plus dimensions as
 * `dim_<dimension>` fields or a `dimensions` object (or its JSON). Blank values
 * are left out, so an unset dimension stays "unknown".
 */
function coverageInput(body: Record<string, unknown>): {
  coverage?: OverallCoverage;
  dimensions?: Partial<Record<CoverageDimension, DimensionValue>>;
} {
  const overall =
    typeof body.overall === "string" && body.overall.trim() ? (body.overall.trim() as OverallCoverage) : undefined;
  let raw: unknown = body.dimensions;
  if (typeof raw === "string") raw = raw.trim() ? JSON.parse(raw) : undefined;
  const dimensions: Partial<Record<CoverageDimension, DimensionValue>> = {};
  if (raw && typeof raw === "object") {
    for (const [dim, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === "string" && value) dimensions[dim as CoverageDimension] = value as DimensionValue;
    }
  }
  for (const dim of COVERAGE_DIMENSIONS) {
    const value = body[`dim_${dim}`];
    if (typeof value === "string" && value) dimensions[dim] = value as DimensionValue;
  }
  return {
    coverage: overall,
    dimensions: Object.keys(dimensions).length ? dimensions : undefined,
  };
}

/**
 * Gate actions on the legacy workbench that carry a user judgement. When the
 * user gave a reason, it is filed as an edit record so the same rationale reaches
 * hillclimb from this surface too.
 */
const GATE_EDITS: Record<string, { stage: StageId; entity: string; field: string; action: EditAction }> = {
  classify_gap: { stage: "S5", entity: "gap", field: "computed_status", action: "override" },
  override_gap_status: { stage: "S5", entity: "gap", field: "computed_status", action: "override" },
  clear_gap_status_override: { stage: "S5", entity: "gap", field: "computed_status", action: "edit" },
  validate_gap: { stage: "S5", entity: "gap", field: "human_validated", action: "validate" },
  // modify_gap, modify_tactic, need edits, leftover decisions and promotions file
  // their own edit records (with before/after) in the store.
  assign_tactic: { stage: "S5", entity: "gap", field: "mapping", action: "accept" },
  accept_mapping: { stage: "S5", entity: "gap", field: "mapping", action: "accept" },
  reject_mapping: { stage: "S5", entity: "gap", field: "mapping", action: "reject" },
  unassign_tactic: { stage: "S5", entity: "gap", field: "mapping", action: "reject" },
  save_mapping_row: { stage: "S4", entity: "gap", field: "mapping_table_row", action: "edit" },
  lock_dimension: { stage: "S5", entity: "coverage", field: "dimension", action: "edit" },
  lock_overall: { stage: "S5", entity: "coverage", field: "overall", action: "edit" },
  split_partial_gap: { stage: "S6", entity: "gap", field: "split", action: "split" },
  rewrite_partial_gap: { stage: "S6", entity: "gap", field: "statement", action: "edit" },
  park_gap: { stage: "S5", entity: "gap", field: "parked_at", action: "edit" },
  unpark_gap: { stage: "S5", entity: "gap", field: "parked_at", action: "edit" },
  lock_priority: { stage: "S8", entity: "residual", field: "priority_band", action: "edit" },
  create_tactic: { stage: "S9", entity: "tactic", field: "created", action: "add" },
  record_missed_tactic: { stage: "S5", entity: "tactic", field: "created", action: "add" },
};

async function fileGateEdit(body: Record<string, string>, actor_name: string, actor_function: ActorFunction) {
  const mapping = GATE_EDITS[body.action ?? ""];
  if (!mapping) return;
  const rationale = (body.rationale || body.reason || body.note || body.override_reason || "").trim();
  if (rationale.length < 3) return;
  const entity_id =
    body.gap_id || body.parent_gap_id || body.coverage_id || body.tactic_id || body.residual_id || "—";
  await recordEdit({
    stage: mapping.stage,
    entity_type: mapping.entity,
    entity_id,
    field: mapping.field,
    action: mapping.action,
    before: null,
    after: body.status || body.band || body.value || body.overall || null,
    rationale,
    actor: { name: actor_name, function: actor_function },
  });
}

export async function POST(request: Request) {
  const body = (await request.json()) as Record<string, string>;
  const actor_name = body.actor_name?.trim();
  const actor_function = body.actor_function as ActorFunction;
  if (!actor_name || !actor_function) {
    return NextResponse.json({ error: "Name and function are required." }, { status: 400 });
  }
  try {
    switch (body.action) {
      case "reset":
        await resetSeed();
        await resetWorkspaceModules();
        break;
      case "lock_need":
        await lockNeed({
          need_id: body.need_id,
          status: body.status as "accepted" | "rejected",
          gap_id: body.gap_id || undefined,
          actor_name,
          actor_function,
          note: rationaleOf(body),
        });
        break;
      case "create_need":
        await createNeed({
          gap_id: body.gap_id,
          statement: body.statement,
          source_quote: body.source_quote,
          source_id: body.source_id || undefined,
          rationale: rationaleOf(body),
          actor_name,
          actor_function,
        });
        break;
      case "edit_need":
        await editNeed({
          need_id: body.need_id,
          statement: typeof body.statement === "string" ? body.statement : undefined,
          source_quote: typeof body.source_quote === "string" ? body.source_quote : undefined,
          rationale: rationaleOf(body),
          actor_name,
          actor_function,
        });
        break;
      case "unlink_need":
        await unlinkNeedFromGap({
          need_id: body.need_id,
          gap_id: body.gap_id,
          rationale: rationaleOf(body),
          actor_name,
          actor_function,
        });
        break;
      case "move_need":
        await moveNeedToGap({
          need_id: body.need_id,
          from_gap_id: body.from_gap_id || body.gap_id,
          to_gap_id: body.to_gap_id === "__new__" ? undefined : body.to_gap_id,
          new_gap: body.to_gap_id === "__new__" || body.new_gap === "true",
          new_gap_name: body.new_gap_name,
          rationale: rationaleOf(body),
          actor_name,
          actor_function,
        });
        break;
      case "promote_gap_candidate":
        await promoteGapCandidate({
          candidate_id: body.candidate_id,
          name: body.name,
          statement: body.statement,
          domain: body.domain,
          rationale: rationaleOf(body),
          actor_name,
          actor_function,
        });
        break;
      case "promote_tactic_candidate":
        await promoteTacticCandidate({
          candidate_id: body.candidate_id,
          name: body.name,
          type: body.type,
          status: body.status,
          evidence_question: body.evidence_question,
          gap_id: body.gap_id,
          rationale: rationaleOf(body),
          actor_name,
          actor_function,
        });
        break;
      case "lock_gap":
        await lockGapStatus({
          gap_id: body.gap_id,
          status: body.status as never,
          exclusion_reason: (body.exclusion_reason || undefined) as never,
          exclusion_note: body.exclusion_note,
          actor_name,
          actor_function,
          note: body.note,
        });
        break;
      case "classify_gap":
      case "override_gap_status":
        await overrideGapStatus({
          gap_id: body.gap_id,
          status: body.status as never,
          reason: body.reason || body.note,
          actor_name,
          actor_function,
        });
        break;
      case "clear_gap_status_override":
        await clearGapStatusOverride({
          gap_id: body.gap_id,
          actor_name,
          actor_function,
          note: body.note,
        });
        break;
      case "park_gap":
        await parkGap({
          gap_id: body.gap_id,
          reason: body.reason || body.note,
          actor_name,
          actor_function,
        });
        break;
      case "unpark_gap":
        await unparkGap({
          gap_id: body.gap_id,
          actor_name,
          actor_function,
          note: body.note,
        });
        break;
      case "lock_dimension":
        if (rationaleOf(body).length < 3) {
          return NextResponse.json({ error: RATIONALE_REQUIRED }, { status: 400 });
        }
        await lockCoverageDimension({
          coverage_id: body.coverage_id,
          dimension: body.dimension as CoverageDimension,
          value: body.value as never,
          rationale: body.rationale || body.note || "",
          actor_name,
          actor_function,
        });
        break;
      case "lock_overall":
        if (rationaleOf(body).length < 3) {
          return NextResponse.json({ error: RATIONALE_REQUIRED }, { status: 400 });
        }
        await lockCoverageOverall({
          coverage_id: body.coverage_id,
          overall: body.overall as never,
          rationale: body.rationale || body.note || "",
          actor_name,
          actor_function,
        });
        break;
      case "confirm_coverage_review":
        await confirmCoverageReview({
          coverage_id: body.coverage_id,
          actor_name,
          actor_function,
          note: body.note,
        });
        break;
      case "lock_residual":
        await lockResidual({
          residual_id: body.residual_id,
          statement: body.statement,
          actor_name,
          actor_function,
          note: body.note,
        });
        break;
      case "lock_priority":
        await lockPriority({
          residual_id: body.residual_id,
          band: body.band as never,
          override_reason: body.note || body.override_reason,
          actor_name,
          actor_function,
        });
        break;
      case "create_tactic":
        if (body.origin === "gaps") {
          await recordMissedTactic({
            name: body.name,
            type: body.type as never,
            description: body.description,
            evidence_question: body.evidence_question,
            population: body.population,
            intervention: body.intervention,
            comparator: body.comparator,
            outcomes: body.outcomes,
            geography: body.geography,
            study_design: body.study_design,
            data_source: body.data_source,
            owner: body.owner,
            function: body.function as ActorFunction,
            residual_ids: (body.residual_ids || "").split(",").filter(Boolean),
            gap_id: body.gap_id || undefined,
            status: body.status,
            catch_up_reason: body.catch_up_reason,
            actor_name,
            actor_function,
          });
          break;
        }
        await createProposedTactic({
          name: body.name,
          type: body.type as never,
          description: body.description,
          evidence_question: body.evidence_question,
          population: body.population,
          intervention: body.intervention,
          comparator: body.comparator,
          outcomes: body.outcomes,
          geography: body.geography,
          study_design: body.study_design,
          data_source: body.data_source,
          owner: body.owner,
          function: body.function as ActorFunction,
          residual_ids: (body.residual_ids || "").split(",").filter(Boolean),
          gap_id: body.gap_id || undefined,
          actor_name,
          actor_function,
        });
        break;
      case "record_missed_tactic":
        await recordMissedTactic({
          name: body.name,
          type: body.type as never,
          description: body.description,
          evidence_question: body.evidence_question,
          population: body.population,
          intervention: body.intervention,
          comparator: body.comparator,
          outcomes: body.outcomes,
          geography: body.geography,
          study_design: body.study_design,
          data_source: body.data_source,
          owner: body.owner,
          function: body.function as ActorFunction,
          residual_ids: (body.residual_ids || "").split(",").filter(Boolean),
          gap_id: body.gap_id || undefined,
          status: body.status,
          catch_up_reason: body.catch_up_reason,
          actor_name,
          actor_function,
        });
        break;
      case "assign_tactic": {
        // A person's mapping. A coverage verdict set in the same step is theirs and is locked.
        const verdict = coverageInput(body);
        const hasVerdict =
          Boolean(verdict.coverage && verdict.coverage !== "unassessed") || Boolean(verdict.dimensions);
        if (hasVerdict && rationaleOf(body).length < 3) {
          return NextResponse.json({ error: RATIONALE_REQUIRED }, { status: 400 });
        }
        await assignTacticToGap({
          gap_id: body.gap_id,
          tactic_id: body.tactic_id,
          actor_name,
          actor_function,
          note: rationaleOf(body) || undefined,
          ...verdict,
          human: true,
          lock_coverage: true,
        });
        break;
      }
      case "unassign_tactic":
        if (rationaleOf(body).length < 3) {
          return NextResponse.json({ error: RATIONALE_REQUIRED }, { status: 400 });
        }
        await unassignTacticFromGap({
          gap_id: body.gap_id,
          tactic_id: body.tactic_id,
          rationale: rationaleOf(body),
          actor_name,
          actor_function,
        });
        break;
      case "accept_mapping":
        if (rationaleOf(body).length < 3) {
          return NextResponse.json({ error: RATIONALE_REQUIRED }, { status: 400 });
        }
        await acceptMapping({
          gap_id: body.gap_id,
          tactic_id: body.tactic_id,
          actor_name,
          actor_function,
          note: rationaleOf(body),
          ...coverageInput(body),
        });
        break;
      case "reject_mapping":
        if (rationaleOf(body).length < 3) {
          return NextResponse.json({ error: RATIONALE_REQUIRED }, { status: 400 });
        }
        await rejectMapping({
          gap_id: body.gap_id,
          tactic_id: body.tactic_id,
          actor_name,
          actor_function,
          note: rationaleOf(body),
        });
        break;
      case "save_mapping_row": {
        const rationale = rationaleOf(body);
        if (rationale.length < 3) {
          return NextResponse.json({ error: RATIONALE_REQUIRED }, { status: 400 });
        }
        const tactic_ids = (body.tactic_ids || "")
          .split(",")
          .map((id) => id.trim())
          .filter(Boolean);
        const mapping_status = requireMappingRowStatus(body.mapping_status);
        await saveMappingTableRow({
          gap_id: body.gap_id,
          tactic_ids,
          mapping_status,
          actor_name,
          actor_function,
          rationale,
        });
        break;
      }
      case "accept_residual_gap":
        await acceptResidualGap({
          parent_gap_id: body.parent_gap_id,
          statement: body.statement || undefined,
          actor_name,
          actor_function,
          note: requireRationale(rationaleOf(body)),
        });
        break;
      case "reject_residual_gap":
        await rejectResidualGap({
          parent_gap_id: body.parent_gap_id,
          actor_name,
          actor_function,
          note: requireRationale(rationaleOf(body)),
        });
        break;
      case "modify_residual_gap":
        await modifyResidualGap({
          parent_gap_id: body.parent_gap_id,
          statement: body.statement,
          actor_name,
          actor_function,
          note: requireRationale(rationaleOf(body)),
        });
        break;
      case "create_gap":
        await createGap({
          name: body.name,
          statement: body.statement,
          domain: (body.domain || undefined) as EvidenceDomain | undefined,
          actor_name,
          actor_function,
          note: body.note,
        });
        break;
      case "modify_gap":
        await modifyGap({
          gap_id: body.gap_id,
          name: typeof body.name === "string" ? body.name : undefined,
          statement: typeof body.statement === "string" ? body.statement : undefined,
          domain: body.domain || undefined,
          rationale: rationaleOf(body),
          actor_name,
          actor_function,
        });
        break;
      case "lock_tactic_review":
        await lockTacticReview({
          tactic_id: body.tactic_id,
          review_status: body.review_status as "accepted" | "rejected",
          actor_name,
          actor_function,
          note: requireRationale(rationaleOf(body)),
        });
        break;
      case "modify_tactic":
        await modifyTactic({
          tactic_id: body.tactic_id,
          fields: tacticFieldsOf(body),
          rationale: rationaleOf(body),
          actor_name,
          actor_function,
        });
        break;
      case "complete_wizard":
        await completeWizard({
          actor_name,
          actor_function,
          note: body.note,
        });
        break;
      case "save_product_setup": {
        const context = body.context;
        if (!context || typeof context !== "object") {
          return NextResponse.json({ error: "context is required" }, { status: 400 });
        }
        await saveProductSetup({
          context: context as never,
          actor_name,
          actor_function,
          mark_complete: body.mark_complete === "true",
        });
        break;
      }
      case "unlock_tactics":
        await unlockTacticsStage({
          actor_name,
          actor_function,
          note: body.note,
        });
        break;
      case "validate_gap":
        await validateGap({
          gap_id: body.gap_id,
          actor_name,
          actor_function,
          note: body.note,
        });
        break;
      case "split_partial_gap":
        await splitPartialGap({
          parent_gap_id: body.parent_gap_id || body.gap_id,
          addressed_name: body.addressed_name,
          addressed_statement: body.addressed_statement || undefined,
          open_name: body.open_name,
          open_statement: body.open_statement || undefined,
          tactic_id: body.tactic_id || undefined,
          tactic_ids: idList(body.tactic_ids, body.tactic_id),
          open_tactic_ids: idList(body.open_tactic_ids),
          actor_name,
          actor_function,
          note: body.note,
        });
        break;
      case "rewrite_partial_gap":
        await rewritePartialGap({
          gap_id: body.gap_id,
          name: body.name,
          statement: body.statement || undefined,
          status: body.status as "validated_open" | "validated_addressed",
          tactic_id: body.tactic_id || undefined,
          tactic_ids: idList(body.tactic_ids, body.tactic_id),
          actor_name,
          actor_function,
          note: body.note,
        });
        break;
      case "create_addressed_gap":
        await createAddressedGap({
          name: body.name,
          statement: body.statement,
          domain: (body.domain || undefined) as EvidenceDomain | undefined,
          tactic_id: body.tactic_id,
          missed_name: body.tactic_name,
          missed_type: (body.tactic_type || undefined) as never,
          missed_status: body.tactic_status,
          missed_evidence_question: body.tactic_evidence_question,
          catch_up_reason: body.catch_up_reason,
          actor_name,
          actor_function,
          note: body.note,
        });
        break;
      case "lock_tactic":
        await lockTactic({
          tactic_id: body.tactic_id,
          status: body.status as never,
          actor_name,
          actor_function,
          note: body.note,
        });
        break;
      case "lock_roadmap":
        await lockRoadmapItem({
          tactic_id: body.tactic_id,
          residual_ids: (body.residual_ids || "").split(",").filter(Boolean),
          start_date: body.start_date || null,
          evidence_available: body.evidence_available || null,
          owner: body.owner,
          note: body.note,
          actor_name,
          actor_function,
        });
        break;
      // Ingest is the S0→S4 stage pipeline; S2–S4 need a connected LLM and the
      // error says so. There is no rule-based ingest.
      case "ingest": {
        const identity = await requestIdentity(body);
        const title = (body.title || "").trim();
        await ingestThroughStages({
          files: [
            {
              filename: body.filename?.trim() || `${title.replaceAll(" ", "_")}.txt`,
              title,
              source_type: body.source_type as SourceType,
              stakeholder_function: body.stakeholder_function as ActorFunction,
              text: body.text,
            },
          ],
          actor: identity.actor,
          role: identity.role,
        });
        break;
      }
      case "ingest_demo": {
        const identity = await requestIdentity(body);
        await ingestThroughStages({
          demo_ids: [body.demo_id],
          actor: identity.actor,
          role: identity.role,
        });
        break;
      }
      case "create_breakout_group":
        await createBreakoutGroup({
          name: body.name,
          note: body.note,
          actor_name,
          actor_function,
        });
        break;
      case "delete_breakout_group":
        await deleteBreakoutGroup({
          group_id: body.group_id,
          actor_name,
          actor_function,
        });
        break;
      case "assign_gap_to_breakout":
        await assignGapToBreakoutGroup({
          group_id: body.group_id,
          gap_id: body.gap_id,
          actor_name,
          actor_function,
        });
        break;
      case "unassign_gap_from_breakout":
        await unassignGapFromBreakoutGroup({
          group_id: body.group_id,
          gap_id: body.gap_id,
          actor_name,
          actor_function,
        });
        break;
      default:
        return NextResponse.json({ error: `Unknown action ${body.action}` }, { status: 400 });
    }
    await fileGateEdit(body, actor_name, actor_function);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

/** Tactic fields present in the body; a field absent from the form is left unchanged. */
function tacticFieldsOf(body: Record<string, string>) {
  const fields: Partial<Record<(typeof TACTIC_EDIT_FIELDS)[number], string>> = {};
  for (const field of TACTIC_EDIT_FIELDS) {
    if (typeof body[field] === "string") fields[field] = body[field];
  }
  return fields;
}
