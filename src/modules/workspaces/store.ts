import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { ensureWorkspaceSchema, setWorkspaceSchemaLookup, sharedDb } from "@/lib/iegp/db";
import { nowIso } from "@/modules/kernel/ids";
import { DEFAULT_SCHEMA, runInWorkspace } from "./context";

/**
 * Workspaces are shared records (public schema); each one's IEGP data lives in
 * its own Postgres schema. People are members by email (or, for a sign-in with
 * no email, by the provider subject), so an invite works before they first log in.
 */

const DDL = [
  `CREATE TABLE IF NOT EXISTS workspaces (
    id text PRIMARY KEY,
    name text NOT NULL,
    schema_name text NOT NULL UNIQUE,
    created_by text NOT NULL,
    created_at text NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS workspace_members (
    workspace_id text NOT NULL,
    principal text NOT NULL,
    role text NOT NULL,
    added_by text NOT NULL,
    added_at text NOT NULL,
    PRIMARY KEY (workspace_id, principal)
  )`,
];

/** The workspace that holds the data from before workspaces existed. */
export const DEFAULT_WORKSPACE_ID = "default";

export type WorkspaceRole = "owner" | "member";
export type Workspace = { id: string; name: string; schema_name: string; created_by: string; created_at: string };
export type WorkspaceWithRole = Workspace & { role: WorkspaceRole };
export type WorkspaceMember = { principal: string; role: WorkspaceRole; added_by: string; added_at: string };

let ready: Promise<void> | null = null;
function ensureTables(): Promise<void> {
  ready ??= (async () => {
    for (const stmt of DDL) await sharedDb().execute(sql.raw(stmt));
  })();
  return ready;
}

type Row = Record<string, unknown>;
async function rows(query: ReturnType<typeof sql>): Promise<Row[]> {
  await ensureTables();
  return (await sharedDb().execute(query)) as unknown as Row[];
}

const schemaCache = new Map<string, string>();
setWorkspaceSchemaLookup(async (id) => {
  const cached = schemaCache.get(id);
  if (cached) return cached;
  const found = await getWorkspace(id);
  if (found) schemaCache.set(id, found.schema_name);
  return found?.schema_name ?? null;
});

function normalizePrincipal(principal: string): string {
  const trimmed = principal.trim();
  return trimmed.includes("@") ? trimmed.toLowerCase() : trimmed;
}

function toWorkspace(row: Row): Workspace {
  return {
    id: String(row.id),
    name: String(row.name),
    schema_name: String(row.schema_name),
    created_by: String(row.created_by),
    created_at: String(row.created_at),
  };
}

export async function getWorkspace(id: string): Promise<Workspace | null> {
  const found = await rows(sql`select * from workspaces where id = ${id} limit 1`);
  return found[0] ? toWorkspace(found[0]) : null;
}

export async function listWorkspacesFor(principal: string): Promise<WorkspaceWithRole[]> {
  const found = await rows(sql`
    select w.*, m.role from workspaces w
    join workspace_members m on m.workspace_id = w.id
    where m.principal = ${normalizePrincipal(principal)}
    order by w.created_at asc`);
  return found.map((row) => ({ ...toWorkspace(row), role: row.role === "owner" ? "owner" : "member" }));
}

export async function memberRole(workspaceId: string, principal: string): Promise<WorkspaceRole | null> {
  const found = await rows(sql`
    select role from workspace_members where workspace_id = ${workspaceId} and principal = ${normalizePrincipal(principal)} limit 1`);
  if (!found[0]) return null;
  return found[0].role === "owner" ? "owner" : "member";
}

async function addMember(args: { workspace_id: string; principal: string; role: WorkspaceRole; added_by: string }) {
  await rows(sql`
    insert into workspace_members (workspace_id, principal, role, added_by, added_at)
    values (${args.workspace_id}, ${normalizePrincipal(args.principal)}, ${args.role}, ${args.added_by}, ${nowIso()})
    on conflict (workspace_id, principal) do nothing`);
}

/** Creates a workspace, its schema and every table in it; the creator owns it. */
export async function createWorkspace(args: { name: string; owner: string }): Promise<Workspace> {
  const name = args.name.trim();
  if (name.length < 2) throw new Error("Give the workspace a name.");
  const id = `w${randomBytes(6).toString("hex")}`;
  const schemaName = `ws_${id}`;
  await ensureWorkspaceSchema(schemaName);
  const created_at = nowIso();
  await rows(sql`
    insert into workspaces (id, name, schema_name, created_by, created_at)
    values (${id}, ${name}, ${schemaName}, ${normalizePrincipal(args.owner)}, ${created_at})`);
  await addMember({ workspace_id: id, principal: args.owner, role: "owner", added_by: args.owner });
  schemaCache.set(id, schemaName);
  return { id, name, schema_name: schemaName, created_by: normalizePrincipal(args.owner), created_at };
}

/**
 * The Default workspace (the public schema, holding the data from before
 * workspaces) is claimed by the first person who signs in.
 */
export async function claimDefaultWorkspace(principal: string): Promise<Workspace | null> {
  const existing = await getWorkspace(DEFAULT_WORKSPACE_ID);
  if (existing) return null;
  await rows(sql`
    insert into workspaces (id, name, schema_name, created_by, created_at)
    values (${DEFAULT_WORKSPACE_ID}, ${"Default workspace"}, ${DEFAULT_SCHEMA}, ${normalizePrincipal(principal)}, ${nowIso()})
    on conflict (id) do nothing`);
  await addMember({ workspace_id: DEFAULT_WORKSPACE_ID, principal, role: "owner", added_by: principal });
  return getWorkspace(DEFAULT_WORKSPACE_ID);
}

export async function renameWorkspace(args: { workspace_id: string; name: string; by: string }): Promise<void> {
  if ((await memberRole(args.workspace_id, args.by)) !== "owner") throw new Error("Only the workspace owner can rename it.");
  const name = args.name.trim();
  if (name.length < 2) throw new Error("Give the workspace a name.");
  await rows(sql`update workspaces set name = ${name} where id = ${args.workspace_id}`);
}

/** Any member may invite; the invitee sees the workspace on their next sign-in. */
export async function inviteMember(args: { workspace_id: string; email: string; by: string }): Promise<void> {
  if (!(await memberRole(args.workspace_id, args.by))) throw new Error("You are not a member of this workspace.");
  const email = args.email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("Enter a valid email address.");
  await addMember({ workspace_id: args.workspace_id, principal: email, role: "member", added_by: args.by });
}

export async function removeMember(args: { workspace_id: string; principal: string; by: string }): Promise<void> {
  if ((await memberRole(args.workspace_id, args.by)) !== "owner") throw new Error("Only the workspace owner can remove people.");
  const target = normalizePrincipal(args.principal);
  if ((await memberRole(args.workspace_id, target)) === "owner") throw new Error("The owner cannot be removed.");
  await rows(sql`delete from workspace_members where workspace_id = ${args.workspace_id} and principal = ${target}`);
}

export async function listMembers(workspaceId: string): Promise<WorkspaceMember[]> {
  const found = await rows(sql`
    select principal, role, added_by, added_at from workspace_members where workspace_id = ${workspaceId} order by added_at asc`);
  return found.map((row) => ({
    principal: String(row.principal),
    role: row.role === "owner" ? "owner" : "member",
    added_by: String(row.added_by),
    added_at: String(row.added_at),
  }));
}

/** Runs `fn` with every query in `workspaceId`'s schema (tests, scripts, background work). */
export async function withWorkspace<T>(workspaceId: string, fn: () => Promise<T>): Promise<T> {
  const workspace = await getWorkspace(workspaceId);
  if (!workspace) throw new Error(`Unknown workspace ${workspaceId}`);
  return runInWorkspace({ workspace_id: workspace.id, schema: workspace.schema_name }, fn);
}
