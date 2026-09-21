import { integer, pgTable, text } from "drizzle-orm/pg-core";

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
