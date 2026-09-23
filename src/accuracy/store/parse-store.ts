import { eq } from "drizzle-orm";
import { accuracyDb, ensureAccuracySchema } from "./db";
import * as t from "./schema";
import { newId, nowIso } from "@/modules/kernel/ids";
import type { ParseBlock } from "./quote-validator";

export async function persistParseBlocks(args: {
  workspace_id: string;
  source_file_id: string;
  parser: string;
  blocks: Omit<ParseBlock, "workspace_id">[];
}) {
  await ensureAccuracySchema();
  const db = accuracyDb();
  const created_at = nowIso();
  for (const block of args.blocks) {
    await db.insert(t.accuracyParseBlocks).values({
      id: block.id,
      workspace_id: args.workspace_id,
      source_file_id: args.source_file_id,
      index: block.index,
      kind: block.kind,
      heading: block.heading,
      text: block.text,
      parser: args.parser,
      created_at,
    });
  }
  return args.blocks.length;
}

export async function readParseBlocks(workspace_id: string, source_file_id: string) {
  await ensureAccuracySchema();
  const rows = await accuracyDb()
    .select()
    .from(t.accuracyParseBlocks)
    .where(eq(t.accuracyParseBlocks.workspace_id, workspace_id));
  return rows.filter((r) => r.source_file_id === source_file_id);
}

export function blocksFromParsedDocument(args: {
  workspace_id: string;
  source_file_id: string;
  blocks: { id: string; text: string; location?: { ref?: string } }[];
}): ParseBlock[] {
  return args.blocks.map((b, index) => ({
    id: b.id,
    workspace_id: args.workspace_id,
    source_file_id: args.source_file_id,
    index,
    kind: "prose" as const,
    heading: b.location?.ref ?? null,
    text: b.text,
  }));
}

export async function registerSourceFile(args: {
  workspace_id: string;
  org_id: string;
  filename: string;
  mime: string;
  checksum: string;
  doc_role?: string;
  reference_pack_id?: string;
}) {
  await ensureAccuracySchema();
  const id = newId("src");
  await accuracyDb().insert(t.accuracySourceFiles).values({
    id,
    workspace_id: args.workspace_id,
    org_id: args.org_id,
    filename: args.filename,
    mime: args.mime,
    doc_role: args.doc_role ?? "integrated_evidence_plan",
    checksum: args.checksum,
    uploaded_at: nowIso(),
    reference_pack_id: args.reference_pack_id ?? null,
  });
  return id;
}
