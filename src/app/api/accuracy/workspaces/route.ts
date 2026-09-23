import { NextResponse } from "next/server";
import { z } from "zod";
import { registerAccuracyStack } from "@/accuracy";
import { normalizePlanLabel, workspacePlanLabel } from "@/accuracy/domain/plan-label";
import {
  createOrganization,
  createWorkspace,
  getWorkspace,
  listWorkspaces,
} from "@/accuracy/store/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

registerAccuracyStack();

function withPlanLabel<T extends { planning_context?: unknown }>(workspace: T) {
  return { ...workspace, plan_label: workspacePlanLabel(workspace) };
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const workspaceId = searchParams.get("workspace_id")?.trim() ?? "";
  if (workspaceId) {
    const workspace = await getWorkspace(workspaceId);
    if (!workspace) {
      return NextResponse.json({ error: "Unknown workspace" }, { status: 404 });
    }
    return NextResponse.json({ workspace: withPlanLabel(workspace) });
  }
  const includeArchived = searchParams.get("include_archived") === "1";
  const workspaces = await listWorkspaces(50, { includeArchived });
  return NextResponse.json({ workspaces: workspaces.map(withPlanLabel) });
}

const createSchema = z.object({
  name: z.string().min(2).max(120),
  slug: z.string().min(2).max(80).regex(/^[a-z0-9-]+$/),
  org_name: z.string().min(2).max(120).optional(),
  plan_label: z.enum(["IEP", "IEGP"]).optional(),
});

export async function POST(req: Request) {
  try {
    const body = createSchema.parse(await req.json());
    const org_id = await createOrganization(body.org_name ?? `${body.name} org`);
    const plan_label = normalizePlanLabel(body.plan_label) ?? "IEGP";
    const workspace_id = await createWorkspace({
      org_id,
      name: body.name,
      slug: body.slug,
      plan_label,
    });
    return NextResponse.json({
      ok: true,
      org_id,
      workspace_id,
      slug: body.slug,
      plan_label,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not create workspace";
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
