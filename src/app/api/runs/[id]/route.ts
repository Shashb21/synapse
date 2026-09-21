import { NextResponse } from "next/server";
import "@/modules";
import { getRun } from "@/modules/kernel/observability";
import { listEdits } from "@/modules/kernel/edit-records";
import { listSignals } from "@/modules/kernel/hillclimb";
import { listEvalRuns } from "@/modules/kernel/evals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One run's full trace, for the run page's siblings and for automated checks. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const run = await getRun(id);
  if (!run) return NextResponse.json({ error: `Unknown run ${id}` }, { status: 404 });
  const url = new URL(request.url);
  if (url.searchParams.get("with") !== "signals") return NextResponse.json({ run });
  const [edits, signals, evals] = await Promise.all([
    listEdits({ stage: run.stage, limit: 20 }),
    listSignals({ stage: run.stage, limit: 20 }),
    listEvalRuns({ stage: run.stage, limit: 10 }),
  ]);
  return NextResponse.json({ run, edits, signals, evals });
}
