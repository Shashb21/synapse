import { boolean, integer, jsonb, pgTable, text } from "drizzle-orm/pg-core";

/** Module-owned table: proposed gap ↔ tactic edges with confidence and rationale. */
export const mappingCandidates = pgTable("mapping_candidates", {
  id: text("id").primaryKey(),
  run_id: text("run_id").notNull(),
  gap_id: text("gap_id").notNull(),
  tactic_id: text("tactic_id").notNull(),
  score: integer("score").notNull(),
  confidence: integer("confidence").notNull(),
  rationale: jsonb("rationale").notNull(),
  verdict: text("verdict").notNull(),
  committed: boolean("committed").notNull().default(false),
  proposer: text("proposer").notNull(),
  created_at: text("created_at").notNull(),
});

export const MAPPING_CANDIDATES_DDL = `
CREATE TABLE IF NOT EXISTS mapping_candidates (
  id text PRIMARY KEY, run_id text NOT NULL, gap_id text NOT NULL, tactic_id text NOT NULL,
  score integer NOT NULL, confidence integer NOT NULL, rationale jsonb NOT NULL,
  verdict text NOT NULL, committed boolean NOT NULL DEFAULT false,
  proposer text NOT NULL, created_at text NOT NULL
)
`;
