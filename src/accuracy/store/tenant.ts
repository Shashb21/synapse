import { desc, eq, isNull } from "drizzle-orm";
import { accuracyDb, ensureAccuracySchema } from "./db";
import * as t from "./schema";
import { newId, nowIso } from "@/modules/kernel/ids";
import { WORKSHOP_SNAPSHOT_DDL } from "./workshop-store";

export type WorkspaceDeleteCounts = {
  miss_flag_actions: number;
  provenance: number;
  coverage_joins: number;
  parse_blocks: number;
  source_files: number;
  claims: number;
  runs: number;
  plans: number;
  workshop_snapshots: number;
  workspace: number;
};

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

export async function listWorkspaces(limit = 50, opts?: { includeArchived?: boolean }) {
  await ensureAccuracySchema();
  const query = accuracyDb().select().from(t.accuracyWorkspaces);
  const filtered = opts?.includeArchived
    ? query
    : query.where(isNull(t.accuracyWorkspaces.archived_at));
  return filtered.orderBy(desc(t.accuracyWorkspaces.created_at)).limit(limit);
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

export async function getWorkspaceOrgId(workspace_id: string): Promise<string | null> {
  const workspace = await getWorkspace(workspace_id);
  return workspace?.org_id ?? null;
}

export async function getWorkspaceBySlug(slug: string) {
  await ensureAccuracySchema();
  const rows = await accuracyDb()
    .select()
    .from(t.accuracyWorkspaces)
    .where(eq(t.accuracyWorkspaces.slug, slug))
    .orderBy(desc(t.accuracyWorkspaces.created_at));
  return rows.find((row) => !row.archived_at) ?? rows[0] ?? null;
}

export async function archiveWorkspace(workspace_id: string) {
  const workspace = await getWorkspace(workspace_id);
  if (!workspace) throw new Error(`Unknown workspace: ${workspace_id}`);
  if (workspace.archived_at) return workspace;
  const archived_at = nowIso();
  await accuracyDb()
    .update(t.accuracyWorkspaces)
    .set({ archived_at })
    .where(eq(t.accuracyWorkspaces.id, workspace_id));
  return { ...workspace, archived_at };
}

export async function unarchiveWorkspace(workspace_id: string) {
  const workspace = await getWorkspace(workspace_id);
  if (!workspace) throw new Error(`Unknown workspace: ${workspace_id}`);
  await accuracyDb()
    .update(t.accuracyWorkspaces)
    .set({ archived_at: null })
    .where(eq(t.accuracyWorkspaces.id, workspace_id));
  return { ...workspace, archived_at: null };
}

async function deletedCount(rows: { id: string }[]): Promise<number> {
  return rows.length;
}

/** Hard-delete a workspace and its parse/claim/run rows. Drops the org if it has no workspaces left. */
export async function deleteWorkspace(workspace_id: string): Promise<{
  workspace_id: string;
  org_id: string;
  org_deleted: boolean;
  deleted: WorkspaceDeleteCounts;
}> {
  const workspace = await getWorkspace(workspace_id);
  if (!workspace) throw new Error(`Unknown workspace: ${workspace_id}`);
  await ensureAccuracySchema([WORKSHOP_SNAPSHOT_DDL]);
  const db = accuracyDb();

  const deleted: WorkspaceDeleteCounts = {
    miss_flag_actions: await deletedCount(
      await db
        .delete(t.accuracyMissFlagActions)
        .where(eq(t.accuracyMissFlagActions.workspace_id, workspace_id))
        .returning({ id: t.accuracyMissFlagActions.id }),
    ),
    provenance: await deletedCount(
      await db
        .delete(t.accuracyProvenance)
        .where(eq(t.accuracyProvenance.workspace_id, workspace_id))
        .returning({ id: t.accuracyProvenance.id }),
    ),
    coverage_joins: await deletedCount(
      await db
        .delete(t.accuracyCoverageJoins)
        .where(eq(t.accuracyCoverageJoins.workspace_id, workspace_id))
        .returning({ id: t.accuracyCoverageJoins.id }),
    ),
    parse_blocks: await deletedCount(
      await db
        .delete(t.accuracyParseBlocks)
        .where(eq(t.accuracyParseBlocks.workspace_id, workspace_id))
        .returning({ id: t.accuracyParseBlocks.id }),
    ),
    source_files: await deletedCount(
      await db
        .delete(t.accuracySourceFiles)
        .where(eq(t.accuracySourceFiles.workspace_id, workspace_id))
        .returning({ id: t.accuracySourceFiles.id }),
    ),
    claims: await deletedCount(
      await db
        .delete(t.accuracyClaims)
        .where(eq(t.accuracyClaims.workspace_id, workspace_id))
        .returning({ id: t.accuracyClaims.id }),
    ),
    runs: await deletedCount(
      await db
        .delete(t.accuracyModuleRuns)
        .where(eq(t.accuracyModuleRuns.workspace_id, workspace_id))
        .returning({ id: t.accuracyModuleRuns.id }),
    ),
    plans: await deletedCount(
      await db
        .delete(t.accuracyPlans)
        .where(eq(t.accuracyPlans.workspace_id, workspace_id))
        .returning({ id: t.accuracyPlans.id }),
    ),
    workshop_snapshots: await deletedCount(
      await db
        .delete(t.accuracyWorkshopSnapshots)
        .where(eq(t.accuracyWorkshopSnapshots.workspace_id, workspace_id))
        .returning({ id: t.accuracyWorkshopSnapshots.id }),
    ),
    workspace: 0,
  };

  const removed = await accuracyDb()
    .delete(t.accuracyWorkspaces)
    .where(eq(t.accuracyWorkspaces.id, workspace_id))
    .returning({ id: t.accuracyWorkspaces.id });
  deleted.workspace = removed.length;

  const remaining = await accuracyDb()
    .select({ id: t.accuracyWorkspaces.id })
    .from(t.accuracyWorkspaces)
    .where(eq(t.accuracyWorkspaces.org_id, workspace.org_id))
    .limit(1);
  let org_deleted = false;
  if (remaining.length === 0) {
    await accuracyDb()
      .delete(t.accuracyOrganizations)
      .where(eq(t.accuracyOrganizations.id, workspace.org_id));
    org_deleted = true;
  }

  return {
    workspace_id,
    org_id: workspace.org_id,
    org_deleted,
    deleted,
  };
}
