import type { SourceContext } from "@/lib/ingest/source-citation";
import { integer, jsonb, pgTable, text } from "drizzle-orm/pg-core";

/** Module-owned table: gap proposals with their critic score and judge verdict. */
export const gapCandidates = pgTable("gap_candidates", {
  id: text("id").primaryKey(),
  run_id: text("run_id").notNull(),
  document_id: text("document_id").notNull(),
  source_id: text("source_id").notNull(),
  name: text("name").notNull(),
  statement: text("statement").notNull(),
  domain: text("domain").notNull(),
  source_quote: text("source_quote").notNull(),
  block_id: text("block_id"),
  source_context: jsonb("source_context").$type<SourceContext>(),
  citation_error: text("citation_error"),
  score: integer("score").notNull(),
  verdict: text("verdict").notNull(),
  critic_note: text("critic_note").notNull(),
  proposer: text("proposer").notNull(),
  committed_gap_id: text("committed_gap_id"),
  created_at: text("created_at").notNull(),
});

export const GAP_CANDIDATES_DDL = `
CREATE TABLE IF NOT EXISTS gap_candidates (
  id text PRIMARY KEY, run_id text NOT NULL, document_id text NOT NULL,
  source_id text NOT NULL, name text NOT NULL, statement text NOT NULL,
  domain text NOT NULL, source_quote text NOT NULL, score integer NOT NULL,
  verdict text NOT NULL, critic_note text NOT NULL, proposer text NOT NULL,
  committed_gap_id text, created_at text NOT NULL
);
ALTER TABLE gap_candidates ADD COLUMN IF NOT EXISTS block_id text;
ALTER TABLE gap_candidates ADD COLUMN IF NOT EXISTS source_context jsonb;
ALTER TABLE gap_candidates ADD COLUMN IF NOT EXISTS citation_error text;
`;
