import { ownerGate } from "@/modules/auth/owner";
import { NextResponse } from "next/server";
import { z } from "zod";
import { registerAccuracyStack } from "@/accuracy";
import { getWorkspace, getWorkspaceOrgId } from "@/accuracy/store/tenant";
import {
  createWorkshopSnapshot,
  latestWorkshopSnapshot,
  setWorkshopScene,
  workshopReadiness,
} from "@/accuracy/store/workshop-store";
import type { ActorFunction } from "@/lib/iegp/enums";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

registerAccuracyStack();

function actorFrom(body: { actor_name?: string; actor_function?: string }) {
  return {
    name: body.actor_name?.trim() || "Workshop facilitator",
    function: (body.actor_function?.trim() || "medical_affairs") as ActorFunction,
  };
}

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
    return NextResponse.json({ error: "Unknown workspace_id" }, { status: 404 });
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
  actor_name: z.string().min(1).optional(),
  actor_function: z.string().min(1).optional(),
});

export async function POST(request: Request) {
  const denied = await ownerGate();
  if (denied) return denied;
  try {
    const body = createSchema.parse(await request.json());
    const org_id = await getWorkspaceOrgId(body.workspace_id);
    if (!org_id) {
      return NextResponse.json({ error: "Unknown workspace_id" }, { status: 404 });
    }
    const snapshot = await createWorkshopSnapshot({
      workspace_id: body.workspace_id,
      actor: actorFrom(body),
      note: body.note,
      scene: body.scene,
    });
    return NextResponse.json({ ok: true, snapshot });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not save workshop state";
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
    const body = sceneSchema.parse(await request.json());
    const snapshot = await setWorkshopScene(body);
    return NextResponse.json({ ok: true, snapshot });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not update workshop scene";
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
