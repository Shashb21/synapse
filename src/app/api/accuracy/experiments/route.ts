import { refuseWhenAiOff } from "@/app/api/accuracy/_lib/ai-off";
import { ownerGate } from "@/modules/auth/owner";
/** Authenticated experiment start and source-workspace-scoped record export API. */
import { NextResponse } from "next/server";
import { registerAccuracyStack } from "@/accuracy";
import { exportExperimentsForSourceWorkspace } from "@/accuracy/experiments/records";
import { runAccuracyExperiment } from "@/accuracy/experiments/run";
import { can } from "@/modules/auth/roles";
import { sessionContext } from "@/modules/auth/session";
import { authorizedSourceWorkspace, experimentRequestError, parseExperimentRequest, validateExperimentSources } from "./request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

registerAccuracyStack();

function unauthorized() {
  return NextResponse.json({ error: "Sign in to access experiments" }, { status: 401 });
}

/** Export records for an original source workspace. */
export async function GET(request: Request) {
  const session = await sessionContext();
  if (!session.signed_in) return unauthorized();
  const denied = await ownerGate();
  if (denied) return denied;
  const url = new URL(request.url);
  const source_workspace_id = url.searchParams.get("source_workspace_id")?.trim() ?? "";
  const format = url.searchParams.get("format") ?? "json";
  if (!source_workspace_id || (format !== "json" && format !== "jsonl")) {
    return NextResponse.json({ error: "source_workspace_id and format=json|jsonl are required" }, { status: 400 });
  }
  if (!await authorizedSourceWorkspace(source_workspace_id, session)) {
    return NextResponse.json({ error: "Source workspace not found" }, { status: 404 });
  }
  const exported = await exportExperimentsForSourceWorkspace({ source_workspace_id, format });
  if (format === "jsonl") {
    return new Response(exported, { headers: { "content-type": "application/x-ndjson; charset=utf-8" } });
  }
  return new Response(exported, { headers: { "content-type": "application/json; charset=utf-8" } });
}

/** Start a validated isolated experiment without trusting client actor, org, gold, or copy identifiers. */
export async function POST(request: Request) {
  const session = await sessionContext();
  if (!session.signed_in) return unauthorized();
  const denied = await ownerGate();
  if (denied) return denied;
  if (!can(session.role, "validate")) {
    return NextResponse.json({ error: "You do not have validation capability" }, { status: 403 });
  }
  try {
    const aiOff = await refuseWhenAiOff();
    if (aiOff) return aiOff;
    const body = await parseExperimentRequest(request);
    if (!await authorizedSourceWorkspace(body.source_workspace_id, session)) {
      return NextResponse.json({ error: "Source workspace not found" }, { status: 404 });
    }
    const validated = await validateExperimentSources(body);
    const experiment = await runAccuracyExperiment({ ...validated, actor: session.actor });
    return NextResponse.json({ experiment }, { status: 201 });
  } catch (error) {
    const message = experimentRequestError(error);
    if (message) {
      return NextResponse.json({ error: message }, { status: 400 });
    }
    console.error("Could not start isolated accuracy experiment", error);
    return NextResponse.json({ error: "Could not start experiment" }, { status: 500 });
  }
}
