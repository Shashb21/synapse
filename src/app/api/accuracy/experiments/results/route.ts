/** Authenticated original-source history and complete results export. */
import { NextResponse } from "next/server";
import { z } from "zod";
import { registerAccuracyStack } from "@/accuracy";
import { readExperimentResults } from "@/accuracy/experiments/results";
import { serializeExperimentResultsReport } from "@/accuracy/experiments/results-report";
import { sessionContext } from "@/modules/auth/session";
import { authorizedSourceWorkspace } from "../request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
registerAccuracyStack();

const querySchema = z.object({
  source_workspace_id: z.string().trim().min(1),
  format: z.enum(["json", "jsonl"]).default("json"),
}).strict();

/** Return retained result history only for a signed-in owner of the original source. */
export async function GET(request: Request) {
  const session = await sessionContext();
  if (!session.signed_in) return NextResponse.json({ error: "Sign in to access experiments" }, { status: 401 });
  try {
    const params = new URL(request.url).searchParams;
    if ([...params.keys()].some(key => params.getAll(key).length !== 1)) {
      return NextResponse.json({ error: "Invalid results query" }, { status: 400 });
    }
    const query = querySchema.safeParse(Object.fromEntries(params));
    if (!query.success) return NextResponse.json({ error: "Invalid results query" }, { status: 400 });
    if (!await authorizedSourceWorkspace(query.data.source_workspace_id, session)) {
      return NextResponse.json({ error: "Source workspace not found" }, { status: 404 });
    }
    const report = await readExperimentResults({ source_workspace_id: query.data.source_workspace_id });
    return new Response(serializeExperimentResultsReport(report, query.data.format), { headers: {
      "content-type": query.data.format === "jsonl" ? "application/x-ndjson; charset=utf-8" : "application/json; charset=utf-8",
      "cache-control": "private, no-store",
    } });
  } catch (error) {
    console.error("Could not read experiment results", error);
    return NextResponse.json({ error: "Could not read experiment results" }, { status: 500 });
  }
}
