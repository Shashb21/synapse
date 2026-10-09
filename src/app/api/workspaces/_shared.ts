import { NextResponse } from "next/server";
import { currentSession, type Session } from "@/modules/auth/session";
import { readJsonBody } from "@/modules/auth/api-guard";
import { principalOf } from "@/modules/workspaces/session";
import { getWorkspace, memberRole, WorkspaceLimitError, type WorkspaceWithRole } from "@/modules/workspaces/store";
import { BodyTooLargeError } from "@/lib/http/body-limit";

/** Where a brand-new workspace goes first: the setup wizard, in "new workspace" mode. */
export const NEW_WORKSPACE_REDIRECT = "/setup?new=1";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
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

/**
 * The body as an object: none at all is `{}`, malformed JSON is a 400 (KAN-18),
 * and a body over the size limit is a 413 (KAN-20).
 */
export async function readBody(request: Request): Promise<Record<string, unknown>> {
  try {
    return await readJsonBody(request, { allowEmpty: true });
  } catch (error) {
    if (error instanceof BodyTooLargeError) throw new HttpError(error.status, error.message, "too_large");
    throw new HttpError(400, "The request body is not valid JSON.", "invalid_json");
  }
}

/** Turns a thrown error into JSON: auth problems keep their status, owner-only rules are 403. */
export function errorResponse(error: unknown): NextResponse {
  if (error instanceof HttpError) {
    return NextResponse.json(error.code ? { error: error.message, code: error.code } : { error: error.message }, { status: error.status });
  }
  if (error instanceof WorkspaceLimitError) return NextResponse.json({ error: error.message, code: "workspace_limit" }, { status: 429 });
  const message = error instanceof Error ? error.message : "Workspace request failed.";
  const status = /^(Only the workspace owner|You are not a member)/.test(message) ? 403 : 400;
  return NextResponse.json({ error: message }, { status });
}
