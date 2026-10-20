import { compareSource } from "@/lib/ingest/compare-source";
import { relationshipVersion } from "@/lib/iegp/relationship-version";
import { lockRelationships, requireGapResolutionSnapshot, requireRelationshipSnapshot } from "@/lib/iegp/relationship-change";
import { decidePartialSplit } from "@/modules/stages/s6-partial-split/module";
import type { CustomTacticType } from "@/lib/iegp/custom-tactic-type";
import { BREAKOUT_THEMES, createBreakoutGroupsByTheme, type BreakoutTheme } from "@/lib/iegp/breakout-themes";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db, currentSchemaName, withWorkspaceTransaction } from "@/lib/iegp/db";
import {
  acceptMapping,
  acceptResidualGap,
  assignGapToBreakoutGroup,
  assignTacticToGap,
  beginLibraryLinkRequest,
  completeLibraryLinkRequest,
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
  reviewRequirementBasis,
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
  setGapObjective,
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
import { clearIngestedFiles } from "@/modules/workspaces/clear-ingested-files";
import { recordAudit } from "@/modules/kernel/audit";
import { replaceContents } from "@/modules/workspaces/contents";
import { recordEdit, requireRationale, type EditAction } from "@/modules/kernel/edit-records";
import { recordDenied } from "@/modules/kernel/audit";
import type { StageId } from "@/modules/kernel/contracts";
import {
  apiErrorResponse,
  readJsonBody,
  requireCapability,
  requireCustomerContext,
  type CustomerContext,
} from "@/modules/auth/api-guard";
import { linkSourceSupport, createSourceDiscrepancy, resolveSourceDiscrepancy } from "@/lib/iegp/source-review";
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
import type { IegpState } from "@/lib/iegp/types";
import { advanceIngest, ingestThroughStages, type IngestPayload } from "./ingest-pipeline";
import { MAX_UPLOAD_BYTES, TOO_LARGE, uploadKindOf } from "@/lib/ingest/upload-formats";
import { promoteGapCandidate, promoteTacticCandidate } from "./promote-candidates";
import {
  acceptGapMergeSuggestion,
  acceptGapSplitSuggestion,
  rejectGapSuggestionKeepingCandidate,
} from "@/modules/stages/s2-gap-extract/suggestions";

export const runtime = "nodejs";

/** Actions that replace the whole workspace: its owner only, on top of the reset_workspace capability. */
const WORKSPACE_OWNER_ACTIONS = new Set(["reset", "load_demo", "clear_ingested_files"]);

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
 * Gate actions on the legacy workbench that carry a user judgement. Each files an
 * edit record with the field's real value before and after the action, and the
 * person's reason when they gave one (null otherwise, KAN-90), so the same
 * judgement reaches hillclimb and the gap's history from this surface too.
 */
const GATE_EDITS: Record<string, { stage: StageId; entity: string; field: string; action: EditAction }> = {
  classify_gap: { stage: "S5", entity: "gap", field: "computed_status", action: "override" },
  override_gap_status: { stage: "S5", entity: "gap", field: "computed_status", action: "override" },
  clear_gap_status_override: { stage: "S5", entity: "gap", field: "computed_status", action: "edit" },
  validate_gap: { stage: "S5", entity: "gap", field: "human_validated", action: "validate" },
  // modify_gap, modify_tactic, need edits, leftover decisions and promotions file
  // their own edit records (with before/after) in the store.
  save_mapping_row: { stage: "S4", entity: "gap", field: "mapping_table_row", action: "edit" },
  review_requirement_basis: { stage: "S5", entity: "gap", field: "requirement_basis", action: "validate" },
  rewrite_partial_gap: { stage: "S6", entity: "gap", field: "statement", action: "edit" },
  lock_gap: { stage: "S5", entity: "gap", field: "status", action: "edit" },
  park_gap: { stage: "S5", entity: "gap", field: "parked_at", action: "edit" },
  unpark_gap: { stage: "S5", entity: "gap", field: "parked_at", action: "edit" },
  create_tactic: { stage: "S9", entity: "tactic", field: "created", action: "add" },
  record_missed_tactic: { stage: "S5", entity: "tactic", field: "created", action: "add" },
};

type GateEdit = (typeof GATE_EDITS)[string];

function gateEntityId(body: Record<string, string>): string {
  return body.gap_id || body.parent_gap_id || body.coverage_id || body.tactic_id || body.residual_id || "—";
}

/** The gated field's current value in the plan, as the edit record stores it (null when unset). */
function gateFieldValue(state: IegpState, mapping: GateEdit, body: Record<string, string>): string | null {
  const gap = state.gaps.find((row) => row.id === (body.gap_id || body.parent_gap_id));
  const coverage = state.coverages.find((row) => row.id === body.coverage_id);
  switch (mapping.field) {
    case "computed_status":
      if (!gap) return null;
      return gap.status_override ? `${gap.status_override.status} (override)` : gap.computed_status;
    case "requirement_basis":
      return gap?.requirement_basis ? JSON.stringify(gap.requirement_basis) : null;
    case "human_validated":
      return gap ? String(gap.human_validated) : null;
    case "status":
      return gap?.status ?? null;
    case "parked_at":
      return gap?.parked_at ?? null;
    case "statement":
      return gap?.statement ?? null;
    case "mapping": {
      const row = state.coverages.find((c) => c.gap_id === body.gap_id && c.tactic_id === body.tactic_id && !c.expansion_id);
      return row ? `${row.tactic_id}: ${row.overall}` : null;
    }
    case "mapping_table_row": {
      const ids = [...new Set(state.coverages.filter((c) => c.gap_id === body.gap_id).map((c) => c.tactic_id))].sort();
      return ids.length ? ids.join(", ") : null;
    }
    case "dimension":
      return coverage ? (coverage.dimensions[body.dimension as CoverageDimension]?.value ?? null) : null;
    case "overall":
      return coverage?.overall ?? null;
    case "created":
      // Nothing existed before; afterwards, the tactic as named.
      return null;
    default:
      return null;
  }
}

/** The gated field's value before the action runs, read only for gated actions. */
async function gateBefore(body: Record<string, string>): Promise<string | null | undefined> {
  const mapping = GATE_EDITS[body.action ?? ""];
  if (!mapping) return undefined;
  return gateFieldValue(await loadState(), mapping, body);
}

async function fileGateEdit(
  body: Record<string, string>,
  before: string | null | undefined,
  actor_name: string,
  actor_function: ActorFunction,
) {
  const mapping = GATE_EDITS[body.action ?? ""];
  if (!mapping || before === undefined) return;
  const rationale = (body.rationale || body.reason || body.note || body.override_reason || "").trim();
  const after =
    mapping.field === "created" ? body.name?.trim() || null : gateFieldValue(await loadState(), mapping, body);
  if (before === after && mapping.field !== "created") return;
  await recordEdit({
    stage: mapping.stage,
    entity_type: mapping.entity,
    entity_id: gateEntityId(body),
    field: mapping.field,
    action: mapping.action,
    before,
    after,
    // A gate action without a reason is still a change on the record (KAN-90).
    rationale: rationale || null,
    rationale_optional: true,
    actor: { name: actor_name, function: actor_function },
  });
}

/**
 * Actions that run the stage pipeline (model calls). Their stages record their
 * own per-stage transactions and checkpoints, so no transaction spans the whole pipeline.
 */
const NON_ATOMIC_ACTIONS = new Set(["ingest", "ingest_demo", "retry_source_comparison"]);

/** Carries a refused or failed action's response out of its rolled-back transaction. */
class RolledBack extends Error {
  constructor(readonly response: Response) {
    super("Action rolled back");
  }
}

async function actionOf(request: Request): Promise<string> {
  try {
    const body = (await request.json()) as { action?: unknown };
    return typeof body?.action === "string" ? body.action : "";
  } catch {
    return "";
  }
}

/**
 * Every plan action is all or nothing (KAN-15): its writes share one database
 * transaction, so an action that fails part-way, or is refused after a first
 * write, leaves nothing half-written.
 */
export async function POST(request: Request) {
  if (NON_ATOMIC_ACTIONS.has(await actionOf(request.clone()))) return handleAction(request);
  try {
    // An unresolvable workspace is the action's own error to report, unwrapped.
    await currentSchemaName();
  } catch {
    return handleAction(request);
  }
  try {
    return await withWorkspaceTransaction(async () => {
      const response = await handleAction(request);
      if (!response.ok) throw new RolledBack(response);
      return response;
    });
  } catch (error) {
    if (error instanceof RolledBack) return error.response;
    return apiErrorResponse(error, "Failed");
  }
}

async function handleAction(request: Request): Promise<Response> {
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
      await recordDenied({
        category: "workspace",
        action: `${body.action}.denied`,
        reason: "Only the workspace owner can replace its contents.",
        entity_type: "workspace",
        entity_id: identity.workspace.id,
        meta: { code: "forbidden", workspace_role: identity.workspace.role },
      });
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
    // Only the explicit library flow opts into retry semantics. Old mapping actions keep their contract.
    let libraryRequest: { id: string; payload: string } | undefined;
    if (body.action === "assign_tactic") {
      // This surface previews original parent scope only; never reinterpret child input as parent.
      if (body.expansion_id) throw new Error("Use the expansion review workflow to link a child scope.");
      if (body.link_mode !== undefined) {
        if (body.link_mode !== "unassessed" && body.link_mode !== "assessed") throw new Error("Choose Link as unassessed or Assess and link.");
        const verdict = coverageInput(body);
        if (body.link_mode === "unassessed" && (verdict.coverage && verdict.coverage !== "unassessed" || verdict.dimensions)) {
          throw new Error("Link as unassessed cannot include an assessment.");
        }
        if (body.link_mode === "assessed" && (!verdict.coverage || verdict.coverage === "unassessed" || body.confirm_coverage === "false")) {
          throw new Error("Assess and link requires an explicit confirmed overall verdict.");
        }
        const payload = JSON.stringify({
          principal: identity.principal, actor: identity.actor, workspace: identity.workspace?.id ?? null,
          gap_id: body.gap_id, tactic_id: body.tactic_id, mode: body.link_mode,
          overall: verdict.coverage ?? "unassessed",
          dimensions: Object.entries(verdict.dimensions ?? {}).sort(([a], [b]) => a.localeCompare(b)),
          rationale: rationaleOf(body), expected_basis_version: body.expected_basis_version ?? null,
          // Preserve pre-design-token receipt encoding for exact retries from older clients.
          ...(body.expected_design_version !== undefined ? { expected_design_version: body.expected_design_version } : {}),
        });
        libraryRequest = { id: body.request_id ?? "", payload };
        const replay = await beginLibraryLinkRequest(libraryRequest.id, payload);
        if (replay) return NextResponse.json({ ok: true, id: replay });
      }
    }
    if (["assign_tactic", "unassign_tactic", "accept_mapping", "reject_mapping", "save_mapping_row", "lock_dimension", "lock_overall", "confirm_coverage_review", "restore_mapping"].includes(body.action)) {
      requireRationale(rationaleOf(body));
      await lockRelationships();
      if (body.action === "unassign_tactic") {
        // Canonical design edits also own these rows. Recheck only after they commit.
        await db().execute(sql`select id from tactics where id = ${body.tactic_id} for update`);
        await db().execute(sql`select id from gaps where id = ${body.gap_id} for update`);
      }
      requireRelationshipSnapshot(await loadState(), body);
    }
    if (["split_partial_gap", "rewrite_partial_gap"].includes(body.action)) {
      requireRationale(rationaleOf(body));
      await lockRelationships();
      requireGapResolutionSnapshot(await loadState(), body.parent_gap_id || body.gap_id, body.expected_resolution);
    }
    const before = await gateBefore(body);
    // The id of a gap or tactic this action created, so the caller can address it without guessing (ids are never reissued).
    let createdId: string | undefined;
    switch (body.action) {
      case "retry_source_comparison":
        if (!body.source_id?.trim()) throw new Error("Choose a parsed source to compare.");
        await compareSource(body.source_id, identity.actor);
        break;
      case "link_source_support":
      case "create_source_discrepancy": {
        const create = body.action === "link_source_support" ? linkSourceSupport : createSourceDiscrepancy;
        createdId = await create({ source_id: body.source_id, block_id: body.block_id, passage: body.passage,
          gap_id: body.gap_id, tactic_id: body.tactic_id, coverage_id: body.coverage_id,
          rationale: rationaleOf(body), origin: "human", actor_name, actor_function });
        break;
      }
      case "resolve_source_discrepancy":
        if (body.decision === "accept" && body.correction_target === "tactic") requireCapability(identity, "ideate");
        await resolveSourceDiscrepancy({ review_id: body.review_id, expected_version: body.expected_version,
          decision: body.decision, rationale: rationaleOf(body), reviewed_change: body.reviewed_change === "true",
          correction_target: body.correction_target, correction_field: body.correction_field, correction_value: body.correction_value,
          expected_target_version: body.expected_target_version, actor_name, actor_function });
        break;
      case "clear_ingested_files":
        if (body.confirmation !== "clear_ingested_files") return NextResponse.json({ error: "Confirm clearing all current ingested files first.", code: "invalid_request" }, { status: 400 });
        await clearIngestedFiles();
        await recordAudit({ category: "workspace", action: "workspace.clear_ingested_files", entity_type: "workspace", entity_id: identity.workspace?.id ?? null, workspace_id: identity.workspace?.id ?? null });
        break;
      case "reset":
        // Reset to blank: empties the plan and clears the workspace's demo flag.
        await replaceContents(identity.workspace?.id ?? null, "blank", identity.actor);
        break;
      case "load_demo":
        // Replaces everything with the Velmara demo and flags the workspace as demo.
        // scope "setup" loads only the demo's asset and objectives (the stage tests' start).
        // A client-demo workspace (KAN-138) always restarts at the walkthrough's start: setup done, no sources.
        await replaceContents(
          identity.workspace?.id ?? null,
          identity.workspace?.demo_mode ? "client_demo" : body.scope === "setup" ? "demo_setup" : "demo",
          identity.actor,
        );
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
      case "set_gap_objective":
        await setGapObjective({
          gap_id: body.gap_id,
          objective_id: body.objective_id,
          expected_objective_id: body.expected_objective_id,
          expected_gap: body.expected_gap,
          rationale: body.rationale || body.note || null,
          actor_name,
          actor_function,
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
        await restoreRejectedTactic({ tactic_id: body.tactic_id, expected_tactic: body.expected_tactic ?? "", rationale: rationaleOf(body), actor_name, actor_function });
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
      case "review_requirement_basis":
        await reviewRequirementBasis({
          gap_id: body.gap_id,
          expected_version: body.expected_version,
          dimensions: body.requirements ? JSON.parse(body.requirements) : Object.fromEntries(COVERAGE_DIMENSIONS.map(dim => [dim, {
            applicability: body[`req_${dim}_applicability`] || "undetermined",
            requirement: body[`req_${dim}_requirement`] || "",
            rationale: body[`req_${dim}_rationale`] || "",
            resolution: body[`req_${dim}_resolution`] || "",
          }])),
          rationale: rationaleOf(body),
          actor_name, actor_function,
          origin: "human", confirm: true,
        });
        break;
      case "lock_dimension":
        if (!body.expected_version) return NextResponse.json({ error: "Refresh coverage before reviewing." }, { status: 400 });
        if (rationaleOf(body).length < 3) {
          return NextResponse.json({ error: RATIONALE_REQUIRED }, { status: 400 });
        }
        await lockCoverageDimension({
          coverage_id: body.coverage_id,
          expected_version: body.expected_version,
          dimension: body.dimension as CoverageDimension,
          value: body.value as never,
          rationale: body.rationale || body.note || "",
          actor_name,
          actor_function,
        });
        break;
      case "lock_overall":
        if (body.overall === "full" && !body.expected_basis_version) return NextResponse.json({ error: "Review the requirement basis before confirming Full." }, { status: 400 });
        if (!body.expected_version) return NextResponse.json({ error: "Refresh coverage before reviewing." }, { status: 400 });
        if (rationaleOf(body).length < 3) {
          return NextResponse.json({ error: RATIONALE_REQUIRED }, { status: 400 });
        }
        await lockCoverageOverall({
          coverage_id: body.coverage_id,
          expected_version: body.expected_version,
          expected_basis_version: body.expected_basis_version,
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
          note: rationaleOf(body),
        });
        break;
      case "create_tactic":
        if (body.origin === "gaps") {
          await recordMissedTactic({
            rationale: rationaleOf(body),
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
          rationale: rationaleOf(body),
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
        createdId = await recordMissedTactic({
          rationale: rationaleOf(body),
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
        if (verdict.coverage === "full" && body.confirm_coverage !== "false" && !body.expected_basis_version) return NextResponse.json({ error: "Review the requirement basis before confirming Full." }, { status: 400 });
        const hasVerdict =
          Boolean(verdict.coverage && verdict.coverage !== "unassessed") || Boolean(verdict.dimensions);
        if (hasVerdict && rationaleOf(body).length < 3) {
          return NextResponse.json({ error: RATIONALE_REQUIRED }, { status: 400 });
        }
        createdId = await assignTacticToGap({
          gap_id: body.gap_id,
          require_preview_basis: body.link_mode === "assessed",
          expected_design_version: body.expected_design_version,
          expected_basis_version: body.expected_basis_version,
          confirm_coverage: body.confirm_coverage !== "false",
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
      case "accept_mapping": {
        if (rationaleOf(body).length < 3) {
          return NextResponse.json({ error: RATIONALE_REQUIRED }, { status: 400 });
        }
        const suggestion = body.judgement_origin === "model"
          ? (await latestS4MappingRows())?.find(row => row.gap_id === body.gap_id)?.mappings.find(row => row.tactic_id === body.tactic_id)
          : undefined;
        if (body.judgement_origin === "model" && (!suggestion || body.expected_suggestion !== relationshipVersion(suggestion))) {
          throw new Error("Model suggestion changed or is unavailable. Review the current suggestion or make a manual judgement with a reason.");
        }
        await acceptMapping({
          model: body.judgement_origin === "model",
          references: suggestion?.references,
          supplied_records: suggestion?.supplied_records,
          expected_tactic_version: suggestion?.expected_tactic_version,
          gap_id: body.gap_id,
          tactic_id: body.tactic_id,
          actor_name,
          actor_function,
          note: rationaleOf(body),
          ...(suggestion ? { coverage: suggestion.coverage, dimensions: suggestion.dimensions } : coverageInput(body)),
        });
        break;
      }
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
        if (aiRow && mappingDecision.decision_event_id) {
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
        createdId = await createGap({
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
          expected_gap: body.expected_gap,
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
          expected_tactic: body.expected_tactic ?? "",
          review_status: body.review_status as "accepted" | "rejected",
          actor_name,
          actor_function,
          note: requireRationale(rationaleOf(body)),
        });
        break;
      case "modify_tactic":
        await modifyTactic({
          tactic_id: body.tactic_id,
          expected_tactic: body.expected_tactic ?? "",
          status: typeof body.status === "string" ? body.status : undefined,
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
          reason: typeof body.reason === "string" ? body.reason : rationaleOf(body),
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
            expected_resolution: body.expected_resolution,
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
          expected_resolution: body.expected_resolution,
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
        createdId = await createAddressedGap({
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
          expected_tactic: body.expected_tactic ?? "",
          status: body.status as never,
          actor_name,
          actor_function,
          note: requireRationale(rationaleOf(body)),
        });
        break;
      // Ingest is the S0→S4 stage pipeline; S2–S4 need a connected LLM and the
      // error says so. There is no rule-based ingest.
      case "ingest": {
        const title = typeof body.title === "string" ? body.title.trim() : "";
        const ingest = body.incremental === "true" ? advanceIngest : ingestThroughStages;
        const result = await ingest({
          ...(body.ingest_job_id ? { job_id: body.ingest_job_id } : {}),
          files: body.ingest_job_id ? [] : [
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
        if (body.incremental === "true") return NextResponse.json({ ok: true, ...result });
        break;
      }
      case "ingest_demo": {
        const ingest = body.incremental === "true" ? advanceIngest : ingestThroughStages;
        const result = await ingest({
          ...(body.ingest_job_id ? { job_id: body.ingest_job_id } : {}),
          demo_ids: body.ingest_job_id ? [] : [body.demo_id],
          actor: identity.actor,
          role: identity.role,
        });
        if (body.incremental === "true") return NextResponse.json({ ok: true, ...result });
        break;
      }
      case "create_breakout_group": {
        // Optionally starts with a theme's gaps (KAN-55), checked before anything is created (KAN-18).
        await createBreakoutGroup({
          name: body.name,
          note: body.note,
          gap_ids: String(body.gap_ids ?? "").split(",").map((id) => id.trim()).filter(Boolean),
          actor_name,
          actor_function,
        });
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
    await fileGateEdit(body, before, actor_name, actor_function);
    if (libraryRequest && createdId) await completeLibraryLinkRequest(libraryRequest.id, libraryRequest.payload, createdId);
    return NextResponse.json(createdId ? { ok: true, id: createdId } : { ok: true });
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
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}(?:==)?|[A-Za-z0-9+/]{3}=?)?$/.test(content_base64)) {
      throw new Error("The file is not valid base64.");
    }
    if (Buffer.byteLength(content_base64, "base64") > MAX_UPLOAD_BYTES) throw new Error(TOO_LARGE);
    return { filename, content_base64, mime: kind.mime };
  }
  const textKind = filename ? uploadKindOf(filename) : null;
  if (textKind?.kind === "refused") throw new Error(textKind.reason);
  if (textKind?.kind === "binary") {
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
