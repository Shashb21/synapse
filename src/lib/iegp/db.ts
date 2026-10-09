import { AsyncLocalStorage } from "node:async_hooks";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import * as schema from "./schema";
import { currentSchema, DEFAULT_SCHEMA } from "@/modules/workspaces/context";
import { workspaceTableStatements } from "./workspace-tables";
import { legacyPlanCarryOverStatements } from "./legacy-plan";

const DEFAULT_URL =
  process.env.DATABASE_URL ??
  "postgres://synapse:synapse@127.0.0.1:5432/synapse";

const globalForDb = globalThis as unknown as {
  pg?: ReturnType<typeof postgres>;
  platformPg?: ReturnType<typeof postgres>;
  drizzle?: ReturnType<typeof drizzle<typeof schema>>;
  sharedDrizzle?: ReturnType<typeof drizzle<typeof schema>>;
  schemaLookup?: (workspaceId: string) => Promise<string | null>;
  ambientTransaction?: AsyncLocalStorage<AmbientTransaction>;
  workspaceQueries?: number;
};

/** A workspace transaction the current async call chain runs inside (see `withWorkspaceTransaction`). */
type AmbientTransaction = { tx: postgres.TransactionSql; schema: string; done: boolean };

/** One store per process: Next bundles routes separately, like the workspace scope (context.ts). */
const ambient: AsyncLocalStorage<AmbientTransaction> = (globalForDb.ambientTransaction ??=
  new AsyncLocalStorage<AmbientTransaction>());

/**
 * Connections in a pool. `DATABASE_POOL_MAX` sets the workspace pool (default 10,
 * 3 on Vercel where many instances share the database, 1 under Vitest so reads
 * follow writes on one connection). Platform tables (sessions, workspaces,
 * routing, learning) use their own small pool, `DATABASE_PLATFORM_POOL_MAX`
 * (default 4, 2 on Vercel, 1 under Vitest), so a workspace transaction holding
 * its connection never waits on a platform read it makes itself (KAN-14/15).
 */
export function poolSize(kind: "workspace" | "platform", env: Record<string, string | undefined> = process.env): number {
  const raw = kind === "workspace" ? env.DATABASE_POOL_MAX : env.DATABASE_PLATFORM_POOL_MAX;
  const parsed = Number(raw);
  if (raw && Number.isInteger(parsed) && parsed >= 1 && parsed <= 100) return parsed;
  if (env.VITEST) return 1;
  if (env.VERCEL) return kind === "workspace" ? 3 : 2;
  return kind === "workspace" ? 10 : 4;
}

type SslOption =
  | false
  | "prefer"
  | "require"
  | { rejectUnauthorized: true; ca?: string; checkServerIdentity?: () => undefined };

/**
 * TLS for the database connection, from DATABASE_URL's `sslmode` (KAN-20):
 *
 * - `disable`, or a localhost URL with no sslmode: plain TCP (local dev, CI).
 * - `allow` / `prefer`: TLS when the server offers it, unverified (as libpq).
 * - `require`, `verify-full`, or a remote host with no sslmode: TLS, and the
 *   server certificate must chain to a trusted CA and match the host name.
 *   `verify-ca` checks the chain but not the name.
 *
 * A private CA (RDS, self-hosted) goes in DATABASE_CA_CERT as PEM text.
 * DATABASE_SSL_VERIFY=false keeps TLS but skips the certificate check; it is
 * a last resort, since it lets anyone on the path impersonate the database.
 */
export function sslFor(url: string, env: Record<string, string | undefined> = process.env): SslOption {
  let host = "127.0.0.1";
  let mode = "";
  try {
    const parsed = new URL(url.replace(/^postgres(ql)?:\/\//, "http://"));
    host = parsed.hostname;
    mode = (parsed.searchParams.get("sslmode") ?? "").toLowerCase();
  } catch {
    // keep localhost default
  }
  const local = host === "127.0.0.1" || host === "localhost" || host === "[::1]";
  if (mode === "disable") return false;
  if (mode === "allow" || mode === "prefer") return "prefer";
  if (!mode && local) return false;
  if (env.DATABASE_SSL_VERIFY === "false") return "require";
  const ca = env.DATABASE_CA_CERT?.trim() || undefined;
  return {
    rejectUnauthorized: true,
    ...(ca ? { ca } : {}),
    ...(mode === "verify-ca" ? { checkServerIdentity: () => undefined } : {}),
  };
}

function connectOptions(kind: "workspace" | "platform") {
  return {
    max: poolSize(kind),
    ssl: sslFor(DEFAULT_URL),
    // "already exists, skipping" notices from idempotent DDL are not news.
    connection: { client_min_messages: "warning" },
  };
}

/**
 * The workspace connection pool, however many workspaces there are. Workspace
 * queries borrow a connection and point it at their schema for that query.
 */
function client() {
  if (!globalForDb.pg) globalForDb.pg = postgres(DEFAULT_URL, connectOptions("workspace"));
  return globalForDb.pg;
}

/** The platform pool (public schema): shared tables only. */
function platformClient() {
  if (!globalForDb.platformPg) globalForDb.platformPg = postgres(DEFAULT_URL, connectOptions("platform"));
  return globalForDb.platformPg;
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
 * workspace's rows. The search path is sent in the same round trip as the
 * query (pipelined on the reserved connection) and both must succeed.
 */
async function onSchema<T>(name: string, fn: (pg: postgres.ReservedSql) => Promise<T>): Promise<T> {
  const reserved = await client().reserve();
  try {
    const setPath = reserved.unsafe(`set search_path to ${quoteSchema(name)}`);
    setPath.execute();
    const [, result] = await Promise.all([setPath, fn(reserved)]);
    return result;
  } finally {
    await reserved.unsafe("reset search_path").catch(() => undefined);
    reserved.release();
  }
}

type PendingLike = PromiseLike<unknown> & { values(): Promise<unknown> };

/** The ambient transaction, when it belongs to the schema this query resolves to. */
function transactionFor(name: string): AmbientTransaction | undefined {
  const current = ambient.getStore();
  // Work started inside a transaction but still running after it ended (a
  // fire-and-forget follow-up) runs on its own, not on the finished transaction.
  return current && !current.done && current.schema === name ? current : undefined;
}

/**
 * A postgres-js stand-in that Drizzle drives exactly like the real client: each
 * query runs in the current workspace's schema when it executes, inside the
 * ambient transaction when there is one.
 */
const router = {
  options: { parsers: {} as Record<string, unknown>, serializers: {} as Record<string, unknown> },
  unsafe(query: string, params?: unknown[]): PendingLike {
    const run = async (values: boolean) => {
      globalForDb.workspaceQueries = (globalForDb.workspaceQueries ?? 0) + 1;
      // Drizzle installed its type parsers on this stand-in; the real pool needs them too.
      Object.assign(client().options.parsers, router.options.parsers);
      Object.assign(client().options.serializers, router.options.serializers);
      const name = await resolveSchema();
      const open = transactionFor(name);
      if (open) {
        const pending = open.tx.unsafe(query, params as never);
        return values ? pending.values() : pending;
      }
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
    const open = transactionFor(name);
    // Nested: a savepoint, so the inner block can fail alone and the outer one still commits.
    if (open) return open.tx.savepoint((sp) => runAmbient({ tx: sp, schema: name, done: false }, () => fn(sp)));
    // Tables exist before the transaction opens: DDL rolled back with it would be
    // remembered as done, and the pool may have no second connection for it.
    if (name === DEFAULT_SCHEMA) await ensureCurrentSchemaTables();
    return client().begin(async (tx) => {
      // SET LOCAL ends with the transaction, so the connection comes back clean.
      if (name !== DEFAULT_SCHEMA) await tx.unsafe(`set local search_path to ${quoteSchema(name)}`);
      return runAmbient({ tx, schema: name, done: false }, () => fn(tx));
    });
  },
};

async function runAmbient<T>(store: AmbientTransaction, fn: () => T): Promise<Awaited<T>> {
  try {
    return await ambient.run(store, fn);
  } finally {
    store.done = true;
  }
}

/** Workspace queries run through `db()` in this process (KAN-14 measurement and tests). */
export function workspaceQueryCount(): number {
  return globalForDb.workspaceQueries ?? 0;
}

/**
 * Runs `fn` in one database transaction on the current workspace's schema
 * (KAN-15): every `db()` query inside it, however deep, joins it, so a failure
 * part-way leaves nothing half-written. Nested calls become savepoints.
 * Platform tables (`sharedDb()`) are not part of it.
 */
export async function withWorkspaceTransaction<T>(fn: () => Promise<T>): Promise<T> {
  return (await router.begin(() => fn())) as T;
}

/** True inside `withWorkspaceTransaction` (or a Drizzle `db().transaction`). */
export function inWorkspaceTransaction(): boolean {
  const current = ambient.getStore();
  return Boolean(current && !current.done);
}

/** Workspace-scoped: every IEGP and stage table. */
export function db() {
  if (!globalForDb.drizzle) {
    globalForDb.drizzle = drizzle(router as unknown as ReturnType<typeof postgres>, { schema });
  }
  return globalForDb.drizzle;
}

/** Platform-wide tables: users, workspaces, sessions, routing, settings, accuracy. */
export function sharedDb() {
  if (!globalForDb.sharedDrizzle) globalForDb.sharedDrizzle = drizzle(platformClient(), { schema });
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
CREATE TABLE IF NOT EXISTS tactic_expansions (
  id text PRIMARY KEY, tactic_id text NOT NULL, proposal_id text NOT NULL UNIQUE,
  gap_ids jsonb NOT NULL, scope jsonb NOT NULL, status text NOT NULL,
  version text NOT NULL, history jsonb NOT NULL,
  created_at text NOT NULL, updated_at text NOT NULL, actor jsonb NOT NULL
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
CREATE TABLE IF NOT EXISTS gap_suggestions (
  id text PRIMARY KEY, gap_id text NOT NULL, run_id text NOT NULL, candidate_row_id text,
  source_id text NOT NULL, name text NOT NULL, statement text NOT NULL, domain text NOT NULL,
  source_quote text NOT NULL, shared_part text NOT NULL, new_part text NOT NULL,
  merged_name text NOT NULL, merged_statement text NOT NULL,
  split_name text NOT NULL, split_statement text NOT NULL,
  extra_sources jsonb NOT NULL DEFAULT '[]'::jsonb, status text NOT NULL,
  result_gap_id text, decided_by text, rationale text,
  created_at text NOT NULL, decided_at text
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
    "ALTER TABLE coverages ADD COLUMN IF NOT EXISTS expansion_id text",
    "CREATE UNIQUE INDEX IF NOT EXISTS coverage_expansion_scope_unique ON coverages (gap_id, tactic_id, expansion_id) WHERE expansion_id IS NOT NULL",
    "ALTER TABLE coverages ADD COLUMN IF NOT EXISTS needs_review boolean NOT NULL DEFAULT false",
    "ALTER TABLE assets ADD COLUMN IF NOT EXISTS setup_complete boolean NOT NULL DEFAULT false",
    "ALTER TABLE assets ADD COLUMN IF NOT EXISTS planning_context jsonb NOT NULL DEFAULT '{}'::jsonb",
    "ALTER TABLE gaps ADD COLUMN IF NOT EXISTS parked_at text",
    "ALTER TABLE gaps ADD COLUMN IF NOT EXISTS parked_reason text",
    "ALTER TABLE gaps ADD COLUMN IF NOT EXISTS settings jsonb NOT NULL DEFAULT '[]'::jsonb",
    "ALTER TABLE gaps ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb",
    "ALTER TABLE tactics ADD COLUMN IF NOT EXISTS custom_type jsonb",
    "ALTER TABLE gaps ADD COLUMN IF NOT EXISTS number integer",
    "ALTER TABLE tactics ADD COLUMN IF NOT EXISTS source_quote text NOT NULL DEFAULT ''",
    "ALTER TABLE needs ALTER COLUMN confidence DROP NOT NULL",
    // KAN-74/75: a new source on a validated gap, and gaps split from a shared question.
    "ALTER TABLE gaps ADD COLUMN IF NOT EXISTS new_source_at text",
    "ALTER TABLE gaps ADD COLUMN IF NOT EXISTS new_source_need_id text",
    "ALTER TABLE gaps ADD COLUMN IF NOT EXISTS related_gap_ids jsonb NOT NULL DEFAULT '[]'::jsonb",
    // KAN-15: per-prefix id counters that only move up, so ids are never reissued.
    "CREATE TABLE IF NOT EXISTS id_counters (key text PRIMARY KEY, last bigint NOT NULL)",
    // Kernel, source-block, room, walkthrough and stage-module tables.
    ...workspaceTableStatements(),
  ];
}

/**
 * Brings the current schema's tables up to date: once per schema per process
 * (KAN-14), not on every load. `forgetSchemaBootstrap` makes the next call
 * re-run it, e.g. after a schema was dropped.
 */
export async function ensureSchema() {
  await ensureCurrentSchemaTables();
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

/** Forgets that `name` (or every schema) was bootstrapped, so its DDL runs again on next use. */
export function forgetSchemaBootstrap(name?: string) {
  if (name) bootstrapped.delete(name);
  else bootstrapped.clear();
}

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
  // The retired priority board and roadmap carry over into S8 and mappings (KAN-17).
  for (const stmt of legacyPlanCarryOverStatements()) await run(stmt);
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

/**
 * Empties the workspace's plan tables before new contents are written. Never
 * `audit` or `gap_versions` (KAN-89): the workspace's history outlives a reset
 * to blank or a demo load, which is itself recorded in both audit logs.
 */
export async function wipeIegp() {
  const d = db();
  const tables = [
    "tactic_suggestions",
    "tactic_source_references",
    "gap_suggestions",
    "gold_coverages",
    "gold_needs",
    "roadmap",
    "priorities",
    "residuals",
    "coverages",
    "tactic_expansions",
    "mapping_suggestions",
    "residual_gap_suggestions",
    "need_gap_links",
    "needs",
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
