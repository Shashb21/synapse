import { cookies } from "next/headers";
import { ownerAccess } from "@/modules/auth/owner";
import { OWNER_ONLY_MESSAGE } from "@/modules/auth/roles";
import { currentSession, SESSION_COOKIE } from "@/modules/auth/session";
import {
  DEFAULT_SCHEMA,
  DEFAULT_WORKSPACE_ID,
  runInWorkspace,
  selectedWorkspaceId,
  verifyWorkspaceCookie,
  WORKSPACE_COOKIE_TTL_MS,
  workspaceCookieValue,
} from "./context";
import { getWorkspace, type Workspace } from "./store";

/**
 * The owner console's working workspace (KAN-62). The owner is a member of no
 * customer workspace, so the customer app's selection (membership-checked,
 * modules/workspaces/session.ts) can never point at one. The console keeps its
 * own selection instead:
 *
 * - its own cookie, signed with a key of its own and bound to the session, so
 *   it never verifies as the app's workspace cookie and the customer app, the
 *   proxy and the API guard never read it;
 * - read only here, and every read re-checks that the request is the owner's.
 *   A customer holding the cookie gets nothing from it.
 *
 * Admin pages and admin APIs run their workspace reads inside
 * `withAdminWorkspace`, which scopes queries the way `runInWorkspace` does.
 */

export const ADMIN_WORKSPACE_COOKIE = "synapse_admin_workspace";

export class NotOwnerError extends Error {
  constructor(message = OWNER_ONLY_MESSAGE) {
    super(message);
    this.name = "NotOwnerError";
  }
}

export class UnknownWorkspaceError extends Error {
  constructor(message = "That workspace does not exist.") {
    super(message);
    this.name = "UnknownWorkspaceError";
  }
}

export type AdminWorkspace = Pick<Workspace, "id" | "name" | "schema_name" | "demo"> & {
  /** picked: chosen in the console; app: the owner's own app selection; default: nothing chosen. */
  source: "picked" | "app" | "default";
};

const DEFAULT_FALLBACK: AdminWorkspace = {
  id: DEFAULT_WORKSPACE_ID,
  name: "Default workspace",
  schema_name: DEFAULT_SCHEMA,
  demo: false,
  source: "default",
};

type RequestCookies = { get(name: string): { value: string } | undefined };

async function requestCookies(): Promise<RequestCookies | null> {
  try {
    return (await cookies()) as RequestCookies;
  } catch {
    return null; // not inside a request
  }
}

async function requireOwner(): Promise<void> {
  if (!(await ownerAccess()).owner) throw new NotOwnerError();
}

function toAdminWorkspace(workspace: Workspace, source: AdminWorkspace["source"]): AdminWorkspace {
  const { id, name, schema_name, demo } = workspace;
  return { id, name, schema_name, demo, source };
}

/**
 * The workspace admin pages read: the one picked in the console, else the
 * owner's own app selection, else the Default workspace. Owner only.
 */
export async function adminWorkspace(): Promise<AdminWorkspace> {
  await requireOwner();
  const jar = await requestCookies();
  const picked = verifyWorkspaceCookie(
    jar?.get(ADMIN_WORKSPACE_COOKIE)?.value,
    jar?.get(SESSION_COOKIE)?.value,
    Date.now(),
    "admin",
  );
  if (picked) {
    const workspace = await getWorkspace(picked);
    if (workspace) return toAdminWorkspace(workspace, "picked");
  }
  const app = await selectedWorkspaceId().catch(() => null);
  if (app) {
    const workspace = await getWorkspace(app);
    if (workspace) return toAdminWorkspace(workspace, "app");
  }
  const fallback = await getWorkspace(DEFAULT_WORKSPACE_ID);
  return fallback ? toAdminWorkspace(fallback, "default") : DEFAULT_FALLBACK;
}

/**
 * Runs `fn` with every query in the owner console's workspace, or in
 * `workspaceId` when one is named (a trace link that says which workspace its
 * run lives in). Owner only; an unknown id is refused.
 */
export async function withAdminWorkspace<T>(
  fn: (workspace: AdminWorkspace) => Promise<T>,
  workspaceId?: string | null,
): Promise<T> {
  let workspace: AdminWorkspace;
  if (workspaceId) {
    await requireOwner();
    const found = await getWorkspace(workspaceId);
    if (!found) throw new UnknownWorkspaceError();
    workspace = toAdminWorkspace(found, "picked");
  } else {
    workspace = await adminWorkspace();
  }
  return runInWorkspace({ workspace_id: workspace.id, schema: workspace.schema_name }, () => fn(workspace));
}

/** Makes `workspaceId` the console's working workspace for this session. Owner only. */
export async function selectAdminWorkspace(workspaceId: string): Promise<AdminWorkspace> {
  await requireOwner();
  const session = await currentSession();
  if (!session) throw new NotOwnerError("Sign in first.");
  const workspace = await getWorkspace(workspaceId);
  if (!workspace) throw new UnknownWorkspaceError();
  const jar = await cookies();
  const sessionId = jar.get(SESSION_COOKIE)?.value ?? session.id;
  jar.set(ADMIN_WORKSPACE_COOKIE, workspaceCookieValue(workspaceId, sessionId, { purpose: "admin" }), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: WORKSPACE_COOKIE_TTL_MS / 1000,
  });
  return toAdminWorkspace(workspace, "picked");
}

/** Forgets the console's pick; admin pages fall back to the app selection or Default. */
export async function clearAdminWorkspace(): Promise<void> {
  await requireOwner();
  (await cookies()).delete(ADMIN_WORKSPACE_COOKIE);
}

/** Where the picker returns to: a console page only, else the console home. */
export function adminReturnPath(next: string | null | undefined): string {
  const path = (next ?? "").trim();
  if (!/^\/admin(\/|\?|$)/.test(path) || path.startsWith("/admin/workspace")) return "/admin";
  return path;
}
