import { NextResponse } from "next/server";
import {
  acceptMapping,
  acceptResidualGap,
  assignTacticToGap,
  clearGapStatusOverride,
  completeWizard,
  saveProductSetup,
  createAddressedGap,
  createGap,
  createProposedTactic,
  recordMissedTactic,
  ingestDemoSource,
  ingestNeedFromText,
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
  rejectMapping,
  rejectResidualGap,
  resetSeed,
  overrideGapStatus,
  rewritePartialGap,
  splitPartialGap,
  unlockTacticsStage,
  validateGap,
} from "@/lib/iegp/store";
import type { ActorFunction, EvidenceDomain } from "@/lib/iegp/enums";
import type { CoverageDimension } from "@/lib/iegp/enums";
import { resetWorkspaceModules } from "@/modules/kernel/db";
import { recordEdit, type EditAction } from "@/modules/kernel/edit-records";
import type { StageId } from "@/modules/kernel/contracts";

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
  modify_gap: { stage: "S5", entity: "gap", field: "statement", action: "edit" },
  assign_tactic: { stage: "S5", entity: "gap", field: "mapping", action: "accept" },
  accept_mapping: { stage: "S5", entity: "gap", field: "mapping", action: "accept" },
  reject_mapping: { stage: "S5", entity: "gap", field: "mapping", action: "reject" },
  lock_dimension: { stage: "S5", entity: "coverage", field: "dimension", action: "edit" },
  lock_overall: { stage: "S5", entity: "coverage", field: "overall", action: "edit" },
  split_partial_gap: { stage: "S6", entity: "gap", field: "split", action: "split" },
  rewrite_partial_gap: { stage: "S6", entity: "gap", field: "statement", action: "edit" },
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
          note: body.note,
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
      case "lock_dimension":
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
      case "assign_tactic":
        await assignTacticToGap({
          gap_id: body.gap_id,
          tactic_id: body.tactic_id,
          actor_name,
          actor_function,
          note: body.note,
        });
        break;
      case "accept_mapping":
        await acceptMapping({
          gap_id: body.gap_id,
          tactic_id: body.tactic_id,
          actor_name,
          actor_function,
          note: body.note,
        });
        break;
      case "reject_mapping":
        await rejectMapping({
          gap_id: body.gap_id,
          tactic_id: body.tactic_id,
          actor_name,
          actor_function,
          note: body.note,
        });
        break;
      case "accept_residual_gap":
        await acceptResidualGap({
          parent_gap_id: body.parent_gap_id,
          statement: body.statement || undefined,
          actor_name,
          actor_function,
          note: body.note,
        });
        break;
      case "reject_residual_gap":
        await rejectResidualGap({
          parent_gap_id: body.parent_gap_id,
          actor_name,
          actor_function,
          note: body.note,
        });
        break;
      case "modify_residual_gap":
        await modifyResidualGap({
          parent_gap_id: body.parent_gap_id,
          statement: body.statement,
          actor_name,
          actor_function,
          note: body.note,
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
          name: body.name,
          statement: body.statement,
          actor_name,
          actor_function,
          note: body.note,
        });
        break;
      case "lock_tactic_review":
        await lockTacticReview({
          tactic_id: body.tactic_id,
          review_status: body.review_status as "accepted" | "rejected",
          actor_name,
          actor_function,
          note: body.note,
        });
        break;
      case "modify_tactic":
        await modifyTactic({
          tactic_id: body.tactic_id,
          name: body.name,
          evidence_question: body.evidence_question,
          actor_name,
          actor_function,
          note: body.note,
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
          mark_complete: body.mark_complete === "true" || body.mark_complete === true,
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
      case "ingest":
        await ingestNeedFromText({
          title: body.title,
          source_type: body.source_type as never,
          stakeholder_function: body.stakeholder_function as ActorFunction,
          text: body.text,
          actor_name,
          actor_function,
        });
        break;
      case "ingest_demo":
        await ingestDemoSource({
          demo_id: body.demo_id,
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
