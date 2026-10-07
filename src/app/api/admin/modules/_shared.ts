import { NextResponse } from "next/server";
import { ownerOnlyJson } from "@/modules/auth/owner";
import { NotOwnerError, UnknownWorkspaceError, withAdminWorkspace, type AdminWorkspace } from "@/modules/workspaces/admin-context";

/**
 * The owner console runs stages, evals and hillclimb sweeps here rather than
 * through /api/modules, which needs a customer workspace selection the owner
 * never has (KAN-62). A request names the workspace the page showed
 * (`workspace_id`), so a run lands where the owner saw it would; without one it
 * uses the console's working workspace.
 */
export function requestedWorkspace(body: Record<string, unknown> | null | undefined): string | null {
  const id = typeof body?.workspace_id === "string" ? body.workspace_id.trim() : "";
  return id || null;
}

/** Runs `fn` in the owner console's workspace; owner and workspace failures become JSON. */
export async function inAdminWorkspace(
  body: Record<string, unknown> | null | undefined,
  fn: (workspace: AdminWorkspace) => Promise<NextResponse>,
): Promise<NextResponse> {
  try {
    return await withAdminWorkspace(fn, requestedWorkspace(body));
  } catch (error) {
    if (error instanceof NotOwnerError) return ownerOnlyJson();
    if (error instanceof UnknownWorkspaceError) {
      return NextResponse.json({ error: error.message, code: "no_workspace" }, { status: 404 });
    }
    throw error;
  }
}

/** The JSON body of a request that will be read again by the handler it is passed to. */
export async function peekBody(request: Request): Promise<Record<string, unknown> | null> {
  const parsed = (await request.clone().json().catch(() => null)) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
}
