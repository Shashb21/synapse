import { desc } from "drizzle-orm";
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
    });
  return id;
}

export async function listWorkspaces(limit = 50) {
  await ensureAccuracySchema();
  return accuracyDb()
    .select()
    .from(t.accuracyWorkspaces)
    .orderBy(desc(t.accuracyWorkspaces.created_at))
    .limit(limit);
}
