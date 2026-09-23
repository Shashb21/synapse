import { and, desc, eq, isNull } from "drizzle-orm";
import { accuracyDb, ensureAccuracySchema } from "./db";
import * as t from "./schema";
import { newId, nowIso } from "@/modules/kernel/ids";

export async function createOrganization(name: string) {
  await ensureAccuracySchema();
  const id = newId("org");
  await accuracyDb()
    .insert(t.accuracyOrganizations)
    .values({ id, name, created_at: nowIso() });
  return id;
}

/** One workspace = one IEGP within an org. */
export async function createWorkspace(args: { org_id: string; name: string; slug: string }) {
  await ensureAccuracySchema();
  const id = newId("ws");
  await accuracyDb()
    .insert(t.accuracyWorkspaces)
    .values({
      id,
      org_id: args.org_id,
      name: args.name,
      slug: args.slug,
      planning_context: null,
      created_at: nowIso(),
      archived_at: null,
    });
  return id;
}

/** Active workspaces by default; pass `includeArchived` to soft-hidden rows too. */
export async function listWorkspaces(limit = 50, opts?: { includeArchived?: boolean }) {
  await ensureAccuracySchema();
  const q = accuracyDb().select().from(t.accuracyWorkspaces);
  const rows = opts?.includeArchived
    ? await q.orderBy(desc(t.accuracyWorkspaces.created_at)).limit(limit)
    : await q
        .where(isNull(t.accuracyWorkspaces.archived_at))
        .orderBy(desc(t.accuracyWorkspaces.created_at))
        .limit(limit);
  return rows;
}

export async function getWorkspace(workspace_id: string) {
  await ensureAccuracySchema();
  const rows = await accuracyDb()
    .select()
    .from(t.accuracyWorkspaces)
    .where(eq(t.accuracyWorkspaces.id, workspace_id))
    .limit(1);
  return rows[0] ?? null;
}

/** Soft-hide or restore a workspace. Does not delete ledger data. */
export async function setWorkspaceArchived(workspace_id: string, archived: boolean) {
  await ensureAccuracySchema();
  const archived_at = archived ? nowIso() : null;
  const updated = await accuracyDb()
    .update(t.accuracyWorkspaces)
    .set({ archived_at })
    .where(eq(t.accuracyWorkspaces.id, workspace_id))
    .returning({ id: t.accuracyWorkspaces.id, archived_at: t.accuracyWorkspaces.archived_at });
  return updated[0] ?? null;
}

export async function getWorkspaceOrgId(workspace_id: string): Promise<string | null> {
  const workspace = await getWorkspace(workspace_id);
  return workspace?.org_id ?? null;
}

/** True when the workspace exists and is not soft-hidden. */
export async function isWorkspaceActive(workspace_id: string): Promise<boolean> {
  await ensureAccuracySchema();
  const rows = await accuracyDb()
    .select({ id: t.accuracyWorkspaces.id })
    .from(t.accuracyWorkspaces)
    .where(and(eq(t.accuracyWorkspaces.id, workspace_id), isNull(t.accuracyWorkspaces.archived_at)))
    .limit(1);
  return rows.length > 0;
}
