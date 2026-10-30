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
    return NextResponse.json({ safe_error: true, error: "workspace_id is required" }, { status: 400 });
  }
  const workspace = await getWorkspace(workspace_id);
  if (!workspace) {
    return NextResponse.json({ safe_error: true, error: "Unknown workspace" }, { status: 404 });
  }
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
    const snapshot = await createWorkshopSnapshot({
      workspace_id: body.workspace_id,
      actor: await labActor(),
      note: body.note,
      scene: body.scene,
    });
    return NextResponse.json({ ok: true, snapshot });
  } catch (error) {
    const known = labRequestErrorResponse(error);
    if (known) return known;
    const message = labErrorMessage(error, "We couldn’t confirm the workshop snapshot. Check the workshop state before saving it again.");
    const status = /not ready|Partial|validated|No live gaps/i.test(message) ? 409 : 400;
    return NextResponse.json({ ok: false, safe_error: true, error: message }, { status });
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
    const snapshot = await setWorkshopScene(body);
    return NextResponse.json({ ok: true, snapshot });
  } catch (error) {
    const known = labRequestErrorResponse(error);
    if (known) return known;
    const message = labErrorMessage(error, "We couldn’t confirm the workshop scene change. Check the current workshop scene before changing it again.");
    return NextResponse.json({ ok: false, safe_error: true, error: message }, { status: 400 });
  }
}
