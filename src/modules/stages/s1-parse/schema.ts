import { integer, jsonb, pgTable, text } from "drizzle-orm/pg-core";

/** Module-owned table: parse artifacts with quality signals, keyed to a source file. */
export const parsedDocuments = pgTable("parsed_documents", {
  id: text("id").primaryKey(),
  file_id: text("file_id").notNull(),
  source_id: text("source_id").notNull(),
  parser: text("parser").notNull(),
  parser_version: text("parser_version").notNull(),
  blocks: jsonb("blocks").notNull(),
  quality: jsonb("quality").notNull(),
  parsed_at: text("parsed_at").notNull(),
  duration_ms: integer("duration_ms").notNull(),
});

export const PARSED_DOCUMENTS_DDL = `
CREATE TABLE IF NOT EXISTS parsed_documents (
  id text PRIMARY KEY, file_id text NOT NULL, source_id text NOT NULL,
  parser text NOT NULL, parser_version text NOT NULL,
  blocks jsonb NOT NULL, quality jsonb NOT NULL,
  parsed_at text NOT NULL, duration_ms integer NOT NULL
)
`;

export type ParseQuality = {
  blocks: number;
  characters: number;
  avg_block_chars: number;
  empty_blocks: number;
  need_cue_blocks: number;
  tactic_cue_blocks: number;
  warnings: string[];
};

export type ParsedDocumentBlock = {
  id: string;
  source_id: string;
  heading: string;
  text: string;
  location: string;
};
