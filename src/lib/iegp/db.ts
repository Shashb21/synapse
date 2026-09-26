import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import * as schema from "./schema";
import { currentSchema, DEFAULT_SCHEMA } from "@/modules/workspaces/context";
import { workspaceTableStatements } from "./workspace-tables";

const DEFAULT_URL =
  process.env.DATABASE_URL ??
  "postgres://synapse:synapse@127.0.0.1:5432/synapse";

const globalForDb = globalThis as unknown as {
  pg?: ReturnType<typeof postgres>;
  drizzle?: ReturnType<typeof drizzle<typeof schema>>;
  sharedDrizzle?: ReturnType<typeof drizzle<typeof schema>>;
  schemaLookup?: (workspaceId: string) => Promise<string | null>;
};

function connectOptions() {
  let host = "127.0.0.1";
  try {
    host = new URL(DEFAULT_URL.replace(/^postgres:\/\//, "http://")).hostname;
  } catch {
    // keep localhost default
  }
  const remote = host !== "127.0.0.1" && host !== "localhost";
  return {
    // Vitest sets VITEST=true — single connection avoids read-after-write races across pool clients.
    max: process.env.VERCEL || process.env.VITEST ? 1 : 8,
    ssl: remote ? ("require" as const) : undefined,
  };
}

/**
 * The one connection pool, however many workspaces there are. Workspace
 * queries borrow a connection and point it at their schema for that query.
 */
function client() {
  if (!globalForDb.pg) globalForDb.pg = postgres(DEFAULT_URL, connectOptions());
  return globalForDb.pg;
}

/** Registered by the workspaces module: workspace id → schema name. */
export function setWorkspaceSchemaLookup(lookup: (workspaceId: string) => Promise<string | null>) {
  globalForDb.schemaLookup = lookup;
}

async function resolveSchema(): Promise<string> {
  const name = await currentSchema(async (id) => {
    // The workspaces module registers the lookup when it loads; load it on first need.
    if (!globalForDb.schemaLookup) await import("@/modules/workspaces/store");
    return globalForDb.schemaLookup ? globalForDb.schemaLookup(id) : null;
  });
  if (name !== DEFAULT_SCHEMA) await ensureWorkspaceSchema(name);
  return name;
}

/**
 * The schema the current request's queries run in (`public` for Default).
 * Key per-workspace caches by this, never by a process-wide flag.
 */
export async function currentSchemaName(): Promise<string> {
  return resolveSchema();
}

function quoteSchema(name: string): string {
  if (!/^ws_[a-z0-9_]+$/.test(name)) throw new Error(`Not a workspace schema: ${name}`);
  return `"${name}"`;
}

/**
 * Runs `fn` on a connection whose search path is only `name`, then resets the
 * connection before it goes back to the pool. A workspace query therefore sees
 * only its own schema: a table it lacks is an error, never another
 * workspace's rows.
 */
async function onSchema<T>(name: string, fn: (pg: postgres.ReservedSql) => Promise<T>): Promise<T> {
  const reserved = await client().reserve();
  try {
    await reserved.unsafe(`set search_path to ${quoteSchema(name)}`);
    return await fn(reserved);
  } finally {
    await reserved.unsafe("reset search_path").catch(() => undefined);
    reserved.release();
  }
}

type PendingLike = PromiseLike<unknown> & { values(): Promise<unknown> };

/**
 * A postgres-js stand-in that Drizzle drives exactly like the real client: each
 * query runs in the current workspace's schema when it executes.
 */
const router = {
  options: { parsers: {} as Record<string, unknown>, serializers: {} as Record<string, unknown> },
  unsafe(query: string, params?: unknown[]): PendingLike {
    const run = async (values: boolean) => {
      // Drizzle installed its type parsers on this stand-in; the real pool needs them too.
      Object.assign(client().options.parsers, router.options.parsers);
      Object.assign(client().options.serializers, router.options.serializers);
      const name = await resolveSchema();
      if (name === DEFAULT_SCHEMA) {
        const pending = client().unsafe(query, params as never);
        return values ? pending.values() : pending;
      }
      return onSchema(name, async (pg) => {
        const pending = pg.unsafe(query, params as never);
        return values ? pending.values() : pending;
      });
    };
    return {
      then: (onFulfilled, onRejected) => run(false).then(onFulfilled, onRejected),
      values: () => run(true),
    };
  },
  async begin(fn: (tx: postgres.TransactionSql) => unknown) {
    const name = await resolveSchema();
    return client().begin(async (tx) => {
      // SET LOCAL ends with the transaction, so the connection comes back clean.
      if (name !== DEFAULT_SCHEMA) await tx.unsafe(`set local search_path to ${quoteSchema(name)}`);
      return fn(tx);
    });
  },
};

/** Workspace-scoped: every IEGP and stage table. */
export function db() {
  if (!globalForDb.drizzle) {
    globalForDb.drizzle = drizzle(router as unknown as ReturnType<typeof postgres>, { schema });
  }
  return globalForDb.drizzle;
}

/** Platform-wide tables: users, workspaces, sessions, routing, provider logins, settings, accuracy. */
export function sharedDb() {
  if (!globalForDb.sharedDrizzle) globalForDb.sharedDrizzle = drizzle(client(), { schema });
  return globalForDb.sharedDrizzle;
}

const DDL = `
CREATE TABLE IF NOT EXISTS assets (
  id text PRIMARY KEY, name text NOT NULL, inn text NOT NULL,
  indication text NOT NULL, geography text NOT NULL,
  wizard_complete boolean NOT NULL DEFAULT false,
  tactics_unlocked boolean NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS objectives (
  id text PRIMARY KEY, name text NOT NULL, description text NOT NULL,
  lifecycle_stage text NOT NULL, indication text NOT NULL, geography text NOT NULL,
  strategic_importance integer NOT NULL, key_decision text NOT NULL,
  decision_date text NOT NULL, owner text NOT NULL
);
CREATE TABLE IF NOT EXISTS sources (
  id text PRIMARY KEY, filename text NOT NULL, title text NOT NULL,
  source_type text NOT NULL, stakeholder_function text NOT NULL,
  ingested_at text NOT NULL, full_text text NOT NULL
);
CREATE TABLE IF NOT EXISTS source_blocks (
  id text PRIMARY KEY, source_id text NOT NULL, heading text NOT NULL,
  text text NOT NULL, location text NOT NULL
);
CREATE TABLE IF NOT EXISTS needs (
  id text PRIMARY KEY, statement text NOT NULL, domain text NOT NULL,
  stakeholder text NOT NULL, objective_id text NOT NULL,
  decision_supported text NOT NULL, geography text NOT NULL,
  population text NOT NULL, intervention text NOT NULL, comparator text NOT NULL,
  outcome text NOT NULL, timing text NOT NULL, source_id text NOT NULL,
  source_quote text NOT NULL, confidence real, status text NOT NULL,
  lock jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS gaps (
  id text PRIMARY KEY, name text NOT NULL, statement text NOT NULL,
  domain text NOT NULL, objective_id text NOT NULL, status text NOT NULL,
  exclusion_reason text, exclusion_note text, lock jsonb NOT NULL,
  parent_gap_id text, computed_status text, status_override jsonb,
  retired boolean NOT NULL DEFAULT false,
  human_validated boolean NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS gap_versions (
  id text PRIMARY KEY, live_gap_id text NOT NULL, retired_gap_id text NOT NULL,
  name text NOT NULL, statement text NOT NULL, status text NOT NULL,
  domain text NOT NULL, event text NOT NULL, at text NOT NULL,
  actor_name text NOT NULL, actor_function text NOT NULL
);
CREATE TABLE IF NOT EXISTS need_gap_links (
  need_id text NOT NULL, gap_id text NOT NULL, role text NOT NULL,
  PRIMARY KEY (need_id, gap_id)
);
CREATE TABLE IF NOT EXISTS tactics (
  id text PRIMARY KEY, name text NOT NULL, type text NOT NULL,
  description text NOT NULL, evidence_question text NOT NULL,
  population text NOT NULL, intervention text NOT NULL, comparator text NOT NULL,
  outcomes text NOT NULL, geography text NOT NULL, data_source text NOT NULL,
  study_design text NOT NULL, lifecycle_stage text NOT NULL, status text NOT NULL,
  review_status text NOT NULL DEFAULT 'accepted',
  start_date text, evidence_available text, owner text NOT NULL,
  function text NOT NULL, budget text, intended_use text NOT NULL, lock jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS coverages (
  id text PRIMARY KEY, gap_id text NOT NULL, tactic_id text NOT NULL,
  dimensions jsonb NOT NULL, overall text NOT NULL, overall_rationale text NOT NULL,
  overall_lock jsonb NOT NULL, stale boolean NOT NULL DEFAULT false,
  needs_review boolean NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS mapping_suggestions (
  gap_id text NOT NULL, tactic_id text NOT NULL,
  status text NOT NULL, lock jsonb NOT NULL,
  PRIMARY KEY (gap_id, tactic_id)
);
CREATE TABLE IF NOT EXISTS residual_gap_suggestions (
  parent_gap_id text PRIMARY KEY, statement text NOT NULL,
  reasons jsonb NOT NULL, status text NOT NULL, lock jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS residuals (
  id text PRIMARY KEY, gap_id text NOT NULL, statement text NOT NULL,
  domain text NOT NULL, draft_rationale text NOT NULL,
  review_status text NOT NULL DEFAULT 'candidate', created_gap_id text,
  lock jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS priorities (
  id text PRIMARY KEY, residual_id text NOT NULL, suggested_score integer NOT NULL,
  suggested_band text NOT NULL, band text NOT NULL, override_reason text,
  reasons jsonb NOT NULL, lock jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS roadmap (
  id text PRIMARY KEY, tactic_id text NOT NULL, residual_ids jsonb NOT NULL,
  start_date text, evidence_available text, owner text NOT NULL,
  note text, lock jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
  id text PRIMARY KEY, at text NOT NULL, actor_name text NOT NULL,
  actor_function text NOT NULL, entity_type text NOT NULL, entity_id text NOT NULL,
  action text NOT NULL, detail text NOT NULL
);
CREATE TABLE IF NOT EXISTS gold_needs (
  id text PRIMARY KEY, statement text NOT NULL, source_id text NOT NULL,
  must_find boolean NOT NULL
);
CREATE TABLE IF NOT EXISTS gold_coverages (
  id text PRIMARY KEY, gap_id text NOT NULL, tactic_id text NOT NULL,
  overall text NOT NULL
);
CREATE TABLE IF NOT EXISTS breakout_groups (
  id text PRIMARY KEY, name text NOT NULL, note text,
  created_at text NOT NULL, actor_name text NOT NULL, actor_function text NOT NULL
);
CREATE TABLE IF NOT EXISTS breakout_group_gaps (
  group_id text NOT NULL, gap_id text NOT NULL,
  PRIMARY KEY (group_id, gap_id)
);
`;

/** Every statement that brings a schema's IEGP tables up to date. */
function iegpStatements(): string[] {
  return [
    ...DDL.split(";").map((s) => s.trim()).filter(Boolean),
    "ALTER TABLE assets ADD COLUMN IF NOT EXISTS wizard_complete boolean NOT NULL DEFAULT false",
    "ALTER TABLE tactics ADD COLUMN IF NOT EXISTS review_status text NOT NULL DEFAULT 'accepted'",
    "ALTER TABLE mapping_suggestions ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'rejected'",
    "ALTER TABLE mapping_suggestions ADD COLUMN IF NOT EXISTS lock jsonb NOT NULL DEFAULT '{}'::jsonb",
    "ALTER TABLE gaps ADD COLUMN IF NOT EXISTS parent_gap_id text",
    "ALTER TABLE gaps ADD COLUMN IF NOT EXISTS computed_status text",
    "ALTER TABLE gaps ADD COLUMN IF NOT EXISTS status_override jsonb",
    "ALTER TABLE residuals ADD COLUMN IF NOT EXISTS review_status text NOT NULL DEFAULT 'candidate'",
    "ALTER TABLE residuals ADD COLUMN IF NOT EXISTS created_gap_id text",
    "ALTER TABLE assets ADD COLUMN IF NOT EXISTS tactics_unlocked boolean NOT NULL DEFAULT false",
    "ALTER TABLE gaps ADD COLUMN IF NOT EXISTS retired boolean NOT NULL DEFAULT false",
    "ALTER TABLE gaps ADD COLUMN IF NOT EXISTS human_validated boolean NOT NULL DEFAULT false",
    "ALTER TABLE coverages ADD COLUMN IF NOT EXISTS needs_review boolean NOT NULL DEFAULT false",
    "ALTER TABLE assets ADD COLUMN IF NOT EXISTS setup_complete boolean NOT NULL DEFAULT false",
    "ALTER TABLE assets ADD COLUMN IF NOT EXISTS planning_context jsonb NOT NULL DEFAULT '{}'::jsonb",
    "ALTER TABLE gaps ADD COLUMN IF NOT EXISTS parked_at text",
    "ALTER TABLE gaps ADD COLUMN IF NOT EXISTS parked_reason text",
    "ALTER TABLE gaps ADD COLUMN IF NOT EXISTS settings jsonb NOT NULL DEFAULT '[]'::jsonb",
    "ALTER TABLE tactics ADD COLUMN IF NOT EXISTS source_quote text NOT NULL DEFAULT ''",
    "ALTER TABLE needs ALTER COLUMN confidence DROP NOT NULL",
    // Kernel, source-block, room, walkthrough and stage-module tables.
    ...workspaceTableStatements(),
  ];
}

export async function ensureSchema() {
  const d = db();
  await d.execute(sql`set client_min_messages to warning`);
  for (const stmt of iegpStatements()) {
    await d.execute(sql.raw(stmt));
  }
}

type RunStatement = (statement: string) => Promise<unknown>;
type BootstrapHook = (run: RunStatement) => Promise<void>;
const bootstrapHooks: BootstrapHook[] = [];

/**
 * Extra DDL a schema needs beyond `iegpStatements()` (the registry adds the
 * migrations of every registered module). Hooks run once per schema per
 * process. Tables every workspace needs belong in `workspace-tables.ts`
 * instead, which does not depend on import order. Returns an unregister
 * function (test seam).
 */
export function onWorkspaceBootstrap(hook: BootstrapHook): () => void {
  bootstrapHooks.push(hook);
  return () => {
    const at = bootstrapHooks.indexOf(hook);
    if (at >= 0) bootstrapHooks.splice(at, 1);
  };
}

const bootstrapped = new Map<string, Promise<void>>();

/**
 * Loads every stage module before a schema is bootstrapped, so the registry
 * hook sees all of them, not just the ones some route happened to import.
 */
async function loadModules() {
  await import("@/modules");
}

async function bootstrap(run: RunStatement) {
  await run("set client_min_messages to warning");
  for (const stmt of iegpStatements()) await run(stmt);
  for (const hook of [...bootstrapHooks]) await hook(run);
}

/**
 * Runs `build` once per schema per process. A failure is forgotten, so the
 * next call retries instead of one DB blip breaking the process for good.
 */
function once(name: string, build: () => Promise<void>): Promise<void> {
  let ready = bootstrapped.get(name);
  if (!ready) {
    const attempt = build();
    ready = attempt;
    bootstrapped.set(name, attempt);
    attempt.catch(() => {
      if (bootstrapped.get(name) === attempt) bootstrapped.delete(name);
    });
  }
  return ready;
}

/** Creates a workspace schema and every table in it, once per process. */
export async function ensureWorkspaceSchema(name: string): Promise<void> {
  if (!/^ws_[a-z0-9_]+$/.test(name)) throw new Error(`Not a workspace schema: ${name}`);
  await once(name, async () => {
    await loadModules();
    await client().unsafe(`CREATE SCHEMA IF NOT EXISTS "${name}"`);
    await onSchema(name, (pg) => bootstrap((statement) => pg.unsafe(statement)));
  });
}

/**
 * Every workspace table exists in the current schema, Default included; once
 * per schema per process. Code that uses its tables lazily calls this first.
 */
export async function ensureCurrentSchemaTables(): Promise<void> {
  const name = await currentSchemaName();
  if (name !== DEFAULT_SCHEMA) return ensureWorkspaceSchema(name);
  await once(DEFAULT_SCHEMA, async () => {
    await loadModules();
    await bootstrap((statement) => client().unsafe(statement));
  });
}

export async function wipeIegp() {
  const d = db();
  const tables = [
    "gold_coverages",
    "gold_needs",
    "audit",
    "roadmap",
    "priorities",
    "residuals",
    "coverages",
    "mapping_suggestions",
    "residual_gap_suggestions",
    "need_gap_links",
    "needs",
    "gap_versions",
    "breakout_group_gaps",
    "breakout_groups",
    "gaps",
    "tactics",
    "source_blocks",
    "sources",
    "objectives",
    "assets",
  ];
  for (const t of tables) {
    await d.execute(sql.raw(`DELETE FROM ${t}`));
  }
}
