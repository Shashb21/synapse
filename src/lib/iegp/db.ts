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
    globalForDb.pg = postgres(DEFAULT_URL, { max: 8 });
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
  indication text NOT NULL, geography text NOT NULL
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
  exclusion_reason text, exclusion_note text, lock jsonb NOT NULL
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
  start_date text, evidence_available text, owner text NOT NULL,
  function text NOT NULL, budget text, intended_use text NOT NULL, lock jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS coverages (
  id text PRIMARY KEY, gap_id text NOT NULL, tactic_id text NOT NULL,
  dimensions jsonb NOT NULL, overall text NOT NULL, overall_rationale text NOT NULL,
  overall_lock jsonb NOT NULL, stale boolean NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS residuals (
  id text PRIMARY KEY, gap_id text NOT NULL, statement text NOT NULL,
  domain text NOT NULL, draft_rationale text NOT NULL, lock jsonb NOT NULL
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
`;

export async function ensureSchema() {
  const d = db();
  await d.execute(sql`set client_min_messages to warning`);
  for (const stmt of DDL.split(";").map((s) => s.trim()).filter(Boolean)) {
    await d.execute(sql.raw(stmt));
  }
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
    "need_gap_links",
    "needs",
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
