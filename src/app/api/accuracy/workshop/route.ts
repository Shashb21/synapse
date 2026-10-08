import { AssemblyReviewError } from "@/accuracy/domain/assembly-review";
import { AccuracyPausedError, assertAccuracyCanProgress } from "@/accuracy/kernel/omission-pause";
import { ownerGate } from "@/modules/auth/owner";
import { NextResponse } from "next/server";
import { z } from "zod";
import { registerAccuracyStack } from "@/accuracy";
import { getWorkspace } from "@/accuracy/store/tenant";
import {
  createWorkshopSnapshot,
  latestWorkshopSnapshot,
  setWorkshopScene,
  workshopReadiness,
} from "@/accuracy/store/workshop-store";
import {
  labActor,
  labErrorMessage,
  labRequestErrorResponse,
  parseLabBody,
  requireLabWorkspace,
} from "@/app/api/accuracy/_lib/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

registerAccuracyStack();

export async function GET(request: Request) {
  const denied = await ownerGate();
  if (denied) return denied;
  const { searchParams } = new URL(request.url);
  const workspace_id = searchParams.get("workspace_id")?.trim() ?? "";
  if (!workspace_id) {
    return NextResponse.json({ error: "workspace_id is required" }, { status: 400 });
  }
  const workspace = await getWorkspace(workspace_id);
  if (!workspace) {
    return NextResponse.json({ error: "Unknown workspace" }, { status: 404 });
  }
  try {
    const { readiness, inventory } = await workshopReadiness(workspace_id);
    const snapshot = await latestWorkshopSnapshot(workspace_id);
    return NextResponse.json({
      workspace: { id: workspace.id, name: workspace.name, slug: workspace.slug },
      readiness,
      inventory_counts: {
        gaps: inventory.gaps.length,
        tactics: inventory.tactics.length,
        joins: inventory.joins.length,
      },
      snapshot,
    });
  } catch (error) {
    if (error instanceof AssemblyReviewError) return NextResponse.json({ ok: false, code: error.code, error: error.message }, { status: error.code === "invalid_input" ? 400 : error.code === "not_found" ? 404 : error.code === "forbidden" ? 403 : 409 });
    throw error;
  }
}

const createSchema = z.object({
  workspace_id: z.string().min(1),
  note: z.string().optional(),
  scene: z.enum(["gaps", "prioritize"]).optional(),
  /** Ignored: the snapshot is credited to the signed-in owner. */
  actor_name: z.string().optional(),
  actor_function: z.string().optional(),
});

export async function POST(request: Request) {
  const denied = await ownerGate();
  if (denied) return denied;
  try {
    const body = await parseLabBody(request, createSchema);
    await requireLabWorkspace(body.workspace_id);
    await assertAccuracyCanProgress(body.workspace_id, "gantt_project");
    const snapshot = await createWorkshopSnapshot({
      workspace_id: body.workspace_id,
      actor: await labActor(),
      note: body.note,
      scene: body.scene,
    });
    return NextResponse.json({ ok: true, snapshot });
  } catch (error) {
    if (error instanceof AccuracyPausedError) {
      return NextResponse.json({ ok: false, error: error.message, blockers: error.blockers }, { status: 409 });
    }
    const known = labRequestErrorResponse(error);
    if (known) return known;
    const message = labErrorMessage(error, "Could not save workshop state");
    const status = /not ready|Partial|validated|No live gaps/i.test(message) ? 409 : 400;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}

const sceneSchema = z.object({
  workspace_id: z.string().min(1),
  snapshot_id: z.string().min(1),
  scene: z.enum(["gaps", "prioritize"]),
});

export async function PATCH(request: Request) {
  const denied = await ownerGate();
  if (denied) return denied;
  try {
    const body = await parseLabBody(request, sceneSchema);
    await requireLabWorkspace(body.workspace_id);
    await assertAccuracyCanProgress(body.workspace_id, "prioritize");
    const snapshot = await setWorkshopScene(body);
    return NextResponse.json({ ok: true, snapshot });
  } catch (error) {
    if (error instanceof AccuracyPausedError) {
      return NextResponse.json({ ok: false, error: error.message, blockers: error.blockers }, { status: 409 });
    }
    const known = labRequestErrorResponse(error);
    if (known) return known;
    const message = labErrorMessage(error, "Could not update workshop scene");
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
