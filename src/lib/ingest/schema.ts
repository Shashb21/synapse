/** Workspace-local checkpoints contain references and results, never uploaded bytes. */
import { jsonb, pgTable, text } from "drizzle-orm/pg-core";

export const ingestionJobs = pgTable("ingestion_jobs", {
  id: text("id").primaryKey(),
  checkpoint: jsonb("checkpoint").notNull(),
});

export const INGESTION_JOBS_DDL = `
CREATE TABLE IF NOT EXISTS ingestion_jobs (
  id text PRIMARY KEY, checkpoint jsonb NOT NULL
)
`;
