import { and, desc, eq } from "drizzle-orm";
import { accuracyDb, ensureAccuracySchema } from "./db";
import * as t from "./schema";
import { newId, nowIso } from "@/modules/kernel/ids";
import { getWorkspaceOrgId } from "./tenant";

export type SourceFileRow = typeof t.accuracySourceFiles.$inferSelect;

export async function insertSourceFile(args: {
  workspace_id: string;
  org_id?: string;
  filename: string;
  mime: string;
  checksum: string;
  doc_role?: string;
  reference_pack_id?: string | null;
}): Promise<SourceFileRow> {
  await ensureAccuracySchema();
  const org_id = args.org_id ?? (await getWorkspaceOrgId(args.workspace_id));
  if (!org_id) throw new Error(`Unknown workspace: ${args.workspace_id}`);
  const row = {
    id: newId("src"),
    workspace_id: args.workspace_id,
    org_id,
    filename: args.filename,
    mime: args.mime,
    doc_role: args.doc_role ?? "other",
    checksum: args.checksum,
    uploaded_at: nowIso(),
    reference_pack_id: args.reference_pack_id ?? null,
  };
  await accuracyDb().insert(t.accuracySourceFiles).values(row);
  return row as SourceFileRow;
}

export async function listSourceFiles(workspace_id: string, limit = 100): Promise<SourceFileRow[]> {
  await ensureAccuracySchema();
  return accuracyDb()
    .select()
    .from(t.accuracySourceFiles)
    .where(eq(t.accuracySourceFiles.workspace_id, workspace_id))
    .orderBy(desc(t.accuracySourceFiles.uploaded_at))
    .limit(limit);
}

export async function countParseBlocks(workspace_id: string, source_file_id: string): Promise<number> {
  await ensureAccuracySchema();
  const rows = await accuracyDb()
    .select({ id: t.accuracyParseBlocks.id })
    .from(t.accuracyParseBlocks)
    .where(
      and(
        eq(t.accuracyParseBlocks.workspace_id, workspace_id),
        eq(t.accuracyParseBlocks.source_file_id, source_file_id),
      ),
    );
  return rows.length;
}
