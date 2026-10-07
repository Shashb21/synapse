import "@/modules";
import { evaluatePromptRevision, listRevisionEvaluations } from "@/modules/kernel/prompt-revision-evals";
/** Owner-only agreement reporting and explicit immutable candidate proposals. */
import { NextResponse } from "next/server";
import { z } from "zod";
import { ownerAccess, ownerGate } from "@/modules/auth/owner";
import { withAdminWorkspace } from "@/modules/workspaces/admin-context";
import { listDecisionExamples } from "@/modules/kernel/decision-examples";
import { agreementSeries } from "@/modules/kernel/learning-agreement";
import { listPromptRevisions, proposePromptRevision, REVISION_STAGES, activatePromptRevision, rollbackPromptRevision, revisionHistory } from "@/modules/kernel/prompt-revisions";
import { stageErrorResponse } from "@/app/api/modules/ai-off";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const revisionId = z.string().regex(/^prv_[a-zA-Z0-9_-]+$/);
const proposalSchema = z.discriminatedUnion("action", [
 z.object({ action: z.literal("propose"), stage: z.enum(REVISION_STAGES) }).strict(),
 z.object({ action: z.literal("evaluate"), revision_id: revisionId }).strict(),
 z.object({ action: z.literal("approve"), revision_id: revisionId, evaluation_id: z.string().regex(/^pre_[a-zA-Z0-9_-]+$/), expected_active_id: revisionId.nullable() }).strict(),
 z.object({ action: z.literal("rollback"), stage: z.enum(REVISION_STAGES), expected_active_id: revisionId }).strict(),
]);

/** Read all decision counts and revision metadata for the server-selected admin workspace. */
export async function GET(request: Request) {
  const denied = await ownerGate(); if (denied) return denied;
  try {
    const bucket = z.enum(["day", "week"]).parse(new URL(request.url).searchParams.get("bucket") ?? "day");
    return await withAdminWorkspace(async workspace => {
      const [examples, revisions, evaluations, history] = await Promise.all([
        listDecisionExamples({ workspace_id: workspace.id, limit: null }), listPromptRevisions(workspace.id), listRevisionEvaluations(workspace.id), revisionHistory(workspace.id),
      ]);
      const timestamps = examples.map(example => example.created_at).sort();
      return NextResponse.json({ workspace: { id: workspace.id, name: workspace.name }, bucket, agreement: agreementSeries(examples, bucket), total: examples.length,
        date_range: timestamps.length ? { from: timestamps[0], to: timestamps[timestamps.length - 1] } : null,
        evaluations, history,
        revisions: revisions.map(({ id, stage, parent_revision, instruction_text, creator, created_at, state, training_ids, heldout_ids }) => ({ id, stage, parent_revision, instruction_text, creator, created_at, state, training_count: training_ids.length, heldout_count: heldout_ids.length })),
      });
    });
  } catch (error) { return stageErrorResponse(error, "Learning report could not load."); }
}

/** Accept only action and stage; the server resolves actor, workspace and mandatory exclusions. */
export async function POST(request: Request) {
  const denied = await ownerGate(); if (denied) return denied;
  try {
    const body = proposalSchema.parse(await request.json());
    const access = await ownerAccess();
    return await withAdminWorkspace(async workspace => {
      if (body.action === "evaluate") return NextResponse.json({ evaluation: await evaluatePromptRevision({revision_id:body.revision_id,workspace_id:workspace.id,actor:access.actor}) });
      if (body.action === "approve") return NextResponse.json({ revision: await activatePromptRevision({...body,actor:access.actor}) });
      if (body.action === "rollback") return NextResponse.json({ revision: await rollbackPromptRevision({...body,actor:access.actor}) });
      const revision = await proposePromptRevision({ stage: body.stage, workspace_id: workspace.id, actor: access.actor, exclude_ids: [] });
      return NextResponse.json({ revision }, { status: 201 });
    });
  } catch (error) { return stageErrorResponse(error, "Prompt candidate could not be created."); }
}
