import { integer, jsonb, pgTable, text } from "drizzle-orm/pg-core";

/** Module-owned table: tactic proposals with critic score and judge verdict. */
export const tacticCandidates = pgTable("tactic_candidates", {
  id: text("id").primaryKey(),
  run_id: text("run_id").notNull(),
  document_id: text("document_id").notNull(),
  source_id: text("source_id").notNull(),
  name: text("name").notNull(),
  type: text("type").notNull(),
  status: text("status").notNull(),
  evidence_question: text("evidence_question").notNull(),
  source_quote: text("source_quote").notNull(),
  score: integer("score").notNull(),
  verdict: text("verdict").notNull(),
  critic_note: text("critic_note").notNull(),
  /** Library tactic id the model judge matched this candidate to; null when new. */
  duplicate_of: text("duplicate_of"),
  match: text("match").notNull().default("new"),
  target_tactic_id: text("target_tactic_id"),
  matching: jsonb("matching"),
  proposer: text("proposer").notNull(),
  created_at: text("created_at").notNull(),
});

export const TACTIC_CANDIDATES_DDL = `
CREATE TABLE IF NOT EXISTS tactic_candidates (
  id text PRIMARY KEY, run_id text NOT NULL, document_id text NOT NULL,
  source_id text NOT NULL, name text NOT NULL, type text NOT NULL, status text NOT NULL,
  evidence_question text NOT NULL, source_quote text NOT NULL, score integer NOT NULL,
  verdict text NOT NULL, critic_note text NOT NULL, proposer text NOT NULL,
  created_at text NOT NULL
)
`;

export const TACTIC_CANDIDATES_DUPLICATE_DDL = `
ALTER TABLE tactic_candidates ADD COLUMN IF NOT EXISTS duplicate_of text
`;

/** Source matching and human review remain scoped to the current workspace. */
export const tacticSourceReferences = pgTable("tactic_source_references", {
  id: text("id").primaryKey(), tactic_id: text("tactic_id").notNull(),
  source_id: text("source_id").notNull(), source_quote: text("source_quote").notNull(),
  quote_key: text("quote_key").notNull(), created_at: text("created_at").notNull(),
});
export const tacticSuggestions = pgTable("tactic_suggestions", {
  id: text("id").primaryKey(), source_key: text("source_key").notNull().unique(),
  target_tactic_id: text("target_tactic_id").notNull(), source_id: text("source_id").notNull(),
  status: text("status").notNull(), payload: jsonb("payload").notNull(),
  created_at: text("created_at").notNull(), updated_at: text("updated_at").notNull(),
});
export const TACTIC_MATCHING_DDL = `
ALTER TABLE tactic_candidates ADD COLUMN IF NOT EXISTS match text NOT NULL DEFAULT 'new';
ALTER TABLE tactic_candidates ADD COLUMN IF NOT EXISTS target_tactic_id text;
ALTER TABLE tactic_candidates ADD COLUMN IF NOT EXISTS matching jsonb;
CREATE TABLE IF NOT EXISTS tactic_source_references (
 id text PRIMARY KEY, tactic_id text NOT NULL, source_id text NOT NULL,
 source_quote text NOT NULL, quote_key text NOT NULL, created_at text NOT NULL,
 UNIQUE(tactic_id, source_id, quote_key)
);
CREATE TABLE IF NOT EXISTS tactic_suggestions (
 id text PRIMARY KEY, source_key text NOT NULL UNIQUE, target_tactic_id text NOT NULL,
 source_id text NOT NULL, status text NOT NULL, payload jsonb NOT NULL,
 created_at text NOT NULL, updated_at text NOT NULL
);
`;
