import { sql } from "drizzle-orm";
import { db, ensureCurrentSchemaTables, sharedDb } from "@/lib/iegp/db";
import { KERNEL_WORKSPACE_DDL } from "@/lib/iegp/workspace-tables";

export { db, sharedDb };

/** Platform-wide tables: one copy, in the public schema. */
const SHARED_DDL = `
CREATE TABLE IF NOT EXISTS eval_runs (
  id text PRIMARY KEY, at text NOT NULL, stage text NOT NULL,
  module_id text NOT NULL, module_version text NOT NULL, run_id text,
  passed boolean NOT NULL DEFAULT true, metrics jsonb NOT NULL, note text
);
CREATE TABLE IF NOT EXISTS prompt_baselines (
  id text PRIMARY KEY, stage text NOT NULL, prompt_version text NOT NULL,
  module_id text NOT NULL, module_version text NOT NULL,
  metrics jsonb NOT NULL, composite numeric NOT NULL,
  recorded_at text NOT NULL, note text
);
CREATE UNIQUE INDEX IF NOT EXISTS prompt_baselines_stage_version
  ON prompt_baselines(stage, prompt_version);
CREATE TABLE IF NOT EXISTS routing_config (
  stage text PRIMARY KEY, provider_id text NOT NULL, model text NOT NULL,
  params jsonb NOT NULL, fallbacks jsonb NOT NULL,
  updated_by text NOT NULL, updated_at text NOT NULL
);
CREATE TABLE IF NOT EXISTS stage_modules (
  stage text PRIMARY KEY, module_id text NOT NULL,
  activated_by text NOT NULL, activated_at text NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_connections (
  provider_id text PRIMARY KEY, status text NOT NULL, account_label text,
  scopes jsonb NOT NULL, access_token text, refresh_token text, expires_at text,
  connected_by text, connected_at text, detail text
);
CREATE TABLE IF NOT EXISTS auth_sessions (
  id text PRIMARY KEY, provider_id text NOT NULL, subject text NOT NULL, email text,
  actor_name text NOT NULL, actor_function text NOT NULL, role text NOT NULL,
  created_at text NOT NULL, expires_at text NOT NULL
);
`;

/** Tables every workspace schema has its own copy of (created at bootstrap, see workspace-tables.ts). */
const WORKSPACE_DDL = KERNEL_WORKSPACE_DDL;

const globalForPlatform = globalThis as unknown as {
  synapsePlatformSchema?: Promise<void>;
};

async function applyDdl(statements: string[], target: typeof db = db) {
  const d = target();
  for (const stmt of statements.map((s) => s.trim()).filter(Boolean)) {
    await d.execute(sql.raw(stmt));
  }
}

/**
 * Applies platform DDL once per process: shared tables in the public schema,
 * workspace tables in the Default workspace (other workspaces get theirs when
 * their schema is created). Module-owned DDL is passed in by the registry and
 * applies to the current workspace.
 */
export async function ensurePlatformSchema(moduleMigrations: string[] = []) {
  if (!globalForPlatform.synapsePlatformSchema) {
    globalForPlatform.synapsePlatformSchema = (async () => {
      await sharedDb().execute(sql`set client_min_messages to warning`);
      await applyDdl(SHARED_DDL.split(";"), sharedDb);
      await applyDdl(WORKSPACE_DDL.split(";"), sharedDb);
    })();
    // A failed attempt is forgotten, so the next call retries.
    const attempt = globalForPlatform.synapsePlatformSchema;
    attempt.catch(() => {
      if (globalForPlatform.synapsePlatformSchema === attempt) globalForPlatform.synapsePlatformSchema = undefined;
    });
  }
  await globalForPlatform.synapsePlatformSchema;
  if (moduleMigrations.length > 0) {
    await applyDdl(moduleMigrations);
  }
}

/**
 * Workspace-scoped module tables. Resetting the workspace must clear these too,
 * or a stage would read artifacts pointing at domain records that no longer
 * exist. Routing, provider logins, module activation, run history and hillclimb
 * signals are configuration or learning, so they survive a reset.
 */
const WORKSPACE_TABLES = [
  "source_files",
  "parsed_documents",
  "gap_candidates",
  "tactic_candidates",
  "mapping_candidates",
  "priority_placements",
  "ideation_proposals",
  "timeline_activities",
  "iegp_plans",
];

export async function resetWorkspaceModules() {
  await ensurePlatformSchema();
  // Every table below comes with the schema, so a failed delete is a real error.
  await ensureCurrentSchemaTables();
  const d = db();
  for (const table of WORKSPACE_TABLES) {
    await d.execute(sql.raw(`DELETE FROM ${table} WHERE true`));
  }
}

/** Test helper: drops all rows from platform and module-owned tables. */
export async function wipePlatform(moduleTables: string[] = []) {
  await ensurePlatformSchema();
  const d = db();
  const tables = [
    "module_runs",
    "edit_records",
    "hillclimb_signals",
    "eval_runs",
    "routing_config",
    "stage_modules",
    "oauth_connections",
    "auth_sessions",
    "priority_axes",
    "priority_placements",
    "ideation_proposals",
    "timeline_activities",
    "iegp_plans",
    ...moduleTables,
  ];
  for (const table of tables) {
    await d.execute(sql.raw(`DELETE FROM ${table} WHERE true`)).catch(() => undefined);
  }
}
