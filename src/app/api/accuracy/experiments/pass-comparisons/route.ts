import { refuseWhenAiOff } from "@/app/api/accuracy/_lib/ai-off";
import { ownerGate } from "@/modules/auth/owner";
/** Authenticated controlled 1/2/3-pass cohorts and scoped retained-evidence comparisons. */
import { NextResponse } from "next/server";
import { registerAccuracyStack } from "@/accuracy";
import { PassComparisonNotFoundError, PassComparisonValidationError, readPassComparison, runPassComparison } from "@/accuracy/experiments/pass-comparison";
import { can } from "@/modules/auth/roles";
import { sessionContext } from "@/modules/auth/session";
import { authorizedSourceWorkspace, experimentRequestError, parseExperimentRequest, validateExperimentSources } from "../request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
registerAccuracyStack();

/** Start separate controlled attempts with actor identity supplied by the server session. */
export async function POST(request: Request) {
  const session = await sessionContext();
  if (!session.signed_in) return NextResponse.json({ error: "Sign in to access experiments" }, { status: 401 });
  const denied = await ownerGate();
  if (denied) return denied;
  if (!can(session.role, "validate")) return NextResponse.json({ error: "You do not have validation capability" }, { status: 403 });
  try {
    const aiOff = await refuseWhenAiOff();
    if (aiOff) return aiOff;
    const body = await parseExperimentRequest(request, true);
    if (!await authorizedSourceWorkspace(body.source_workspace_id, session)) {
      return NextResponse.json({ error: "Source workspace not found" }, { status: 404 });
    }
    const validated = await validateExperimentSources(body, true);
    return NextResponse.json(await runPassComparison({ ...validated, actor: session.actor }), { status: 201 });
  } catch (error) {
    const message = experimentRequestError(error);
    if (message || error instanceof PassComparisonValidationError) {
      return NextResponse.json({ error: message ?? "Invalid comparison request" }, { status: 400 });
    }
    console.error("Could not start controlled pass comparison", error);
    return NextResponse.json({ error: "Could not start pass comparison" }, { status: 500 });
  }
}

/** Read one to three distinct attempts only through their original authorized source workspace. */
export async function GET(request: Request) {
  const session = await sessionContext();
  if (!session.signed_in) return NextResponse.json({ error: "Sign in to access experiments" }, { status: 401 });
  const denied = await ownerGate();
  if (denied) return denied;
  const query = new URL(request.url).searchParams;
  const source_workspace_id = query.get("source_workspace_id")?.trim() ?? "";
  const experiment_ids = query.getAll("experiment_id").map(id => id.trim());
  if (query.getAll("source_workspace_id").length !== 1 || !source_workspace_id || !experiment_ids.length || experiment_ids.length > 3
    || experiment_ids.some(id => !id) || new Set(experiment_ids).size !== experiment_ids.length) {
    return NextResponse.json({ error: "Supply source_workspace_id and one to three distinct experiment_id parameters" }, { status: 400 });
  }
  try {
    if (!await authorizedSourceWorkspace(source_workspace_id, session)) {
      return NextResponse.json({ error: "Source workspace not found" }, { status: 404 });
    }
    const comparison = await readPassComparison({ source_workspace_id, experiment_ids });
    return NextResponse.json({ comparison });
  } catch (error) {
    if (error instanceof PassComparisonNotFoundError) {
      return NextResponse.json({ error: "Pass comparison experiments not found" }, { status: 404 });
    }
    if (error instanceof PassComparisonValidationError) {
      return NextResponse.json({ error: "Invalid comparison request" }, { status: 400 });
    }
    console.error("Could not read controlled pass comparison", error);
    return NextResponse.json({ error: "Could not read pass comparison" }, { status: 500 });
  }
}
