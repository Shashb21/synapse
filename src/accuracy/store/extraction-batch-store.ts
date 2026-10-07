import { sourceHash, type SourceProgress } from "../domain/source-pages";
import { readParseBlocks, listDroppedUnits } from "./parse-store";
import { getSourceFile } from "./source-store";
/** Applied extraction identities and durable, atomic downstream resume operations. */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import { accuracyDb, accuracyTransactionActive, ensureAccuracySchema, withAccuracyTransaction } from "./db";
import * as t from "./schema";
import { AccuracyPausedError } from "@/accuracy/kernel/omission-pause";
import { captureMergeInputs, mergeDedupeModule } from "@/accuracy/modules/merge-dedupe/module";
import { activeAccuracyModule } from "@/accuracy/kernel/registry";
import { prepareAccuracyMerge, type PreparedAccuracyMerge } from "@/accuracy/kernel/run";
import { reservedAccuracyRun, DEFAULT_STALE_RUN_MAX_AGE_MS } from "@/accuracy/kernel/observability";
import type { Actor } from "@/accuracy/kernel/contracts";
import { isTestStub } from "@/modules/kernel/llm";
import { newId, nowIso } from "@/modules/kernel/ids";

export type ExtractionBatch = typeof t.accuracyExtractionBatches.$inferSelect;
export type ResumeJournal = typeof t.accuracyResumeJournals.$inferSelect;

/** Conflict response for invalid identities or an active resume transaction. */
export class ExtractionBatchError extends Error {
  constructor(readonly code: "stale_batch" | "stale_merge_inputs" | "resume_in_progress" | "source_incomplete", message: string) { super(message); }
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
export async function createExtractionBatch(workspace_id: string, source_file_id: string, requested_kinds: string[], source_progress?: SourceProgress) {
  await ensureAccuracySchema();
  const [batch] = await accuracyDb().insert(t.accuracyExtractionBatches).values({ id: newId("batch"), workspace_id,
    source_file_id, source_progress: source_progress ?? null, requested_kinds: [...new Set(requested_kinds)], run_ids: [], created_claim_ids: [], drafts_persisted: false, created_at: nowIso() }).returning();
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
    eq(t.accuracyExtractionBatches.workspace_id, workspace_id), eq(t.accuracyExtractionBatches.source_file_id, source_file_id)));
  const batch = batches.find(row => row.id === batch_id);
  if (batch?.source_progress) {
    await assertSourceRevision(batch);
    if (!batch.source_progress.complete) throw new ExtractionBatchError("source_incomplete", "Declared source pages are not complete.");
    const latest = batches.filter(b => b.drafts_persisted).sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))[0];
    if (latest?.id !== batch.id) return fail();
    const members = batch.source_progress.pages.flatMap(page => batch.requested_kinds.map(kind => ({ page, kind, attempt: page.attempts[kind] })));
    if (members.some(m => m.attempt.state !== "successful" || !m.attempt.run_id) || members.length !== batch.run_ids.length) return fail();
    const runs = await accuracyDb().select().from(t.accuracyModuleRuns).where(and(eq(t.accuracyModuleRuns.workspace_id, workspace_id), inArray(t.accuracyModuleRuns.id, batch.run_ids)));
    for (const { page, kind, attempt } of members) {
      const run = runs.find(r => r.id === attempt.run_id);
      const input = run?.input as Record<string, unknown> | null;
      if (!run || run.status !== "ok" || run.call_kind !== kind || input?.workspace_id !== workspace_id || input.source_file_id !== source_file_id
        || (input.source_page as { id?: string } | undefined)?.id !== page.id) return fail();
    }
    return batch;
  }
  if (!batch || !batch.drafts_persisted || !batch.run_ids.length || batch.run_ids.length !== batch.requested_kinds.length
    || new Set(batch.requested_kinds).size !== batch.requested_kinds.length
    || batch.requested_kinds.some(kind => kind !== "need_extract" && kind !== "inventory_extract")) return fail();
  const rows = await accuracyDb().select().from(t.accuracyModuleRuns).where(and(eq(t.accuracyModuleRuns.workspace_id, workspace_id),
    eq(t.accuracyModuleRuns.status, "ok"), inArray(t.accuracyModuleRuns.call_kind, ["need_extract", "inventory_extract"])))
    .orderBy(desc(t.accuracyModuleRuns.finished_at), desc(t.accuracyModuleRuns.id));
  const matching = rows.filter(row => {
    const input = row.input as Record<string, unknown> | null;
    return input?.source_file_id === source_file_id && input?.workspace_id === workspace_id
      && (input.call_kind === undefined || input.call_kind === row.call_kind)
      && batches.some(applied => applied.drafts_persisted && applied.run_ids.includes(row.id) && applied.requested_kinds.includes(row.call_kind));
  });
  // Even a different extraction kind changes the downstream input for this source.
  if (!matching.length || !batch.run_ids.includes(matching[0].id)) return fail();
  for (const kind of batch.requested_kinds) {
    const latest = matching.find(row => row.call_kind === kind);
    if (!latest || !batch.run_ids.includes(latest.id)) return fail();
  }
  return batch;
}

/** Reserve/capture briefly, judge without locks, then atomically apply the unchanged inputs. */
export async function resumeExtractionBatch<T>(args: { workspace_id: string; source_file_id: string; batch_id: string;
  merge_context: { org_id: string; actor: Actor; evaluation_context?: "production" | "experiment" };
  /** Notify orchestration of the reserved merge ID outside the transaction, before preparation can fail. */
  onMergePreparation?: (journal: ResumeJournal) => void;
  execute: (batch: ExtractionBatch, journal: ResumeJournal, prepared?: PreparedAccuracyMerge) => Promise<T> }): Promise<T> {
  // Never let the preparation phase join a caller's outer transaction.
  if (accuracyTransactionActive()) throw new Error("Extraction resume must start outside every Accuracy transaction.");
  const token = newId("prepare");
  const reservation = await withAccuracyTransaction(async () => {
    await lockWorkspace(args.workspace_id, false);
    const batch = await currentBatch(args.workspace_id, args.source_file_id, args.batch_id);
    await accuracyDb().insert(t.accuracyResumeJournals).values({ id: newId("resume"), workspace_id: args.workspace_id,
      batch_id: args.batch_id, merge_operation_id: newId("arun"), status_operation_id: newId("arun"), created_at: nowIso(), updated_at: nowIso() })
      .onConflictDoNothing();
    const [journal] = await accuracyDb().select().from(t.accuracyResumeJournals).where(and(
      eq(t.accuracyResumeJournals.workspace_id, args.workspace_id), eq(t.accuracyResumeJournals.batch_id, args.batch_id)));
    if (journal.final_response !== null) return { replay: true as const, response: journal.final_response as T };
    // A durable, fenced lease rejects duplicate providers across server processes.
    // Expiration recovers a crashed worker; a superseded worker cannot publish.
    if (journal.preparation_token && Date.now() - Date.parse(journal.preparation_started_at ?? "") < DEFAULT_STALE_RUN_MAX_AGE_MS) {
      throw new ExtractionBatchError("resume_in_progress", "A resume judgment or application is already in progress.");
    }
    const implementation = await activeAccuracyModule("merge_dedupe");
    const completed = await reservedAccuracyRun(args.workspace_id, journal.merge_operation_id);
    const inputs = implementation.manifest.id === mergeDedupeModule.manifest.id && !completed
      ? await captureMergeInputs(args.workspace_id) : undefined;
    const cached = journal.prepared_merge as PreparedAccuracyMerge | null;
    const prepared = inputs && cached && cached.judgment.revision === inputs.revision
      && cached.judgment.stub === isTestStub()
      && cached.module_id === implementation.manifest.id && cached.module_version === implementation.manifest.version
      && cached.workspace_id === args.workspace_id && cached.org_id === args.merge_context.org_id
      && cached.run_id === journal.merge_operation_id ? cached : undefined;
    await accuracyDb().update(t.accuracyResumeJournals).set({ preparation_token: token,
      preparation_started_at: nowIso(), updated_at: nowIso() }).where(eq(t.accuracyResumeJournals.id, journal.id));
    return { replay: false as const, batch, journal, inputs, prepared, prior: cached ?? undefined };
  }, { isolationLevel: "serializable" });
  if (reservation.replay) return reservation.response;
  let prepared = reservation.prepared;
  try {
    if (reservation.inputs && !prepared) {
      args.onMergePreparation?.(reservation.journal);
      prepared = await prepareAccuracyMerge({ ...args.merge_context, workspace_id: args.workspace_id,
        run_id: reservation.journal.merge_operation_id, inputs: reservation.inputs, prior: reservation.prior });
      // Successful paid judgment survives an apply rollback. CAS fences lease takeover.
      const saved = await accuracyDb().update(t.accuracyResumeJournals).set({ prepared_merge: prepared, updated_at: nowIso() })
        .where(and(eq(t.accuracyResumeJournals.id, reservation.journal.id), eq(t.accuracyResumeJournals.preparation_token, token))).returning();
      if (!saved.length) throw new ExtractionBatchError("resume_in_progress", "Resume reservation was superseded.");
    }
    const result = await withAccuracyTransaction(async () => {
      await lockWorkspace(args.workspace_id, false);
      const batch = await currentBatch(args.workspace_id, args.source_file_id, args.batch_id);
      if (!isDeepStrictEqual(batch, reservation.batch)) throw new ExtractionBatchError("stale_batch", "Applied extraction batch changed during resume preparation.");
      const [journal] = await accuracyDb().select().from(t.accuracyResumeJournals).where(and(
        eq(t.accuracyResumeJournals.workspace_id, args.workspace_id), eq(t.accuracyResumeJournals.batch_id, args.batch_id)));
      if (journal.final_response !== null) return { response: journal.final_response as T };
      if (journal.preparation_token !== token) throw new ExtractionBatchError("resume_in_progress", "Resume reservation was superseded.");
      if (prepared) {
        const implementation = await activeAccuracyModule("merge_dedupe");
        const inputs = await captureMergeInputs(args.workspace_id);
        if (implementation.manifest.id !== prepared.module_id || implementation.manifest.version !== prepared.module_version
          || inputs.revision !== prepared.judgment.revision) {
          throw new ExtractionBatchError("stale_merge_inputs", "Merge inputs changed during judgment. Resume again to prepare the current inputs.");
        }
      }
      let response: T;
      try { response = await args.execute(batch, journal, prepared); }
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
    }, { isolationLevel: "serializable" });
    if ("pause" in result) throw result.pause;
    return result.response;
  } finally {
    await accuracyDb().update(t.accuracyResumeJournals).set({ preparation_token: null, preparation_started_at: null, updated_at: nowIso() })
      .where(and(eq(t.accuracyResumeJournals.id, reservation.journal.id), eq(t.accuracyResumeJournals.preparation_token, token)));
  }
}

/** Report server-owned downstream eligibility independently of finding currency. */
export async function extractionDownstreamState(workspace_id: string, source_file_id: string, batch_id: string): Promise<"completed" | "resumable" | "stale" | "incomplete"> {
  await ensureAccuracySchema();
  try { await currentBatch(workspace_id, source_file_id, batch_id); }
  catch (error) { if (error instanceof ExtractionBatchError) return error.code === "source_incomplete" ? "incomplete" : "stale"; throw error; }
  const [journal] = await accuracyDb().select().from(t.accuracyResumeJournals).where(and(
    eq(t.accuracyResumeJournals.workspace_id, workspace_id), eq(t.accuracyResumeJournals.batch_id, batch_id)));
  return journal?.final_response != null ? "completed" : "resumable";
}


/** Read the journal-owned extraction checkpoint, scoped to its workspace/source. */
export async function getExtractionBatch(workspace_id: string, source_file_id: string, batch_id: string): Promise<ExtractionBatch> {
  await ensureAccuracySchema();
  const [batch] = await accuracyDb().select().from(t.accuracyExtractionBatches).where(and(eq(t.accuracyExtractionBatches.workspace_id, workspace_id),
    eq(t.accuracyExtractionBatches.source_file_id, source_file_id), eq(t.accuracyExtractionBatches.id, batch_id)));
  if (!batch) throw new ExtractionBatchError("stale_batch", "Unknown extraction batch for this source.");
  return batch;
}

/** Full source identity never uses the merge capture/list limit. */
export async function currentSourceRevision(workspace_id: string, source_file_id: string) {
  const source = await getSourceFile(workspace_id, source_file_id);
  if (!source) throw new ExtractionBatchError("stale_batch", "Unknown source in workspace.");
  const blocks = (await readParseBlocks(workspace_id, source_file_id)).sort((a, b) => a.index - b.index || a.id.localeCompare(b.id));
  const dropped = (await listDroppedUnits(workspace_id, source_file_id)).filter(d => !d.restored_block_id).sort((a, b) => a.id.localeCompare(b.id));
  return { source, blocks, dropped, revision: sourceHash({ workspace_id, source_file_id, checksum: source.checksum,
    blocks: blocks.map(b => ({ id: b.id, index: b.index, kind: b.kind, heading: b.heading, text: b.text })), dropped: dropped.map(d => ({ id: d.id, text: d.text, reason: d.reason, location: d.location })) }) };
}
export async function assertSourceRevision(batch: ExtractionBatch) {
  if (batch.source_progress && (await currentSourceRevision(batch.workspace_id, batch.source_file_id)).revision !== batch.source_progress.source_revision) {
    throw new ExtractionBatchError("stale_batch", "Source revision changed; begin a new extraction.");
  }
}

export function sourcePageCursor(batch_id: string, page_id: string): string {
  return Buffer.from(JSON.stringify([batch_id, page_id])).toString("base64url");
}
export function parseSourceCursor(cursor: string): [string, string] {
  try {
    if (!cursor || cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString());
    if (!Array.isArray(value) || value.length !== 2 || value.some(v => typeof v !== "string" || !v.trim())) throw new Error();
    return value as [string, string];
  } catch { throw new ExtractionBatchError("stale_batch", "Invalid source cursor."); }
}

/** Recompute visible completeness and the first unfinished page from declared membership. */
export function refreshSourceProgress(batch_id: string, progress: SourceProgress): SourceProgress {
  let processed_units = 0, failed_units = 0;
  for (const page of progress.pages) {
    for (const attempt of Object.values(page.attempts)) {
      if (attempt.state === "successful") processed_units += page.units.length;
      if (attempt.state === "failed" || attempt.state === "incomplete") failed_units += page.units.length;
    }
  }
  const next = progress.pages.find(p => Object.values(p.attempts).some(a => a.state !== "successful"));
  const complete = !next && progress.upstream_dropped_units.length === 0;
  return { ...progress, processed_units, failed_units, complete, full_source_complete: complete && progress.selection_scope === "all",
    next_cursor: next ? sourcePageCursor(batch_id, next.id) : null };
}

/** Reserve a page attempt briefly; provider work follows after the transaction releases. */
export async function reserveExtractionPage(args: { workspace_id: string; source_file_id: string; batch_id: string; page_id: string; kind: string; run_id: string }) {
  return withAccuracyTransaction(async () => {
    await lockWorkspace(args.workspace_id);
    const batch = await getExtractionBatch(args.workspace_id, args.source_file_id, args.batch_id);
    await assertSourceRevision(batch);
    const progress = batch.source_progress;
    const page = progress?.pages.find(p => p.id === args.page_id);
    const attempt = page?.attempts[args.kind];
    if (!progress || !page || !attempt) throw new ExtractionBatchError("stale_batch", "Page is outside the declared extraction selection.");
    if (attempt.state === "successful") return null;
    if (attempt.token && Date.now() - Date.parse(attempt.started_at ?? "") < DEFAULT_STALE_RUN_MAX_AGE_MS) throw new ExtractionBatchError("resume_in_progress", "Source page is already running.");
    const token = newId("page");
    page.attempts[args.kind] = { ...attempt, state: "running", token, started_at: nowIso() };
    await accuracyDb().update(t.accuracyExtractionBatches).set({ source_progress: refreshSourceProgress(batch.id, progress) }).where(eq(t.accuracyExtractionBatches.id, batch.id));
    return token;
  });
}

/** Accept page claims and membership together; a failed attempt cannot erase another page. */
export async function applyExtractionPage(args: { workspace_id: string; source_file_id: string; batch_id: string; page_id: string; kind: string;
  token: string; run_id: string; complete: boolean; error?: string; rejected_candidates?: { index: number; field: string; reason: string }[];
  persist?: () => Promise<string[]> }) {
  return withAccuracyTransaction(async () => {
    await lockWorkspace(args.workspace_id);
    const batch = await getExtractionBatch(args.workspace_id, args.source_file_id, args.batch_id);
    await assertSourceRevision(batch);
    const progress = batch.source_progress!;
    const page = progress.pages.find(p => p.id === args.page_id)!;
    const previous = page?.attempts[args.kind];
    if (!progress || !page || !previous || previous.token !== args.token) throw new ExtractionBatchError("resume_in_progress", "Source page reservation was superseded.");
    const claim_ids = args.persist ? await args.persist() : previous.claim_ids ?? [];
    page.attempts[args.kind] = { state: args.error ? "failed" : args.complete ? "successful" : "incomplete", run_id: args.run_id,
      claim_ids, ...(args.error ? { error: args.error } : {}), ...(args.rejected_candidates?.length ? { rejected_candidates: args.rejected_candidates } : {}) };
    const run_ids = [...new Set(progress.pages.flatMap(p => Object.values(p.attempts).flatMap(a => a.run_id && a.claim_ids && a.state !== "failed" ? [a.run_id] : [])))];
    const created_claim_ids = [...new Set([...batch.created_claim_ids, ...claim_ids])];
    const [saved] = await accuracyDb().update(t.accuracyExtractionBatches).set({ source_progress: refreshSourceProgress(batch.id, progress),
      run_ids, created_claim_ids, drafts_persisted: batch.drafts_persisted || Boolean(args.persist && (args.complete || claim_ids.length)) }).where(eq(t.accuracyExtractionBatches.id, batch.id)).returning();
    return saved;
  });
}
