import { integer, pgTable, text } from "drizzle-orm/pg-core";

/** Module-owned table: raw uploads, before any parse or extraction. */
export const sourceFiles = pgTable("source_files", {
  id: text("id").primaryKey(),
  workspace_id: text("workspace_id").notNull(),
  filename: text("filename").notNull(),
  title: text("title").notNull(),
  source_type: text("source_type").notNull(),
  stakeholder_function: text("stakeholder_function").notNull(),
  mime: text("mime").notNull(),
  bytes: integer("bytes").notNull(),
  checksum: text("checksum").notNull(),
  content_base64: text("content_base64").notNull(),
  status: text("status").notNull(),
  uploaded_by: text("uploaded_by").notNull(),
  uploaded_at: text("uploaded_at").notNull(),
  parsed_at: text("parsed_at"),
  source_id: text("source_id"),
  note: text("note"),
});

export const SOURCE_FILES_DDL = `
CREATE TABLE IF NOT EXISTS source_files (
  id text PRIMARY KEY, workspace_id text NOT NULL, filename text NOT NULL,
  title text NOT NULL, source_type text NOT NULL, stakeholder_function text NOT NULL,
  mime text NOT NULL, bytes integer NOT NULL, checksum text NOT NULL,
  content_base64 text NOT NULL, status text NOT NULL,
  uploaded_by text NOT NULL, uploaded_at text NOT NULL,
  parsed_at text, source_id text, note text
)
`;
