import { NextResponse } from "next/server";
import { z } from "zod";
import { registerAccuracyStack } from "@/accuracy";
import { createOrganization, createWorkspace, listWorkspaces } from "@/accuracy/store/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

registerAccuracyStack();

export async function GET() {
  const workspaces = await listWorkspaces();
  return NextResponse.json({ workspaces });
}

const createSchema = z.object({
  name: z.string().min(2).max(120),
  slug: z.string().min(2).max(80).regex(/^[a-z0-9-]+$/),
  org_name: z.string().min(2).max(120).optional(),
});

export async function POST(req: Request) {
  try {
    const body = createSchema.parse(await req.json());
    const org_id = await createOrganization(body.org_name ?? `${body.name} org`);
    const workspace_id = await createWorkspace({
      org_id,
      name: body.name,
      slug: body.slug,
    });
    return NextResponse.json({ ok: true, org_id, workspace_id, slug: body.slug });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not create workspace";
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
