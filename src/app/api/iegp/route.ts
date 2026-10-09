import { decidePartialSplit } from "@/modules/stages/s6-partial-split/module";
import type { CustomTacticType } from "@/lib/iegp/custom-tactic-type";
import { BREAKOUT_THEMES, createBreakoutGroupsByTheme, type BreakoutTheme } from "@/lib/iegp/breakout-themes";
import { NextResponse } from "next/server";
import {
  acceptMapping,
  acceptResidualGap,
  assignGapToBreakoutGroup,
  assignTacticToGap,
  clearGapStatusOverride,
  clearNewSourceFlag,
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
  lockTactic,
  lockTacticReview,
  modifyGap,
  modifyTactic,
  customTypeFromFields,
  modifyResidualGap,
  parkGap,
  unparkGap,
  rejectMapping,
  rejectResidualGap,
  requireMappingRowStatus,
  saveMappingTableRow,
  loadState,
  overrideGapStatus,
  rewritePartialGap,
  unassignGapFromBreakoutGroup,
  updateBreakoutGroup,
  assignGapsToBreakoutGroup,
  moveGapToBreakoutGroup,
  unassignTacticFromGap,
  unlockTacticsStage,
  validateGap,
} from "@/lib/iegp/store";
import type { ActorFunction, EvidenceDomain } from "@/lib/iegp/enums";
import { EVIDENCE_DOMAINS } from "@/lib/iegp/enums";
import { COVERAGE_DIMENSIONS, type CoverageDimension, type DimensionValue, type OverallCoverage } from "@/lib/iegp/enums";
import { replaceContents } from "@/modules/workspaces/contents";
import { recordEdit, requireRationale, type EditAction } from "@/modules/kernel/edit-records";
import type { StageId } from "@/modules/kernel/contracts";
import {
  apiErrorResponse,
  readJsonBody,
  requireCapability,
  requireCustomerContext,
  type CustomerContext,
} from "@/modules/auth/api-guard";
import { iegpActionCapability, retiredActionMessage } from "./capabilities";
import { latestS4MappingRows } from "@/lib/iegp/mapping-table";
import { captureMappingRowDecision } from "@/lib/iegp/learning-capture";
import {
  restoreExcludedGap,
  restoreRejectedMapping,
  restoreRejectedNeed,
  restoreRejectedTactic,
} from "@/lib/iegp/restore";
import type { SourceType } from "@/lib/iegp/enums";
import { ingestThroughStages, type IngestPayload } from "./ingest-pipeline";
import { MAX_UPLOAD_BYTES, TOO_LARGE, uploadKindOf } from "@/lib/ingest/upload-formats";
import { promoteGapCandidate, promoteTacticCandidate } from "./promote-candidates";
import {
  acceptGapMergeSuggestion,
  acceptGapSplitSuggestion,
  rejectGapSuggestionKeepingCandidate,
} from "@/modules/stages/s2-gap-extract/suggestions";

export const runtime = "nodejs";

/** Actions that replace the whole workspace: its owner only, on top of the reset_workspace capability. */
const WORKSPACE_OWNER_ACTIONS = new Set(["reset", "load_demo"]);

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
/** A hand-made gap's domain is the person's pick; nothing is assumed (KAN-16). */
const DOMAIN_REQUIRED = "Choose the gap's evidence domain.";
const isEvidenceDomain = (value: unknown): value is EvidenceDomain =>
  typeof value === "string" && (EVIDENCE_DOMAINS as readonly string[]).includes(value);

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
  rewrite_partial_gap: { stage: "S6", entity: "gap", field: "statement", action: "edit" },
  lock_gap: { stage: "S5", entity: "gap", field: "status", action: "edit" },
  park_gap: { stage: "S5", entity: "gap", field: "parked_at", action: "edit" },
  unpark_gap: { stage: "S5", entity: "gap", field: "parked_at", action: "edit" },
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
  let body: Record<string, string>;
  let identity: CustomerContext;
  try {
    body = (await readJsonBody(request)) as Record<string, string>;
    identity = await requireCustomerContext({ body });
    const retired = retiredActionMessage(String(body.action ?? ""));
    if (retired) return NextResponse.json({ error: retired }, { status: 410 });
    const capability = iegpActionCapability(String(body.action ?? ""));
    if (!capability) return NextResponse.json({ error: `Unknown action ${body.action}` }, { status: 400 });
    requireCapability(identity, capability);
    if (WORKSPACE_OWNER_ACTIONS.has(String(body.action)) && identity.workspace && identity.workspace.role !== "owner") {
      return NextResponse.json(
        { error: "Only the workspace owner can replace its contents.", code: "forbidden" },
        { status: 403 },
      );
    }
  } catch (error) {
    return apiErrorResponse(error);
  }
  // The recorded actor is the signed-in person, never the request body (REQ-AUTH-005).
  const actor_name = identity.actor.name;
  const actor_function = identity.actor.function;
  try {
    switch (body.action) {
      case "reset":
        // Reset to blank: empties the plan and clears the workspace's demo flag.
        await replaceContents(identity.workspace?.id ?? null, "blank", identity.actor);
        break;
      case "load_demo":
        // Replaces everything with the Velmara demo and flags the workspace as demo.
        // scope "setup" loads only the demo's asset and objectives (the stage tests' start).
        await replaceContents(identity.workspace?.id ?? null, body.scope === "setup" ? "demo_setup" : "demo", identity.actor);
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
      // KAN-16: undo an exclusion or a rejection. Each needs a rationale, is
      // audited and files its own edit record.
      case "restore_gap":
        await restoreExcludedGap({ gap_id: body.gap_id, rationale: rationaleOf(body), actor_name, actor_function });
        break;
      case "restore_need":
        await restoreRejectedNeed({ need_id: body.need_id, rationale: rationaleOf(body), actor_name, actor_function });
        break;
      case "restore_tactic":
        await restoreRejectedTactic({ tactic_id: body.tactic_id, rationale: rationaleOf(body), actor_name, actor_function });
        break;
      case "restore_mapping":
        await restoreRejectedMapping({
          gap_id: body.gap_id,
          tactic_id: body.tactic_id,
          rationale: rationaleOf(body),
          actor_name,
          actor_function,
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
            custom_type: customTypeOf(body) ?? null,
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
          status: body.status,
          custom_type: customTypeOf(body) ?? null,
          start_date: body.start_date || null,
          evidence_available: body.evidence_available || null,
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
          custom_type: customTypeOf(body) ?? null,
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
        // The model's row for this gap, read before the save, for the learning example (KAN-78).
        const aiRow = (await latestS4MappingRows().catch(() => null))?.find((row) => row.gap_id === body.gap_id) ?? null;
        const mappingDecision = await saveMappingTableRow({
          gap_id: body.gap_id,
          tactic_ids,
          mapping_status,
          actor_name,
          actor_function,
          rationale,
        });
        if (aiRow) {
          const gap = (await loadState().catch(() => null))?.gaps.find((row) => row.id === body.gap_id);
          if (gap) {
            await captureMappingRowDecision({
              gap: { id: gap.id, name: gap.name, statement: gap.statement },
              run_id: aiRow.origin_run_id,
              capture_key: mappingDecision.decision_event_id,
              parent_tactic_ids: mappingDecision.parent_tactic_ids,
              actor: { name: actor_name, function: actor_function },
              ai: { mapping_status: aiRow.mapping_status, tactic_ids: aiRow.tactic_ids },
              saved: { mapping_status, tactic_ids },
              rationale,
            });
          }
        }
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
        if (!isEvidenceDomain(body.domain)) return NextResponse.json({ error: DOMAIN_REQUIRED }, { status: 400 });
        await createGap({
          name: body.name,
          statement: body.statement,
          domain: (body.domain || undefined) as EvidenceDomain | undefined,
          ...gapExtrasOf(body),
          actor_name,
          actor_function,
          note: body.note,
        });
        break;
      // An overlap suggestion from S2 (KAN-75): merge into the gap, split off a new gap, or reject.
      // The person may edit the proposed wording; a blank field keeps the proposal's.
      case "accept_gap_merge":
        await acceptGapMergeSuggestion({
          suggestion_id: body.suggestion_id,
          name: typeof body.name === "string" && body.name.trim() ? body.name : undefined,
          statement: typeof body.statement === "string" && body.statement.trim() ? body.statement : undefined,
          rationale: rationaleOf(body),
          actor_name,
          actor_function,
        });
        break;
      case "accept_gap_split":
        await acceptGapSplitSuggestion({
          suggestion_id: body.suggestion_id,
          name: typeof body.name === "string" && body.name.trim() ? body.name : undefined,
          statement: typeof body.statement === "string" && body.statement.trim() ? body.statement : undefined,
          rationale: rationaleOf(body),
          actor_name,
          actor_function,
        });
        break;
      case "reject_gap_suggestion":
        await rejectGapSuggestionKeepingCandidate({
          suggestion_id: body.suggestion_id,
          rationale: rationaleOf(body),
          actor_name,
          actor_function,
        });
        break;
      case "clear_new_source_flag":
        await clearNewSourceFlag({ gap_id: body.gap_id, rationale: rationaleOf(body), actor_name, actor_function });
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
          custom_type: customTypeOf(body),
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
        // The wizard posts JSON booleans; older callers sent the string "true".
        const saved = await saveProductSetup({
          context: context as never,
          actor_name,
          actor_function,
          mark_complete: String(body.mark_complete) === "true",
        });
        return NextResponse.json({ ok: true, context: saved });
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
      case "reject_split_proposal":
        await decidePartialSplit({ gap_id: body.parent_gap_id || body.gap_id, originating_run_id: body.originating_run_id, decision: "reject", rationale: body.note, actor: identity.actor });
        break;
      case "split_partial_gap":
        await decidePartialSplit({
          gap_id: body.parent_gap_id || body.gap_id,
          originating_run_id: body.originating_run_id || undefined,
          decision: "accept",
          actor: identity.actor,
          apply: {
            addressed_name: body.addressed_name,
            addressed_statement: body.addressed_statement || undefined,
            open_name: body.open_name,
            open_statement: body.open_statement || undefined,
            addressed_tactic_ids: idList(body.tactic_ids, body.tactic_id),
            open_tactic_ids: idList(body.open_tactic_ids),
            rationale: body.note || "",
          },
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
        if (!isEvidenceDomain(body.domain)) return NextResponse.json({ error: DOMAIN_REQUIRED }, { status: 400 });
        await createAddressedGap({
          name: body.name,
          statement: body.statement,
          domain: (body.domain || undefined) as EvidenceDomain | undefined,
          ...gapExtrasOf(body),
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
      // Ingest is the S0→S4 stage pipeline; S2–S4 need a connected LLM and the
      // error says so. There is no rule-based ingest.
      case "ingest": {
        const title = (body.title || "").trim();
        await ingestThroughStages({
          files: [
            {
              title,
              source_type: body.source_type as SourceType,
              stakeholder_function: body.stakeholder_function as ActorFunction,
              ...ingestPayloadOf(body, title),
            },
          ],
          actor: identity.actor,
          role: identity.role,
        });
        break;
      }
      case "ingest_demo": {
        await ingestThroughStages({
          demo_ids: [body.demo_id],
          actor: identity.actor,
          role: identity.role,
        });
        break;
      }
      case "create_breakout_group": {
        const group_id = await createBreakoutGroup({
          name: body.name,
          note: body.note,
          actor_name,
          actor_function,
        });
        // Optionally starts with a theme's gaps (KAN-55).
        const gap_ids = String(body.gap_ids ?? "").split(",").map((id) => id.trim()).filter(Boolean);
        if (gap_ids.length > 0) await assignGapsToBreakoutGroup({ group_id, gap_ids, actor_name, actor_function });
        break;
      }
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
      case "update_breakout_group":
        await updateBreakoutGroup({
          group_id: body.group_id,
          name: typeof body.name === "string" ? body.name : undefined,
          note: typeof body.note === "string" ? body.note : undefined,
          actor_name,
          actor_function,
        });
        break;
      case "assign_gaps_to_breakout":
        await assignGapsToBreakoutGroup({
          group_id: body.group_id,
          gap_ids: String(body.gap_ids ?? "").split(",").map((id) => id.trim()).filter(Boolean),
          actor_name,
          actor_function,
        });
        break;
      case "move_gap_to_breakout":
        await moveGapToBreakoutGroup({
          gap_id: body.gap_id,
          from_group_id: body.from_group_id,
          to_group_id: body.to_group_id,
          actor_name,
          actor_function,
        });
        break;
      case "create_breakout_groups_by_theme": {
        if (!(BREAKOUT_THEMES as readonly string[]).includes(body.theme)) {
          return NextResponse.json({ error: "Choose a theme: domain, setting or priority." }, { status: 400 });
        }
        await createBreakoutGroupsByTheme({
          theme: body.theme as BreakoutTheme,
          only_unassigned: body.only_unassigned === "true" || (body.only_unassigned as unknown) === true,
          actor_name,
          actor_function,
        });
        break;
      }
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
    return apiErrorResponse(error, "Failed");
  }
}

/**
 * What an ingest request uploads (KAN-68): pasted or text-file `text`, or a PDF/Office file as
 * `content_base64` with its `filename`. Exactly one, of a supported type and under the size
 * limit; the mime is the one the extension names, so S1 parses the file as what it is.
 */
function ingestPayloadOf(body: Record<string, string>, title: string): IngestPayload {
  const hasText = typeof body.text === "string" && body.text.length > 0;
  const hasFile = typeof body.content_base64 === "string" && body.content_base64.length > 0;
  if (hasText && hasFile) throw new Error("Send the source as text or as a file, not both.");
  const filename = typeof body.filename === "string" ? body.filename.trim() : "";
  if (hasFile) {
    if (!filename) throw new Error("A file upload needs its filename.");
    const kind = uploadKindOf(filename);
    if (kind.kind === "refused") throw new Error(kind.reason);
    if (kind.kind === "text") throw new Error(`Send a ${filename} file's contents as text.`);
    if (body.mime && body.mime !== kind.mime && body.mime !== "application/octet-stream") {
      throw new Error(`${filename} does not match its type (${body.mime}).`);
    }
    const content_base64 = body.content_base64.replaceAll(/\s+/g, "");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(content_base64)) throw new Error("The file is not valid base64.");
    if (Buffer.byteLength(content_base64, "base64") > MAX_UPLOAD_BYTES) throw new Error(TOO_LARGE);
    return { filename, content_base64, mime: kind.mime };
  }
  if (filename && uploadKindOf(filename).kind === "binary") {
    throw new Error(`Send ${filename} as content_base64, not text.`);
  }
  if (hasText && Buffer.byteLength(body.text, "utf8") > MAX_UPLOAD_BYTES) throw new Error(TOO_LARGE);
  return { filename: filename || `${title.replaceAll(" ", "_")}.txt`, text: body.text };
}

/** Tactic fields present in the body; a field absent from the form is left unchanged. */
/**
 * A custom tactic type from a form (KAN-51). The field left out means "leave it"; a blank
 * name means "none". Invalid colours are refused by the store's normalizer.
 */
function customTypeOf(body: Record<string, string>): CustomTacticType | null | undefined {
  if (typeof body.custom_type_label !== "string") return undefined;
  return customTypeFromFields(body.custom_type_label, body.custom_type_color);
}

/**
 * The rest of the create-gap form (KAN-52): treatment settings and the gap's details, each
 * comma-separated where it is a list. Fields left out of the form leave the defaults.
 */
function gapExtrasOf(body: Record<string, string>) {
  const list = (value: unknown) => String(value ?? "").split(/[,\n]/).map((row) => row.trim()).filter(Boolean);
  const hasDetails = ["stakeholders", "geography", "regional_nuances", "notes"].some((key) => typeof body[key] === "string");
  return {
    ...(typeof body.settings === "string" && body.settings.trim() ? { settings: list(body.settings) } : {}),
    ...(hasDetails
      ? {
          metadata: {
            stakeholders: list(body.stakeholders),
            geography: body.geography ?? "",
            regional_nuances: body.regional_nuances ?? "",
            notes: body.notes ?? "",
          },
        }
      : {}),
  };
}

function tacticFieldsOf(body: Record<string, string>) {
  const fields: Partial<Record<(typeof TACTIC_EDIT_FIELDS)[number], string>> = {};
  for (const field of TACTIC_EDIT_FIELDS) {
    if (typeof body[field] === "string") fields[field] = body[field];
  }
  return fields;
}
