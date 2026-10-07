import { NextResponse } from "next/server";
import { selectedWorkspaceId } from "@/modules/workspaces/context";
import { myWorkspaces, selectWorkspace } from "@/modules/workspaces/session";
import { replaceContentsOf, startChoice } from "@/modules/workspaces/contents";
import { createWorkspace } from "@/modules/workspaces/store";
import { errorResponse, HttpError, NEW_WORKSPACE_REDIRECT, readBody, requireSession } from "./_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The signed-in person's workspaces (the first sign-in claims the Default workspace). */
export async function GET() {
  try {
    const mine = await myWorkspaces();
    if (!mine) throw new HttpError(401, "Sign in first.");
    const selected = await selectedWorkspaceId();
    return NextResponse.json({
      person: { name: mine.session.actor.name, email: mine.session.email },
      current_id: mine.workspaces.some((ws) => ws.id === selected) ? selected : null,
      workspaces: mine.workspaces.map(({ id, name, role, created_at, created_by, demo }) => ({
        id,
        name,
        role,
        created_at,
        created_by,
        demo,
      })),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * Creates a workspace owned by the signed-in person and opens it. `start`:
 * "blank" (the default) leaves it empty for the setup wizard; "demo" loads the
 * full Velmara demo (seed.ts) and flags the workspace as demo.
 */
export async function POST(request: Request) {
  try {
    const { principal } = await requireSession();
    const body = await readBody(request);
    const start = startChoice(body.start);
    const created = await createWorkspace({
      name: String(body.name ?? ""),
      owner: principal,
      demo: start === "demo",
      // Off unless asked for: the owner turns AI assistance on from the workspace menu.
      ai_enabled: body.ai === true,
    });
    if (start === "demo") await replaceContentsOf(created.id, "demo");
    const workspace = await selectWorkspace(created.id);
    return NextResponse.json(
      {
        ok: true,
        workspace: {
          id: workspace.id,
          name: workspace.name,
          role: workspace.role,
          created_at: workspace.created_at,
          demo: workspace.demo,
        },
        // A demo workspace is already set up: open it. A blank one starts in the setup wizard.
        redirect: start === "demo" ? "/" : NEW_WORKSPACE_REDIRECT,
      },
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
