/** Read adapter for the existing extraction checkpoint; no extraction or completeness calculation. */
import { and, desc, eq } from "drizzle-orm";
import { accuracyDb } from "@/accuracy/store/db";
import { accuracyExtractionBatches } from "@/accuracy/store/schema";
import { assertSourceRevision, ExtractionBatchError } from "@/accuracy/store/extraction-batch-store";
export async function sourceExtractionCheckpoint(workspaceId: string, sourceFileId: string) {
  const [batch] = await accuracyDb().select().from(accuracyExtractionBatches).where(and(
    eq(accuracyExtractionBatches.workspace_id, workspaceId), eq(accuracyExtractionBatches.source_file_id, sourceFileId),
  )).orderBy(desc(accuracyExtractionBatches.created_at)).limit(1);
  if (!batch?.source_progress) return null;
  let stale = false;
  try { await assertSourceRevision(batch); }
  catch (error) { if (!(error instanceof ExtractionBatchError)) throw error; stale = true; }
  return { progress: batch.source_progress, kinds: batch.requested_kinds.flatMap(kind => kind === "need_extract" ? ["need" as const] : kind === "inventory_extract" ? ["inventory" as const] : []), stale };
}
