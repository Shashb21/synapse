import { NextResponse } from "next/server";
import { z } from "zod";
import { demoExecutionFor } from "@/lib/demo/mode";
import { ApiGuardError, apiErrorResponse, readJsonBody, requireCustomerContext } from "@/modules/auth/api-guard";
import { TrustedApplicationError } from "@/modules/kernel/stage-errors";
import { acceptDemoIdeationProposals } from "@/modules/stages/s9-ideation/module";
import { runInWorkspace } from "@/modules/workspaces/context";

export const runtime = "nodejs";

const approval = z.strictObject({
  workspace_id: z.string().trim().min(1),
  proposals: z.array(z.strictObject({
    id: z.string().trim().min(1),
    expected_version: z.string().regex(/^[a-f0-9]{64}$/, "The opening proposal version is required."),
  })).min(1),
  rationale: z.string().trim().min(3, "A short rationale is required for every edit."),
});

export async function POST(request: Request) {
  try {
    const identity = await requireCustomerContext({ capability: "ideate" });
    const { workspace } = identity;
    if (!workspace?.demo || !workspace.demo_mode) {
      throw new ApiGuardError(403, "forbidden", "Only the Velmara client demo has this approval shortcut.");
    }
    const body = approval.parse(await readJsonBody(request));
    if (body.workspace_id !== workspace.id) {
      throw new ApiGuardError(409, "workspace_mismatch", "The selected workspace changed. Open the demo ideas again.");
    }
    const scope = { workspace_id: workspace.id, schema: workspace.schema_name };
    const accepted = await runInWorkspace(scope, () => acceptDemoIdeationProposals({
      ...body,
      demo: demoExecutionFor(workspace),
      actor: identity.actor,
    }));
    return NextResponse.json({ ok: true, accepted });
  } catch (error) {
    if (error instanceof TrustedApplicationError && error.code.startsWith("demo_ideation_")) {
      return NextResponse.json({ safe_error: true, request_outcome: "rejected", error: error.message, code: error.code }, { status: error.status });
    }
    return apiErrorResponse(error, "Could not accept the demo ideas. Check Ideation before trying again.");
  }
}
