import { ownerAccess } from "@/modules/auth/owner";
import { currentSession } from "@/modules/auth/session";
import { currentWorkspace, principalOf } from "@/modules/workspaces/session";
import { listWorkspacesFor } from "@/modules/workspaces/store";
import type { WorkspaceTagModel } from "./model";

export type WorkspaceTagState =
  | { state: "ready"; tag: WorkspaceTagModel }
  /** No valid session (expired or signed out): send them to /login. */
  | { state: "signed_out" }
  /** Signed in, but no workspace is selected or the selection no longer verifies. */
  | { state: "no_workspace" }
  /** The store could not be read (e.g. Postgres not configured yet): render without a tag. */
  | { state: "unavailable" };

/** Server-side: the data behind the workspace tag, and whether this request may use the customer app. */
export async function loadWorkspaceTag(): Promise<WorkspaceTagState> {
  try {
    const session = await currentSession();
    if (!session) return { state: "signed_out" };
    const current = await currentWorkspace();
    if (!current) return { state: "no_workspace" };
    const [workspaces, access] = await Promise.all([
      listWorkspacesFor(principalOf(session)),
      ownerAccess().catch(() => ({ owner: false })),
    ]);
    return {
      state: "ready",
      tag: {
        current: { id: current.id, name: current.name, role: current.role },
        workspaces: workspaces.map(({ id, name, role }) => ({ id, name, role })),
        person: { name: session.actor.name, email: session.email, owner: access.owner },
      },
    };
  } catch {
    return { state: "unavailable" };
  }
}
