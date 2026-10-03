/** Applied extraction identities and durable, atomic downstream resume operations. */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { accuracyDb, ensureAccuracySchema, withAccuracyTransaction } from "./db";
import * as t from "./schema";
import { AccuracyPausedError } from "@/accuracy/kernel/omission-pause";
import { newId, nowIso } from "@/modules/kernel/ids";

export type ExtractionBatch = typeof t.accuracyExtractionBatches.$inferSelect;
export type ResumeJournal = typeof t.accuracyResumeJournals.$inferSelect;

/** Conflict response for invalid identities or an active resume transaction. */
export class ExtractionBatchError extends Error {
  constructor(readonly code: "stale_batch" | "resume_in_progress", message: string) { super(message); }
}

/** Serialize batch application, omission decisions, and downstream writes in a workspace. */
async function lockWorkspace(workspace_id: string, wait = true) {
  if (wait) {
    await accuracyDb().execute(sql`select pg_advisory_xact_lock(hashtextextended(${`omission:${workspace_id}`}, 0))`);
  } else {
    const result = await accuracyDb().execute(sql`select pg_try_advisory_xact_lock(hashtextextended(${`omission:${workspace_id}`}, 0)) as acquired`);
    if (!result[0]?.acquired) throw new ExtractionBatchError("resume_in_progress", "A resume or source review is already in progress.");
  }
}

/** Create a server-owned batch before extraction, with no downstream eligibility yet. */
export async function createExtractionBatch(workspace_id: string, source_file_id: string, requested_kinds: string[]) {
  await ensureAccuracySchema();
  const [batch] = await accuracyDb().insert(t.accuracyExtractionBatches).values({ id: newId("batch"), workspace_id,
    source_file_id, requested_kinds: [...new Set(requested_kinds)], run_ids: [], created_claim_ids: [], drafts_persisted: false, created_at: nowIso() }).returning();
  return batch;
}

/** Publish a batch only after its successful extractor runs and all draft writes finish. */
export async function applyExtractionBatch(batch: ExtractionBatch, run_ids: string[], created_claim_ids: string[], persistDrafts: () => Promise<void>) {
  return withAccuracyTransaction(async () => {
    await lockWorkspace(batch.workspace_id);
    await persistDrafts();
    await accuracyDb().update(t.accuracyExtractionBatches).set({ run_ids, created_claim_ids, drafts_persisted: true })
      .where(and(eq(t.accuracyExtractionBatches.id, batch.id), eq(t.accuracyExtractionBatches.workspace_id, batch.workspace_id)));
  });
}

/** Look up the server-owned applied batch for a run-scoped review response. */
export async function extractionBatchForRun(workspace_id: string, run_id: string): Promise<string | null> {
  await ensureAccuracySchema();
  const batches = await accuracyDb().select().from(t.accuracyExtractionBatches).where(and(
    eq(t.accuracyExtractionBatches.workspace_id, workspace_id), eq(t.accuracyExtractionBatches.drafts_persisted, true)));
  const [run] = await accuracyDb().select().from(t.accuracyModuleRuns).where(and(
    eq(t.accuracyModuleRuns.workspace_id, workspace_id), eq(t.accuracyModuleRuns.id, run_id), eq(t.accuracyModuleRuns.status, "ok")));
  if (!run) return null;
  const input = run.input as Record<string, unknown> | null;
  if (input?.workspace_id !== workspace_id || (input.call_kind !== undefined && input.call_kind !== run.call_kind)) return null;
  return batches.find(batch => batch.run_ids.includes(run_id) && batch.requested_kinds.includes(run.call_kind)
    && batch.source_file_id === input.source_file_id)?.id ?? null;
}

/** Verify persisted successful runs and the latest applied extraction identity per kind. */
async function currentBatch(workspace_id: string, source_file_id: string, batch_id: string): Promise<ExtractionBatch> {
  const fail = () => { throw new ExtractionBatchError("stale_batch", "Extraction batch is stale or does not belong to this source."); };
  const batches = await accuracyDb().select().from(t.accuracyExtractionBatches).where(and(
    eq(t.accuracyExtractionBatches.workspace_id, workspace_id), eq(t.accuracyExtractionBatches.source_file_id, source_file_id), eq(t.accuracyExtractionBatches.drafts_persisted, true)));
  const batch = batches.find(row => row.id === batch_id);
  if (!batch || !batch.run_ids.length || batch.run_ids.length !== batch.requested_kinds.length
    || new Set(batch.requested_kinds).size !== batch.requested_kinds.length
    || batch.requested_kinds.some(kind => kind !== "need_extract" && kind !== "inventory_extract")) return fail();
  const rows = await accuracyDb().select().from(t.accuracyModuleRuns).where(and(eq(t.accuracyModuleRuns.workspace_id, workspace_id),
    eq(t.accuracyModuleRuns.status, "ok"), inArray(t.accuracyModuleRuns.call_kind, ["need_extract", "inventory_extract"])))
    .orderBy(desc(t.accuracyModuleRuns.finished_at), desc(t.accuracyModuleRuns.id));
  const matching = rows.filter(row => {
    const input = row.input as Record<string, unknown> | null;
    return input?.source_file_id === source_file_id && input?.workspace_id === workspace_id
      && (input.call_kind === undefined || input.call_kind === row.call_kind)
      && batches.some(applied => applied.run_ids.includes(row.id) && applied.requested_kinds.includes(row.call_kind));
  });
  // Even a different extraction kind changes the downstream input for this source.
  if (!matching.length || !batch.run_ids.includes(matching[0].id)) return fail();
  for (const kind of batch.requested_kinds) {
    const latest = matching.find(row => row.call_kind === kind);
    if (!latest || !batch.run_ids.includes(latest.id)) return fail();
  }
  return batch;
}

/** Reserve stage IDs durably, then atomically commit their effects and replayable response. */
export async function resumeExtractionBatch<T>(args: { workspace_id: string; source_file_id: string; batch_id: string;
  execute: (batch: ExtractionBatch, journal: ResumeJournal) => Promise<T> }): Promise<T> {
  // Reservation survives a later failed stage; no running marker needs timeout-based takeover.
  await withAccuracyTransaction(async () => {
    await lockWorkspace(args.workspace_id, false);
    await currentBatch(args.workspace_id, args.source_file_id, args.batch_id);
    await accuracyDb().insert(t.accuracyResumeJournals).values({ id: newId("resume"), workspace_id: args.workspace_id,
      batch_id: args.batch_id, merge_operation_id: newId("arun"), status_operation_id: newId("arun"), created_at: nowIso(), updated_at: nowIso() })
      .onConflictDoNothing();
  });
  const result = await withAccuracyTransaction(async () => {
    await lockWorkspace(args.workspace_id, false);
    const batch = await currentBatch(args.workspace_id, args.source_file_id, args.batch_id);
    const [journal] = await accuracyDb().select().from(t.accuracyResumeJournals).where(and(
      eq(t.accuracyResumeJournals.workspace_id, args.workspace_id), eq(t.accuracyResumeJournals.batch_id, args.batch_id)));
    if (journal.final_response !== null) return { response: journal.final_response as T };
    let response: T;
    try { response = await args.execute(batch, journal); }
    catch (error) {
      if (!(error instanceof AccuracyPausedError)) throw error;
      // A pause is a valid checkpoint: preserve completed stage effects and their IDs.
      // Actual stage failures still throw through the transaction and roll back all writes.
      const completed = await accuracyDb().select().from(t.accuracyModuleRuns).where(and(
        eq(t.accuracyModuleRuns.workspace_id, args.workspace_id), eq(t.accuracyModuleRuns.status, "ok"),
        inArray(t.accuracyModuleRuns.id, [journal.merge_operation_id, journal.status_operation_id])));
      await accuracyDb().update(t.accuracyResumeJournals).set({
        merge_state: completed.some(run => run.id === journal.merge_operation_id) ? "completed" : "reserved",
        status_state: completed.some(run => run.id === journal.status_operation_id) ? "completed" : "reserved",
        updated_at: nowIso(),
      }).where(eq(t.accuracyResumeJournals.id, journal.id));
      return { pause: error };
    }
    await accuracyDb().update(t.accuracyResumeJournals).set({ merge_state: "completed", status_state: "completed",
      final_response: response, updated_at: nowIso() }).where(eq(t.accuracyResumeJournals.id, journal.id));
    return { response };
  });
  if ("pause" in result) throw result.pause;
  return result.response;
}

/** Report server-owned downstream eligibility independently of finding currency. */
export async function extractionDownstreamState(workspace_id: string, source_file_id: string, batch_id: string): Promise<"completed" | "resumable" | "stale"> {
  await ensureAccuracySchema();
  try { await currentBatch(workspace_id, source_file_id, batch_id); }
  catch (error) { if (error instanceof ExtractionBatchError) return "stale"; throw error; }
  const [journal] = await accuracyDb().select().from(t.accuracyResumeJournals).where(and(
    eq(t.accuracyResumeJournals.workspace_id, workspace_id), eq(t.accuracyResumeJournals.batch_id, batch_id)));
  if (journal?.final_response == null) return "resumable";
  const [assembly] = await accuracyDb().select({ id: t.accuracyAssemblies.id }).from(t.accuracyAssemblies).where(and(
    eq(t.accuracyAssemblies.workspace_id, workspace_id), eq(t.accuracyAssemblies.generation_key, batch_id),
  )).limit(1);
  return assembly ? "completed" : "resumable";
}
