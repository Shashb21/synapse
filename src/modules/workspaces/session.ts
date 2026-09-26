import { cookies } from "next/headers";
import { currentSession, SESSION_COOKIE, type Session } from "@/modules/auth/session";
import { selectedWorkspaceId, WORKSPACE_COOKIE, WORKSPACE_COOKIE_TTL_MS, workspaceCookieValue } from "./context";
import { claimDefaultWorkspace, getWorkspace, listWorkspacesFor, memberRole, type WorkspaceWithRole } from "./store";

/**
 * Who a signed-in person is for membership: their email, which a session only
 * carries when the identity provider verified it (modules/auth/idp.ts), else
 * `provider:subject`. That form can never match an email invite or
 * OWNER_EMAILS. An unverified email + password account is `password:<account id>`. `provider_id` is optional for backwards compatibility; sessions
 * already store the subject as `provider:subject`.
 */
export function principalOf(
  session: Pick<Session, "email" | "subject"> & { provider_id?: string | null },
): string {
  const email = session.email?.trim();
  if (email) return email;
  const subject = session.subject.trim();
  const provider = session.provider_id?.trim();
  // An email + password session carries its email only once it is verified
  // (modules/auth/password-login.ts); until then the person is `password:<account id>`.
  if (provider === "password") return subject.startsWith("password:") ? subject : `password:${subject}`;
  if (provider && !subject.startsWith(`${provider}:`)) return `${provider}:${subject}`;
  return subject;
}

/** The signed-in person's workspaces. The very first sign-in claims the Default workspace. */
export async function myWorkspaces(): Promise<{ session: Session; workspaces: WorkspaceWithRole[] } | null> {
  const session = await currentSession();
  if (!session) return null;
  const principal = principalOf(session);
  await claimDefaultWorkspace(principal);
  return { session, workspaces: await listWorkspacesFor(principal) };
}

/** Selects a workspace for this session after checking membership. */
export async function selectWorkspace(workspaceId: string): Promise<WorkspaceWithRole> {
  const session = await currentSession();
  if (!session) throw new Error("Sign in first.");
  const workspace = await getWorkspace(workspaceId);
  if (!workspace) throw new Error("That workspace does not exist.");
  const role = await memberRole(workspaceId, principalOf(session));
  if (!role) throw new Error("You are not a member of that workspace.");
  const jar = await cookies();
  const sessionId = jar.get(SESSION_COOKIE)?.value ?? session.id;
  jar.set(WORKSPACE_COOKIE, workspaceCookieValue(workspaceId, sessionId), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: WORKSPACE_COOKIE_TTL_MS / 1000,
  });
  return { ...workspace, role };
}

export async function clearWorkspaceSelection(): Promise<void> {
  (await cookies()).delete(WORKSPACE_COOKIE);
}

/** The workspace this request works in, if one is selected and the person is still a member. */
export async function currentWorkspace(): Promise<WorkspaceWithRole | null> {
  const id = await selectedWorkspaceId();
  if (!id) return null;
  const [workspace, session] = await Promise.all([getWorkspace(id), currentSession()]);
  if (!workspace || !session) return null;
  const role = await memberRole(id, principalOf(session));
  return role ? { ...workspace, role } : null;
}
