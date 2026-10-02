import { NextResponse } from "next/server";
import { stageErrorResponse } from "@/app/api/modules/ai-off";
import { runStage } from "@/modules";
import { STAGE_IDS, type StageId } from "@/modules/kernel/contracts";
import { readJsonBody } from "@/modules/auth/api-guard";
import { ownerAccess, ownerGate } from "@/modules/auth/owner";
import { inAdminWorkspace } from "./_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `{ stage, input, workspace_id? }` runs one stage from the owner console's
 * Pipeline, in the workspace the page showed. Owner only, checked on every call.
 */
export async function POST(request: Request) {
  const denied = await ownerGate();
  if (denied) return denied;
  try {
    const body = await readJsonBody(request);
    const stage = String(body.stage ?? "") as StageId;
    if (!STAGE_IDS.includes(stage)) {
      return NextResponse.json({ error: `Unknown stage ${body.stage}` }, { status: 400 });
    }
    const access = await ownerAccess();
    return await inAdminWorkspace(body, async (workspace) => {
      const result = await runStage({
        stage,
        input: (body.input as unknown) ?? {},
        actor: access.actor,
        role: access.role,
        workspace_id: workspace.id,
      });
      return NextResponse.json({ ok: true, workspace: { id: workspace.id, name: workspace.name }, ...result });
    });
  } catch (error) {
    return stageErrorResponse(error, "Stage run failed");
  }
}
