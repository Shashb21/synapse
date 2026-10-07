import { NextResponse } from "next/server";
import { currentSession, type Session } from "@/modules/auth/session";
import { principalOf } from "@/modules/workspaces/session";
import { getWorkspace, memberRole, type WorkspaceWithRole } from "@/modules/workspaces/store";

/** Where a brand-new workspace goes first: the setup wizard, in "new workspace" mode. */
export const NEW_WORKSPACE_REDIRECT = "/setup?new=1";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** The signed-in person, or a 401. */
export async function requireSession(): Promise<{ session: Session; principal: string }> {
  const session = await currentSession();
  if (!session) throw new HttpError(401, "Sign in first.");
  return { session, principal: principalOf(session) };
}

/** A workspace the signed-in person belongs to, or a 404 (never reveals workspaces they cannot see). */
export async function requireMembership(workspaceId: string): Promise<{
  session: Session;
  principal: string;
  workspace: WorkspaceWithRole;
}> {
  const { session, principal } = await requireSession();
  const [workspace, role] = await Promise.all([getWorkspace(workspaceId), memberRole(workspaceId, principal)]);
  if (!workspace || !role) throw new HttpError(404, "That workspace does not exist or you are not a member.");
  return { session, principal, workspace: { ...workspace, role } };
}

export async function readBody(request: Request): Promise<Record<string, unknown>> {
  return (await request.json().catch(() => ({}))) as Record<string, unknown>;
}

/** Turns a thrown error into JSON: auth problems keep their status, owner-only rules are 403. */
export function errorResponse(error: unknown): NextResponse {
  if (error instanceof HttpError) return NextResponse.json({ error: error.message }, { status: error.status });
  const message = error instanceof Error ? error.message : "Workspace request failed.";
  const status = /^(Only the workspace owner|You are not a member)/.test(message) ? 403 : 400;
  return NextResponse.json({ error: message }, { status });
}
