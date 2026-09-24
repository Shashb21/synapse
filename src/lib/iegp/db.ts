import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import * as schema from "./schema";

const DEFAULT_URL =
  process.env.DATABASE_URL ??
  "postgres://synapse:synapse@127.0.0.1:5432/synapse";

const globalForDb = globalThis as unknown as {
  pg?: ReturnType<typeof postgres>;
  drizzle?: ReturnType<typeof drizzle<typeof schema>>;
};

function client() {
  if (!globalForDb.pg) {
    let host = "127.0.0.1";
    try {
      host = new URL(DEFAULT_URL.replace(/^postgres:\/\//, "http://")).hostname;
    } catch {
      // keep localhost default
    }
    const remote = host !== "127.0.0.1" && host !== "localhost";
    globalForDb.pg = postgres(DEFAULT_URL, {
      // Vitest sets VITEST=true — single connection avoids read-after-write races across pool clients.
      max: process.env.VERCEL || process.env.VITEST ? 1 : 8,
      ssl: remote ? "require" : undefined,
    });
  }
  return globalForDb.pg;
}

export function db() {
  if (!globalForDb.drizzle) {
    globalForDb.drizzle = drizzle(client(), { schema });
  }
  return globalForDb.drizzle;
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
  source_quote text NOT NULL, confidence real NOT NULL, status text NOT NULL,
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

export async function ensureSchema() {
  const d = db();
  await d.execute(sql`set client_min_messages to warning`);
  for (const stmt of DDL.split(";").map((s) => s.trim()).filter(Boolean)) {
    await d.execute(sql.raw(stmt));
  }
  await d.execute(
    sql.raw(
      "ALTER TABLE assets ADD COLUMN IF NOT EXISTS wizard_complete boolean NOT NULL DEFAULT false",
    ),
  );
  await d.execute(
    sql.raw(
      "ALTER TABLE tactics ADD COLUMN IF NOT EXISTS review_status text NOT NULL DEFAULT 'accepted'",
    ),
  );
  await d.execute(
    sql.raw(
      "ALTER TABLE mapping_suggestions ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'rejected'",
    ),
  );
  await d.execute(
    sql.raw(
      "ALTER TABLE mapping_suggestions ADD COLUMN IF NOT EXISTS lock jsonb NOT NULL DEFAULT '{}'::jsonb",
    ),
  );
  await d.execute(
    sql.raw("ALTER TABLE gaps ADD COLUMN IF NOT EXISTS parent_gap_id text"),
  );
  await d.execute(
    sql.raw("ALTER TABLE gaps ADD COLUMN IF NOT EXISTS computed_status text"),
  );
  await d.execute(
    sql.raw("ALTER TABLE gaps ADD COLUMN IF NOT EXISTS status_override jsonb"),
  );
  await d.execute(
    sql.raw(
      "ALTER TABLE residuals ADD COLUMN IF NOT EXISTS review_status text NOT NULL DEFAULT 'candidate'",
    ),
  );
  await d.execute(
    sql.raw("ALTER TABLE residuals ADD COLUMN IF NOT EXISTS created_gap_id text"),
  );
  await d.execute(
    sql.raw(
      "ALTER TABLE assets ADD COLUMN IF NOT EXISTS tactics_unlocked boolean NOT NULL DEFAULT false",
    ),
  );
  await d.execute(
    sql.raw("ALTER TABLE gaps ADD COLUMN IF NOT EXISTS retired boolean NOT NULL DEFAULT false"),
  );
  await d.execute(
    sql.raw(
      "ALTER TABLE gaps ADD COLUMN IF NOT EXISTS human_validated boolean NOT NULL DEFAULT false",
    ),
  );
  await d.execute(
    sql.raw(
      "ALTER TABLE coverages ADD COLUMN IF NOT EXISTS needs_review boolean NOT NULL DEFAULT false",
    ),
  );
  await d.execute(
    sql.raw(
      "ALTER TABLE assets ADD COLUMN IF NOT EXISTS setup_complete boolean NOT NULL DEFAULT false",
    ),
  );
  await d.execute(
    sql.raw(
      "ALTER TABLE assets ADD COLUMN IF NOT EXISTS planning_context jsonb NOT NULL DEFAULT '{}'::jsonb",
    ),
  );
  await d.execute(
    sql.raw("ALTER TABLE gaps ADD COLUMN IF NOT EXISTS parked_at text"),
  );
  await d.execute(
    sql.raw("ALTER TABLE gaps ADD COLUMN IF NOT EXISTS parked_reason text"),
  );
  await d.execute(
    sql.raw("ALTER TABLE gaps ADD COLUMN IF NOT EXISTS settings jsonb NOT NULL DEFAULT '[]'::jsonb"),
  );
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
