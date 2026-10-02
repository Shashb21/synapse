import { ownerGate } from "@/modules/auth/owner";
import { NextResponse } from "next/server";
import { z } from "zod";
import { registerAccuracyStack } from "@/accuracy";
import { normalizePlanLabel, workspacePlanLabel } from "@/accuracy/domain/plan-label";
import {
  createOrganization,
  createWorkspace,
  DuplicateWorkspaceSlugError,
  getWorkspace,
  getWorkspaceBySlug,
  listWorkspaces,
} from "@/accuracy/store/tenant";
import { labErrorMessage, labRequestErrorResponse, parseLabBody } from "@/app/api/accuracy/_lib/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

registerAccuracyStack();

function withPlanLabel<T extends { planning_context?: unknown }>(workspace: T) {
  return { ...workspace, plan_label: workspacePlanLabel(workspace) };
}

export async function GET(request: Request) {
  const denied = await ownerGate();
  if (denied) return denied;
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
  const workspaces = await listWorkspaces(undefined, { includeArchived });
  return NextResponse.json({ workspaces: workspaces.map(withPlanLabel) });
}

const createSchema = z.object({
  name: z.string().min(2).max(120),
  slug: z
    .string()
    .min(2)
    .max(80)
    .regex(/^[a-z0-9-]+$/, "Use lowercase letters, numbers and hyphens only"),
  org_name: z.string().min(2).max(120).optional(),
  plan_label: z.enum(["IEP", "IEGP"]).optional(),
});

export async function POST(req: Request) {
  const denied = await ownerGate();
  if (denied) return denied;
  try {
    const body = await parseLabBody(req, createSchema);
    // Checked before the org is created, so a taken slug leaves no orphan org behind.
    if (await getWorkspaceBySlug(body.slug)) throw new DuplicateWorkspaceSlugError(body.slug);
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
    const known = labRequestErrorResponse(error);
    if (known) return known;
    const message = labErrorMessage(error, "Could not create workspace");
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
