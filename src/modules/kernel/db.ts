import { sql } from "drizzle-orm";
import { db } from "@/lib/iegp/db";

export { db };

const PLATFORM_DDL = `
CREATE TABLE IF NOT EXISTS module_runs (
  id text PRIMARY KEY, workspace_id text NOT NULL, stage text NOT NULL,
  module_id text NOT NULL, module_version text NOT NULL, status text NOT NULL,
  started_at text NOT NULL, finished_at text, duration_ms integer,
  actor_name text NOT NULL, actor_function text NOT NULL,
  summary text, error text,
  input jsonb NOT NULL, output jsonb, steps jsonb NOT NULL,
  route jsonb, evals jsonb
);
CREATE TABLE IF NOT EXISTS edit_records (
  id text PRIMARY KEY, at text NOT NULL, workspace_id text NOT NULL,
  stage text NOT NULL, entity_type text NOT NULL, entity_id text NOT NULL,
  field text NOT NULL, action text NOT NULL, before text, after text,
  rationale text NOT NULL, actor_name text NOT NULL, actor_function text NOT NULL
);
CREATE TABLE IF NOT EXISTS hillclimb_signals (
  id text PRIMARY KEY, at text NOT NULL, stage text NOT NULL, kind text NOT NULL,
  subject text NOT NULL, rationale text NOT NULL,
  weight integer NOT NULL DEFAULT 1, status text NOT NULL DEFAULT 'open',
  payload jsonb
);
CREATE TABLE IF NOT EXISTS eval_runs (
  id text PRIMARY KEY, at text NOT NULL, stage text NOT NULL,
  module_id text NOT NULL, module_version text NOT NULL, run_id text,
  passed boolean NOT NULL DEFAULT true, metrics jsonb NOT NULL, note text
);
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
CREATE TABLE IF NOT EXISTS priority_axes (
  id text PRIMARY KEY, config jsonb NOT NULL,
  updated_by text NOT NULL, updated_at text NOT NULL
);
CREATE TABLE IF NOT EXISTS priority_placements (
  gap_id text PRIMARY KEY, axis_scores jsonb NOT NULL,
  suggested_band text NOT NULL, suggested_rationale text NOT NULL,
  band text, validated boolean NOT NULL DEFAULT false, rationale text,
  actor_name text, actor_function text, at text NOT NULL
);
CREATE TABLE IF NOT EXISTS ideation_proposals (
  id text PRIMARY KEY, gap_id text NOT NULL, name text NOT NULL, type text NOT NULL,
  rationale text NOT NULL, evidence_question text NOT NULL, design jsonb NOT NULL,
  status text NOT NULL DEFAULT 'proposed', critic_note text,
  judge_score integer NOT NULL DEFAULT 0, created_at text NOT NULL,
  decided_by text, decided_at text, decision_rationale text, tactic_id text
);
CREATE TABLE IF NOT EXISTS timeline_activities (
  id text PRIMARY KEY, tactic_id text NOT NULL, gap_ids jsonb NOT NULL,
  lane text NOT NULL, start_date text NOT NULL, end_date text NOT NULL,
  readout_date text, depends_on jsonb NOT NULL, band text, meta jsonb NOT NULL,
  updated_by text, updated_at text NOT NULL
);
CREATE TABLE IF NOT EXISTS iegp_plans (
  id text PRIMARY KEY, version integer NOT NULL, status text NOT NULL,
  snapshot jsonb NOT NULL, note text, saved_by text NOT NULL,
  saved_function text NOT NULL, saved_at text NOT NULL
);
`;

const globalForPlatform = globalThis as unknown as {
  synapsePlatformSchema?: Promise<void>;
};

async function applyDdl(statements: string[]) {
  const d = db();
  for (const stmt of statements.map((s) => s.trim()).filter(Boolean)) {
    await d.execute(sql.raw(stmt));
  }
}

/**
 * Applies platform DDL once per process. Module-owned DDL is passed in by the
 * registry so a module can add its own tables without editing the kernel.
 */
export async function ensurePlatformSchema(moduleMigrations: string[] = []) {
  if (!globalForPlatform.synapsePlatformSchema) {
    globalForPlatform.synapsePlatformSchema = (async () => {
      const d = db();
      await d.execute(sql`set client_min_messages to warning`);
      await applyDdl(PLATFORM_DDL.split(";"));
    })();
  }
  await globalForPlatform.synapsePlatformSchema;
  if (moduleMigrations.length > 0) {
    await applyDdl(moduleMigrations);
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
