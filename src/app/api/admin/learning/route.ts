/** Owner-only agreement reporting and explicit immutable candidate proposals. */
import { NextResponse } from "next/server";
import { z } from "zod";
import { ownerAccess, ownerGate } from "@/modules/auth/owner";
import { withAdminWorkspace } from "@/modules/workspaces/admin-context";
import { listDecisionExamples } from "@/modules/kernel/decision-examples";
import { agreementSeries } from "@/modules/kernel/learning-agreement";
import { listPromptRevisions, proposePromptRevision, REVISION_STAGES } from "@/modules/kernel/prompt-revisions";
import { stageErrorResponse } from "@/app/api/modules/ai-off";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const proposalSchema = z.object({ action: z.literal("propose"), stage: z.enum(REVISION_STAGES) }).strict();

/** Read all decision counts and revision metadata for the server-selected admin workspace. */
export async function GET(request: Request) {
  const denied = await ownerGate(); if (denied) return denied;
  try {
    const bucket = z.enum(["day", "week"]).parse(new URL(request.url).searchParams.get("bucket") ?? "day");
    return await withAdminWorkspace(async workspace => {
      const [examples, revisions] = await Promise.all([
        listDecisionExamples({ workspace_id: workspace.id, limit: null }), listPromptRevisions(workspace.id),
      ]);
      const timestamps = examples.map(example => example.created_at).sort();
      return NextResponse.json({ workspace: { id: workspace.id, name: workspace.name }, bucket, agreement: agreementSeries(examples, bucket), total: examples.length,
        date_range: timestamps.length ? { from: timestamps[0], to: timestamps[timestamps.length - 1] } : null,
        revisions: revisions.map(({ id, stage, parent_revision, creator, created_at, state, training_ids, heldout_ids }) => ({ id, stage, parent_revision, creator, created_at, state, training_count: training_ids.length, heldout_count: heldout_ids.length })),
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
      const revision = await proposePromptRevision({ stage: body.stage, workspace_id: workspace.id, actor: access.actor, exclude_ids: [] });
      return NextResponse.json({ revision }, { status: 201 });
    });
  } catch (error) { return stageErrorResponse(error, "Prompt candidate could not be created."); }
}
