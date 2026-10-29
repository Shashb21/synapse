/** Coordinate short source mutations with extraction snapshot validation. */
import { and, eq } from "drizzle-orm";
import { accuracyDb } from "./db";
import { accuracySourceFiles } from "./schema";

/** Operations shared by the regular database and an explicit transaction. */
export type SourceConnection = Pick<ReturnType<typeof accuracyDb>, "select" | "insert" | "update" | "delete" | "execute">;

/**
 * Lock the source before reading blocks or their dependent claims. Call only
 * inside a transaction, and always before acquiring any checkpoint/block locks.
 */
export async function lockAccuracySource(db: SourceConnection, workspaceId: string, sourceId: string): Promise<void> {
  const [source] = await db.select({ id: accuracySourceFiles.id }).from(accuracySourceFiles)
    .where(and(eq(accuracySourceFiles.workspace_id, workspaceId), eq(accuracySourceFiles.id, sourceId)))
    .for("update");
  if (!source) throw new Error(`Unknown source file ${sourceId}.`);
}
