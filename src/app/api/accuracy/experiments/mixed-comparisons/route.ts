/** Authenticated paired mixed replay and complete source-scoped retained exports. */
import { NextResponse } from "next/server";
import { z } from "zod";
import { registerAccuracyStack } from "@/accuracy";
import { runMixedComparison } from "@/accuracy/experiments/mixed-comparison";
import { exportMixedComparison } from "@/accuracy/experiments/mixed-records";
import { MixedComparisonError, mixedComparisonInputSchema } from "@/accuracy/experiments/mixed-types";
import { can } from "@/modules/auth/roles";
import { sessionContext } from "@/modules/auth/session";
import { authorizedSourceWorkspace } from "../request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
registerAccuracyStack();

const querySchema = z.object({
  source_workspace_id: z.string().trim().min(1),
  comparison_id: z.string().trim().min(1),
  format: z.enum(["json", "jsonl"]).default("json"),
}).strict();

/** Expose typed input failures without disclosing source or storage details. */
function knownError(error: unknown, operation: "request" | "query") {
  if (error instanceof z.ZodError) {
    return NextResponse.json({ error: `Invalid comparison ${operation}`, code: "invalid_input" }, { status: 400 });
  }
  if (error instanceof MixedComparisonError) {
    if (error.code === "not_found") {
      return NextResponse.json({ error: "Comparison not found in source workspace" }, { status: 404 });
    }
    return NextResponse.json({ error: `Invalid comparison ${operation}`, code: error.code }, { status: 400 });
  }
  return null;
}

/** Replay exact nominations using the authenticated server actor and validation capability. */
export async function POST(request: Request) {
  const session = await sessionContext();
  if (!session.signed_in) return NextResponse.json({ error: "Sign in to access experiments" }, { status: 401 });
  if (!can(session.role, "validate")) return NextResponse.json({ error: "You do not have validation capability" }, { status: 403 });
  try {
    let json: unknown;
    try { json = await request.json(); }
    catch (error) {
      if (error instanceof SyntaxError) return NextResponse.json({ error: "Invalid comparison request", code: "invalid_input" }, { status: 400 });
      throw error;
    }
    const body = mixedComparisonInputSchema.parse(json);
    if (!await authorizedSourceWorkspace(body.source_workspace_id, session)) {
      return NextResponse.json({ error: "Source workspace not found" }, { status: 404 });
    }
    const comparison = await runMixedComparison({ ...body, actor: session.actor });
    return NextResponse.json({ comparison }, { status: 201 });
  } catch (error) {
    const response = knownError(error, "request");
    if (response) return response;
    console.error("Could not start mixed comparison", error);
    return NextResponse.json({ error: "Could not start mixed comparison" }, { status: 500 });
  }
}

/** Export durable evidence and linked calls only through the original authorized source. */
export async function GET(request: Request) {
  const session = await sessionContext();
  if (!session.signed_in) return NextResponse.json({ error: "Sign in to access experiments" }, { status: 401 });
  try {
    const params = new URL(request.url).searchParams;
    if ([...new Set(params.keys())].some(key => params.getAll(key).length !== 1)) {
      return NextResponse.json({ error: "Invalid comparison query", code: "invalid_input" }, { status: 400 });
    }
    const query = querySchema.parse(Object.fromEntries(params));
    if (!await authorizedSourceWorkspace(query.source_workspace_id, session)) {
      return NextResponse.json({ error: "Source workspace not found" }, { status: 404 });
    }
    const exported = await exportMixedComparison(query);
    if (exported === null) return NextResponse.json({ error: "Comparison not found in source workspace" }, { status: 404 });
    return new Response(exported, { headers: {
      "content-type": query.format === "jsonl" ? "application/x-ndjson; charset=utf-8" : "application/json; charset=utf-8",
      "cache-control": "private, no-store",
    } });
  } catch (error) {
    const response = knownError(error, "query");
    if (response) return response;
    console.error("Could not export mixed comparison", error);
    return NextResponse.json({ error: "Could not export mixed comparison" }, { status: 500 });
  }
}
