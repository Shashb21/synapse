import { NextResponse } from "next/server";
import {
  assignTacticToGap,
  completeWizard,
  createProposedTactic,
  ingestDemoSource,
  ingestNeedFromText,
  lockCoverageDimension,
  lockCoverageOverall,
  lockGapStatus,
  lockNeed,
  lockPriority,
  lockResidual,
  lockRoadmapItem,
  lockTactic,
  lockTacticReview,
  modifyGap,
  modifyTactic,
  resetSeed,
} from "@/lib/iegp/store";
import type { ActorFunction } from "@/lib/iegp/enums";
import type { CoverageDimension } from "@/lib/iegp/enums";

export const runtime = "nodejs";

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
      case "assign_tactic":
        await assignTacticToGap({
          gap_id: body.gap_id,
          tactic_id: body.tactic_id,
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
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
