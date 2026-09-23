import { NextResponse } from "next/server";
import { z } from "zod";
import { registerAccuracyStack } from "@/accuracy";
import {
  sweepStaleAccuracyRuns,
  summarizeAccuracyRunCost,
  DEFAULT_STALE_RUN_MAX_AGE_MS,
} from "@/accuracy/kernel/observability";
import {
  archiveWorkspace,
  deleteWorkspace,
  unarchiveWorkspace,
} from "@/accuracy/store/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

registerAccuracyStack();

const bodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("sweep_stale_runs"),
    workspace_id: z.string().min(1).optional(),
    max_age_ms: z.number().int().positive().max(7 * 24 * 60 * 60 * 1000).optional(),
  }),
  z.object({
    action: z.literal("archive_workspace"),
    workspace_id: z.string().min(1),
  }),
  z.object({
    action: z.literal("unarchive_workspace"),
    workspace_id: z.string().min(1),
  }),
  z.object({
    action: z.literal("delete_workspace"),
    workspace_id: z.string().min(1),
  }),
  z.object({
    action: z.literal("cost_rollup"),
    workspace_id: z.string().min(1),
  }),
]);

export async function POST(req: Request) {
  try {
    const body = bodySchema.parse(await req.json());
    if (body.action === "sweep_stale_runs") {
      const result = await sweepStaleAccuracyRuns({
        workspace_id: body.workspace_id,
        maxAgeMs: body.max_age_ms ?? DEFAULT_STALE_RUN_MAX_AGE_MS,
      });
      return NextResponse.json({ ok: true, ...result });
    }
    if (body.action === "archive_workspace") {
      const workspace = await archiveWorkspace(body.workspace_id);
      return NextResponse.json({ ok: true, workspace });
    }
    if (body.action === "unarchive_workspace") {
      const workspace = await unarchiveWorkspace(body.workspace_id);
      return NextResponse.json({ ok: true, workspace });
    }
    if (body.action === "delete_workspace") {
      const result = await deleteWorkspace(body.workspace_id);
      return NextResponse.json({ ok: true, ...result });
    }
    const rollup = await summarizeAccuracyRunCost(body.workspace_id);
    return NextResponse.json({ ok: true, rollup });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Hygiene action failed";
    const status = message.startsWith("Unknown workspace") ? 404 : 400;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
