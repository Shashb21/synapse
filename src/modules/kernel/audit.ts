import { and, desc, eq, gte, ilike, lte, or, sql, type SQL } from "drizzle-orm";
import { ensurePlatformSchema, sharedDb } from "@/modules/kernel/db";
import { newId } from "@/modules/kernel/ids";
import * as t from "@/modules/kernel/schema";
import { REQUEST_ID_HEADER } from "@/modules/kernel/request-id";

export { REQUEST_ID_HEADER, requestIdFor } from "@/modules/kernel/request-id";

/**
 * The platform audit log (KAN-87): one append-only row per change or security
 * event, across the owner console, sign-in and the customer app. Rows are never
 * updated or deleted — the database refuses it (AUDIT_DDL) — and no reset or
 * wipe touches the table.
 */

export const AUDIT_CATEGORIES = ["admin", "auth", "config", "workspace", "plan", "ai"] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];


export type AuditActor = {
  /** Account id or email; "system" for the platform itself; "anonymous" before sign-in. */
  principal: string;
  name: string;
  role: string | null;
};

export type AuditEventInput = {
  category: AuditCategory;
  action: string;
  entity_type?: string | null;
  entity_id?: string | null;
  before?: unknown;
  after?: unknown;
  rationale?: string | null;
  /** Omitted: taken from the signed-in session (or "anonymous"). */
  actor?: AuditActor;
  customer_id?: string | null;
  /** Omitted: the workspace the request is scoped to, if any. */
  workspace_id?: string | null;
  run_id?: string | null;
  meta?: Record<string, unknown> | null;
};

export type AuditEvent = {
  id: string;
  at: string;
  actor_principal: string;
  actor_name: string;
  actor_role: string | null;
  customer_id: string | null;
  workspace_id: string | null;
  category: AuditCategory;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  before: unknown;
  after: unknown;
  rationale: string | null;
  request_id: string | null;
  run_id: string | null;
  ip: string | null;
  user_agent: string | null;
  meta: Record<string, unknown> | null;
};

/** Field names whose values never reach the log, however deep they sit. */
const SECRET_KEY = /password|passphrase|secret|(^|_)token$|api[_-]?key|^key$|credential|^cookie$|authorization/i;
export const REDACTED = "[redacted]";

/** A copy with every secret-looking field replaced, so a before/after can never leak one. */
export function redactAuditSecrets<T>(value: T, depth = 0): T {
  if (depth > 12 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redactAuditSecrets(item, depth + 1)) as T;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    // A boolean is a fact ("password_reset": true), never a secret.
    const secret = SECRET_KEY.test(key) && inner !== null && inner !== undefined && typeof inner !== "boolean";
    out[key] = secret ? REDACTED : redactAuditSecrets(inner, depth + 1);
  }
  return out as T;
}

type RequestFacts = { request_id: string | null; ip: string | null; user_agent: string | null };

/** Request id, client IP and user agent, when called inside a request (null outside one). */
async function requestFacts(): Promise<RequestFacts> {
  try {
    const { headers } = await import("next/headers");
    const h = await headers();
    const forwarded = h.get("x-forwarded-for")?.split(",")[0]?.trim();
    return {
      request_id: h.get(REQUEST_ID_HEADER),
      ip: forwarded || h.get("x-real-ip") || null,
      user_agent: h.get("user-agent")?.slice(0, 300) ?? null,
    };
  } catch {
    return { request_id: null, ip: null, user_agent: null };
  }
}

/** Who is acting, from the session when the caller did not say. */
async function sessionActor(): Promise<AuditActor> {
  try {
    const { sessionContext } = await import("@/modules/auth/session");
    const { principalOf } = await import("@/modules/workspaces/session");
    const context = await sessionContext();
    if (context.session) return { principal: principalOf(context.session), name: context.actor.name, role: context.role };
    // Signed out (demo mode keeps a typed name): no principal to vouch for.
    return { principal: context.demo ? "demo" : "anonymous", name: context.actor.name, role: context.role };
  } catch {
    // Outside a request: fall through.
  }
  return { principal: "anonymous", name: "Anonymous", role: null };
}

async function requestWorkspaceId(): Promise<string | null> {
  try {
    const { scopedWorkspaceId } = await import("@/modules/workspaces/context");
    return await scopedWorkspaceId();
  } catch {
    return null;
  }
}

/** A system actor, for things the platform does on its own. */
export const SYSTEM_ACTOR: AuditActor = { principal: "system", name: "Synapse", role: null };

/**
 * Writes one audit row and returns it. Throws when the row cannot be written:
 * callers of state-changing actions let that fail the request, so a change is
 * never reported as done without its record. Use `recordAuditBestEffort` for
 * events that must not block the user (sign-in).
 */
export async function recordAudit(input: AuditEventInput): Promise<AuditEvent> {
  await ensurePlatformSchema();
  const [facts, actor, workspace] = await Promise.all([
    requestFacts(),
    input.actor ? Promise.resolve(input.actor) : sessionActor(),
    input.workspace_id !== undefined ? Promise.resolve(input.workspace_id) : requestWorkspaceId(),
  ]);
  const row = {
    id: newId("aud"),
    actor_principal: actor.principal,
    actor_name: actor.name,
    actor_role: actor.role,
    customer_id: input.customer_id ?? null,
    workspace_id: workspace,
    category: input.category,
    action: input.action,
    entity_type: input.entity_type ?? null,
    entity_id: input.entity_id ?? null,
    before: input.before === undefined ? null : redactAuditSecrets(input.before),
    after: input.after === undefined ? null : redactAuditSecrets(input.after),
    rationale: input.rationale?.trim() || null,
    request_id: facts.request_id,
    run_id: input.run_id ?? null,
    ip: facts.ip,
    user_agent: facts.user_agent,
    meta: input.meta ? redactAuditSecrets(input.meta) : null,
  };
  const [stored] = await sharedDb().insert(t.auditEvents).values(row).returning();
  return toEvent(stored!);
}

/** For events that must never block the person (sign-in, sign-out): logs a failure instead. */
export async function recordAuditBestEffort(input: AuditEventInput): Promise<void> {
  try {
    await recordAudit(input);
  } catch (error) {
    console.error("[audit] could not record", input.category, input.action, error);
  }
}

function toEvent(row: typeof t.auditEvents.$inferSelect): AuditEvent {
  return {
    ...row,
    at: row.at instanceof Date ? row.at.toISOString() : String(row.at),
    category: row.category as AuditCategory,
    meta: (row.meta as Record<string, unknown> | null) ?? null,
  };
}

export type AuditFilter = {
  category?: string | null;
  action?: string | null;
  actor?: string | null;
  workspace_id?: string | null;
  entity_type?: string | null;
  entity_id?: string | null;
  request_id?: string | null;
  /** ISO date or date-time, inclusive. */
  from?: string | null;
  /** ISO date or date-time; a bare date includes the whole day. */
  to?: string | null;
};

export const AUDIT_PAGE_SIZE = 50;
export const AUDIT_EXPORT_LIMIT = 10_000;

function whereFor(filter: AuditFilter): SQL | undefined {
  const parts: SQL[] = [];
  const text = (value?: string | null) => value?.trim() || null;
  const category = text(filter.category);
  if (category) parts.push(eq(t.auditEvents.category, category));
  const action = text(filter.action);
  if (action) parts.push(ilike(t.auditEvents.action, `%${action}%`));
  const actor = text(filter.actor);
  if (actor) parts.push(or(ilike(t.auditEvents.actor_principal, `%${actor}%`), ilike(t.auditEvents.actor_name, `%${actor}%`))!);
  const workspace = text(filter.workspace_id);
  if (workspace) parts.push(eq(t.auditEvents.workspace_id, workspace));
  const entityType = text(filter.entity_type);
  if (entityType) parts.push(eq(t.auditEvents.entity_type, entityType));
  const entityId = text(filter.entity_id);
  if (entityId) parts.push(eq(t.auditEvents.entity_id, entityId));
  const requestId = text(filter.request_id);
  if (requestId) parts.push(eq(t.auditEvents.request_id, requestId));
  const from = text(filter.from);
  if (from && !Number.isNaN(Date.parse(from))) parts.push(gte(t.auditEvents.at, new Date(from)));
  const to = text(filter.to);
  if (to && !Number.isNaN(Date.parse(to))) {
    const end = /^\d{4}-\d{2}-\d{2}$/.test(to) ? new Date(Date.parse(to) + 86_400_000 - 1) : new Date(to);
    parts.push(lte(t.auditEvents.at, end));
  }
  return parts.length ? and(...parts) : undefined;
}

/** Newest first. `page` is 1-based. */
export async function listAuditEvents(
  filter: AuditFilter = {},
  options: { page?: number; limit?: number } = {},
): Promise<{ events: AuditEvent[]; total: number }> {
  await ensurePlatformSchema();
  const limit = Math.max(1, Math.min(options.limit ?? AUDIT_PAGE_SIZE, AUDIT_EXPORT_LIMIT));
  const page = Math.max(1, Math.floor(options.page ?? 1));
  const where = whereFor(filter);
  const [rows, counted] = await Promise.all([
    sharedDb()
      .select()
      .from(t.auditEvents)
      .where(where)
      .orderBy(desc(t.auditEvents.at), desc(t.auditEvents.id))
      .limit(limit)
      .offset((page - 1) * limit),
    sharedDb().select({ n: sql<number>`count(*)::int` }).from(t.auditEvents).where(where),
  ]);
  return { events: rows.map(toEvent), total: counted[0]?.n ?? 0 };
}

export async function getAuditEvent(id: string): Promise<AuditEvent | null> {
  await ensurePlatformSchema();
  const rows = await sharedDb().select().from(t.auditEvents).where(eq(t.auditEvents.id, id)).limit(1);
  return rows[0] ? toEvent(rows[0]) : null;
}

export const AUDIT_CSV_COLUMNS = [
  "id",
  "at",
  "category",
  "action",
  "actor_principal",
  "actor_name",
  "actor_role",
  "customer_id",
  "workspace_id",
  "entity_type",
  "entity_id",
  "before",
  "after",
  "rationale",
  "request_id",
  "run_id",
  "ip",
  "user_agent",
  "meta",
] as const;

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  // Spreadsheet formula injection: a cell that starts with = + - @ is prefixed.
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function auditCsv(events: AuditEvent[]): string {
  const lines = [AUDIT_CSV_COLUMNS.join(",")];
  for (const event of events) lines.push(AUDIT_CSV_COLUMNS.map((column) => csvCell(event[column])).join(","));
  return `${lines.join("\r\n")}\r\n`;
}

const FILTER_KEYS = ["category", "action", "actor", "workspace_id", "entity_type", "entity_id", "request_id", "from", "to"] as const;

/** The audit filter named by query parameters (the console page and the export share it). */
export function auditFilterFrom(params: URLSearchParams | Record<string, string | string[] | undefined>): AuditFilter {
  const get = (key: string) => {
    if (params instanceof URLSearchParams) return params.get(key);
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };
  const filter: AuditFilter = {};
  for (const key of FILTER_KEYS) {
    const value = get(key)?.trim();
    if (value) filter[key] = value;
  }
  return filter;
}
