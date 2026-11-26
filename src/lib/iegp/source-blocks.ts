/** Owns source-block edits and preserves the provenance of existing evidence records. */
import { TrustedApplicationError } from "@/modules/kernel/stage-errors";
import { and, eq, exists, inArray, isNull, or, sql } from "drizzle-orm";
import { boolean, doublePrecision, pgTable, text } from "drizzle-orm/pg-core";
import { db, ensureCurrentSchemaTables, withWorkspaceTransaction } from "./db";
import * as t from "./schema";
import { ACTOR_FUNCTIONS, SOURCE_TYPES, type ActorFunction, type SourceType } from "./enums";
import { appendAudit, persistSourceAndBlocks, loadState, lockAssessmentOwners, invalidateRelationshipAssessments } from "./store";
import type { IegpState, TacticSuggestion } from "./types";
import { lockSourceCitationOwner } from "./source-citations";
import { tacticCandidates, tacticSourceReferences, tacticSuggestions } from "@/modules/stages/s3-tactic-extract/schema";
import { tacticPromotionEdit } from "@/modules/stages/s3-tactic-extract/promotions";
import { validateQuoteAgainstBlock } from "@/lib/ingest/quote-validator";
import { recordEdit } from "@/modules/kernel/edit-records";
import { editRecords } from "@/modules/kernel/schema";
import { moveTacticSourceCitations } from "@/modules/stages/s3-tactic-extract/suggestions";
import { newId, nowIso } from "@/modules/kernel/ids";
import type { Actor } from "@/modules/kernel/contracts";
import {
  containsQuote,
  describeOrphans,
  orphanedQuotes,
  requireEditRationale,
  resolveSplitOffset,
  splitAtOffset,
  squashText,
  type QuoteDependent,
} from "@/lib/ingest/manual-blocks";

/**
 * Human edits to S1 source blocks (the `sources` / `source_blocks` tables).
 *
 * The domain tables are rewritten wholesale by `persistState`, so everything a
 * human decided about a block lives in side tables keyed by block id:
 * - `source_block_meta`: who made the block, its order, the model's original
 *   text, and whether it is locked against a re-parse. A locked row applies only
 *   while the block's text still matches `current_text` (a reset that rebuilds
 *   the same id with other text does not inherit a stale human lock).
 * - `source_dropped_units`: units the parse model dropped as noise, verbatim.
 * - `source_stakeholder_meta`: the model's stakeholder classification with its
 *   rationale, and the human override.
 * Every change writes an edit record (rationale required) and an audit row.
 *
 * Extraction citations retain their exact block. Legacy quotes without an
 * identified block remain protected wherever they occur in the same source.
 */

export const sourceBlockMeta = pgTable("source_block_meta", {
  block_id: text("block_id").primaryKey(),
  source_id: text("source_id").notNull(),
  origin: text("origin").notNull(),
  locked: boolean("locked").notNull().default(false),
  deleted: boolean("deleted").notNull().default(false),
  position: doublePrecision("position"),
  current_text: text("current_text").notNull(),
  original_text: text("original_text"),
  original_heading: text("original_heading"),
  edited_by: text("edited_by"),
  edited_function: text("edited_function"),
  edited_at: text("edited_at"),
  source_generation: text("source_generation"),
});

export const sourceDroppedUnits = pgTable("source_dropped_units", {
  id: text("id").primaryKey(),
  source_id: text("source_id").notNull(),
  location: text("location").notNull(),
  reason: text("reason").notNull(),
  text: text("text").notNull(),
  occurrence_id: text("occurrence_id"),
  restored_block_id: text("restored_block_id"),
  created_at: text("created_at").notNull(),
  source_generation: text("source_generation"),
});

export const sourceStakeholderMeta = pgTable("source_stakeholder_meta", {
  source_id: text("source_id").primaryKey(),
  llm_function: text("llm_function"),
  llm_rationale: text("llm_rationale"),
  llm_at: text("llm_at"),
  override_function: text("override_function"),
  override_rationale: text("override_rationale"),
  override_by: text("override_by"),
  override_at: text("override_at"),
  source_generation: text("source_generation"),
});

/**
 * The side tables are created with every workspace schema (their DDL lives in
 * `workspace-tables.ts`); this makes sure the current schema has them, once per
 * schema per process.
 */
async function ensureSourceBlocksSchema() {
  await ensureCurrentSchemaTables();
}

/**
 * Source ids (SRC-001…) are reused after a workspace reset, while these side
 * tables survive it. Each side row carries the source's `ingested_at` as its
 * generation; rows from an earlier source with the same id are pruned.
 */
export async function generationOf(source_id: string): Promise<string | null> {
  const [row] = await db().select({ at: t.sources.ingested_at }).from(t.sources).where(eq(t.sources.id, source_id));
  return row?.at ?? null;
}

async function pruneStale(source_id: string): Promise<string | null> {
  await ensureSourceBlocksSchema();
  const gen = await generationOf(source_id);
  if (!gen) return null;
  for (const table of [sourceBlockMeta, sourceDroppedUnits, sourceStakeholderMeta]) {
    await db()
      .delete(table)
      .where(and(eq(table.source_id, source_id), sql`${table.source_generation} IS DISTINCT FROM ${gen}`));
  }
  return gen;
}

type BlockRow = IegpState["blocks"][number];
type MetaRow = typeof sourceBlockMeta.$inferSelect;

export type SourceBlockView = BlockRow & {
  position: number;
  origin: "llm" | "human";
  /** A human made or changed this block; a re-parse keeps it. */
  human: boolean;
  original_text: string | null;
  original_heading: string | null;
  edited_by: string | null;
  edited_at: string | null;
  /** Needs whose quote sits in this block. */
  cited_by: string[];
};

function idOrdinal(id: string): number {
  const match = /-B(\d+)(?:-r\d+)?$/.exec(id);
  return match ? Number(match[1]) : 1_000_000;
}

function metaApplies(meta: MetaRow | undefined, block: BlockRow): boolean {
  return Boolean(meta && !meta.deleted && meta.locked && squashText(meta.current_text) === squashText(block.text));
}

async function requireSourceRow(source_id: string) {
  await ensureSourceBlocksSchema();
  const [row] = await db().select().from(t.sources).where(eq(t.sources.id, source_id));
  if (!row) throw new Error(`Source ${source_id} not found.`);
  return row;
}

async function rawBlocks(source_id: string): Promise<BlockRow[]> {
  return db().select().from(t.sourceBlocks).where(eq(t.sourceBlocks.source_id, source_id));
}

async function metasFor(source_id: string): Promise<MetaRow[]> {
  return db().select().from(sourceBlockMeta).where(eq(sourceBlockMeta.source_id, source_id));
}

type SourceQuote = QuoteDependent & { citationKey: string; block_id: string | null };
type RecordCitationConsolidation = (removedId: string, retainedId: string) => void;

/** Use exact identity for model records and quote-only matching for older records. */
function citesBlock(citation: SourceQuote, block: BlockRow): boolean {
  if (!citation.block_id) return containsQuote(block.text, citation.quote);
  return citation.block_id === block.id && validateQuoteAgainstBlock({ block, quote: citation.quote }).ok;
}

async function quotesFor(source_id: string): Promise<SourceQuote[]> {
  const d = db();
  const tacticNamesSource = or(eq(t.tactics.data_source, t.sources.id), eq(t.tactics.data_source, t.sources.title));
  // Early promotions only saved a primary quote and an edit record. Use the
  // candidate's source ID when it is still available.
  const promotedFromSource = d.select({ id: editRecords.id }).from(editRecords)
    .leftJoin(tacticCandidates, eq(tacticCandidates.id, editRecords.entity_id))
    .where(and(
      tacticPromotionEdit,
      eq(editRecords.after, t.tactics.id),
      or(eq(tacticCandidates.source_id, source_id), and(isNull(tacticCandidates.id), tacticNamesSource)),
    ));
  const [needs, references, gapSuggestions, tacticSuggestionsForSource, legacyTactics] = await Promise.all([
    d.select({ id: t.needs.id, quote: t.needs.source_quote, block_id: t.needs.block_id,
      run_id: t.needs.run_id, source_context: t.needs.source_context })
      .from(t.needs).where(eq(t.needs.source_id, source_id)),
    d.select({ id: tacticSourceReferences.tactic_id, referenceId: tacticSourceReferences.id, quote: tacticSourceReferences.source_quote,
      block_id: tacticSourceReferences.block_id })
      .from(tacticSourceReferences).where(eq(tacticSourceReferences.source_id, source_id)),
    d.select().from(t.gapSuggestions).where(eq(t.gapSuggestions.status, "pending")),
    d.select({ payload: tacticSuggestions.payload, status: tacticSuggestions.status })
      .from(tacticSuggestions).where(eq(tacticSuggestions.source_id, source_id)),
    d.select({ id: t.tactics.id, quote: t.tactics.source_quote, block_id: t.tactics.block_id })
      .from(t.tactics).innerJoin(t.sources, eq(t.sources.id, source_id))
      .where(or(
        and(eq(t.tactics.lifecycle_stage, "extracted"), tacticNamesSource),
        and(eq(t.tactics.lifecycle_stage, "recorded"), exists(promotedFromSource)),
      )),
  ]);
  const pendingGapQuotes = gapSuggestions.flatMap((suggestion) =>
    [suggestion, ...(Array.isArray(suggestion.extra_sources) ? suggestion.extra_sources : [])]
      .map((source, index) => ({
        id: suggestion.id, citationKey: `gap-suggestion:${suggestion.id}:${index}`,
        quote: source.source_quote, block_id: source.block_id ?? null, source_id: source.source_id,
      }))
      .filter((source) => source.source_id === source_id),
  );
  const citations = [
    ...needs.map((need) => ({
      ...need, citationKey: `need:${need.id}`, block_id: need.run_id || need.source_context ? need.block_id : null,
    })),
    ...references.map((reference) => ({ ...reference, citationKey: `tactic-reference:${reference.referenceId}` })),
    ...legacyTactics.map((tactic) => ({ ...tactic, citationKey: `tactic:${tactic.id}` })),
    ...pendingGapQuotes,
    ...tacticSuggestionsForSource.filter(({ status }) => status !== "rejected").map(({ payload }) => {
      const row = payload as TacticSuggestion;
      return { id: row.id, citationKey: `tactic-suggestion:${row.id}`, quote: row.source_quote, block_id: row.block_id ?? null };
    }),
  ].filter((row) => row.quote?.trim());
  return citations;
}

/** Blocks of one source in reading order, with human/model provenance and citing needs. */
export async function listSourceBlocks(source_id: string): Promise<SourceBlockView[]> {
  await ensureSourceBlocksSchema();
  const [blocks, metas, quotes, generation] = await Promise.all([
    rawBlocks(source_id), metasFor(source_id), quotesFor(source_id), generationOf(source_id),
  ]);
  const metaById = new Map(metas.filter((meta) => generation && meta.source_generation === generation)
    .map((meta) => [meta.block_id, meta]));
  return blocks
    .map((block) => {
      const meta = metaById.get(block.id);
      const human = metaApplies(meta, block);
      return {
        ...block,
        position: meta?.position ?? idOrdinal(block.id),
        origin: (human && meta?.origin === "human" ? "human" : "llm") as "llm" | "human",
        human,
        original_text: human ? (meta?.original_text ?? null) : null,
        original_heading: human ? (meta?.original_heading ?? null) : null,
        edited_by: human ? (meta?.edited_by ?? null) : null,
        edited_at: human ? (meta?.edited_at ?? null) : null,
        cited_by: [...new Set(quotes.filter((quote) => citesBlock(quote, block)).map((quote) => quote.id))],
      };
    })
    .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
}

async function upsertMeta(row: typeof sourceBlockMeta.$inferInsert) {
  const withGen = { ...row, source_generation: await generationOf(row.source_id) };
  const rest: Partial<typeof withGen> = { ...withGen };
  delete rest.block_id;
  await db()
    .insert(sourceBlockMeta)
    .values(withGen)
    .onConflictDoUpdate({ target: sourceBlockMeta.block_id, set: rest });
}

/** Record that a human touched `block` (first touch keeps the model's original). */
async function markHuman(args: {
  block: BlockRow;
  current_text: string;
  origin?: "llm" | "human";
  position: number;
  deleted?: boolean;
  actor: Actor;
}) {
  const [existing] = await db().select().from(sourceBlockMeta).where(eq(sourceBlockMeta.block_id, args.block.id));
  const keepOriginal = existing && metaApplies(existing, args.block);
  const origin = keepOriginal ? existing.origin : (args.origin ?? "llm");
  await upsertMeta({
    block_id: args.block.id,
    source_id: args.block.source_id,
    origin,
    locked: true,
    deleted: args.deleted ?? false,
    position: args.position,
    current_text: args.current_text,
    original_text: keepOriginal ? existing.original_text : origin === "llm" ? args.block.text : null,
    original_heading: keepOriginal ? existing.original_heading : origin === "llm" ? args.block.heading : null,
    edited_by: args.actor.name,
    edited_function: args.actor.function,
    edited_at: nowIso(),
  });
}

async function logEdit(args: {
  entity_id: string;
  field: string;
  action: "edit" | "add" | "split" | "override" | "reject";
  before?: string | null;
  after?: string | null;
  rationale: string;
  actor: Actor;
  detail: string;
}) {
  await recordEdit({
    stage: "S1",
    entity_type: "source_block",
    entity_id: args.entity_id,
    field: args.field,
    action: args.action,
    before: args.before ?? null,
    after: args.after ?? null,
    rationale: args.rationale,
    actor: args.actor,
  });
  await appendAudit(args.actor.name, args.actor.function, "source_block", args.entity_id, args.field, `${args.detail} — ${args.rationale}`);
}

export class SourceQuoteConflictError extends Error {
  readonly orphans: QuoteDependent[];
  constructor(orphans: QuoteDependent[]) {
    super(describeOrphans(orphans));
    this.name = "SourceQuoteConflictError";
    this.orphans = orphans;
  }
}

/** Refuses when a need's quote that was in the source would be found in no block afterwards. */
async function guardQuotes(source_id: string, before: SourceBlockView[], afterTexts: string[]) {
  const quotes = (await quotesFor(source_id)).filter((quote) => !quote.block_id && before.some((block) => citesBlock(quote, block)));
  const orphans = orphanedQuotes(quotes, afterTexts);
  if (orphans.length) throw new SourceQuoteConflictError(orphans);
}

async function requireBlock(block_id: string) {
  await ensureSourceBlocksSchema();
  const [row] = await db().select().from(t.sourceBlocks).where(eq(t.sourceBlocks.id, block_id));
  if (!row) throw new Error(`Block ${block_id} not found.`);
  const blocks = await listSourceBlocks(row.source_id);
  const view = blocks.find((b) => b.id === block_id)!;
  return { block: view, blocks };
}

function nextHumanId(source_id: string) {
  return `${source_id}-${newId("H")}`;
}

function positionAfter(blocks: SourceBlockView[], index: number): number {
  const current = blocks[index]!;
  const next = blocks[index + 1];
  return next ? (current.position + next.position) / 2 : current.position + 1;
}

function toBlock(view: SourceBlockView): BlockRow {
  return { id: view.id, source_id: view.source_id, heading: view.heading, text: view.text, location: view.location };
}

/** Keep source edits, provenance logs and affected assessments in the same transaction. */
function assessmentSourceEdit<A extends { source_id?: string; block_id?: string; actor?: Actor }, R>(
  edit: (args: A, recordConsolidation: RecordCitationConsolidation) => Promise<R>,
  preserveSupportingText = false,
): (args: A) => Promise<R> {
  return async (args: A) => {
    await ensureSourceBlocksSchema();
    return withWorkspaceTransaction(async () => {
      const sourceId = args.source_id ?? (args.block_id
        ? (await db().select().from(t.sourceBlocks).where(eq(t.sourceBlocks.id, args.block_id)))[0]?.source_id
        : undefined);
      if (!sourceId) throw new TrustedApplicationError("Source block not found.", "not_found", 404);
      await lockSourceCitationOwner(sourceId);
      const assessmentGapIds = await lockAssessmentOwners({ source_ids: [sourceId] });
      const before = await loadState();
      const quotes = await quotesFor(sourceId);
      const exactCitations = quotes.filter((quote) => quote.block_id && before.blocks.some((block) => citesBlock(quote, block)));
      const consolidated = new Map<string, string>();
      const result = await edit(args, (removedId, retainedId) => {
        consolidated.set(`tactic-reference:${removedId}`, `tactic-reference:${retainedId}`);
      });
      // Resolve citations against the actual post-edit reading order. A retained
      // legacy passage may span newly split blocks, but must still occur verbatim
      // (apart from whitespace); changed or missing support drops the retention.
      const blocks = await listSourceBlocks(sourceId);
      const currentCitations = new Map((await quotesFor(sourceId)).map(quote => [quote.citationKey, quote]));
      const lost = exactCitations.filter(quote => {
        const retainedKey = consolidated.get(quote.citationKey);
        const current = currentCitations.get(retainedKey ?? quote.citationKey);
        return !current?.block_id ||
          (retainedKey ? squashText(current.quote) !== squashText(quote.quote) : current.quote !== quote.quote) ||
          !blocks.some(block => citesBlock(current, block));
      });
      if (lost.length) throw new SourceQuoteConflictError(lost);
      const sourceText = squashText(blocks.map(block => block.text).join(" "));
      for (const need of before.needs.filter(need => need.source_id === sourceId)) {
        if (need.block_id && (need.run_id || need.source_context)) continue;
        const quote = squashText(need.source_quote ?? "");
        // A source edit cannot establish which occurrence a historical need cited.
        if (!need.block_id && (need.observed_block_ids?.length || (quote &&
          blocks.filter(block => containsQuote(block.text.toLowerCase(), quote.toLowerCase())).length > 1))) {
          continue;
        }
        const retained = need.source_basis_text ?? (preserveSupportingText && !quote
          ? before.blocks.find(block => block.id === need.block_id)?.text ?? null : null);
        const support = quote || (retained && sourceText.includes(squashText(retained)) ? squashText(retained) : "");
        let blockId = need.block_id ?? null;
        const currentBlock = blocks.find(block => block.id === blockId);
        if (support && (!currentBlock || !containsQuote(currentBlock.text, support))) {
          const start = sourceText.indexOf(support);
          let offset = 0;
          blockId = blocks.find(block => {
            const end = offset + squashText(block.text).length;
            const containsStart = start >= offset && start < end;
            offset = end + 1;
            return containsStart;
          })?.id ?? null;
        } else if (!currentBlock) blockId = null;
        await db().update(t.needs).set({ block_id: blockId,
          source_basis_text: !quote && support ? retained : null }).where(eq(t.needs.id, need.id));
      }
      await invalidateRelationshipAssessments({ before, gap_ids: assessmentGapIds, reason: "Supporting source passage changed.",
        actor_name: args.actor?.name ?? "Source parser", actor_function: args.actor?.function ?? "evidence_lead" });
      return result;
    });
  };
}

export const editSourceBlock = assessmentSourceEdit(async function editSourceBlock(args: {
  block_id: string;
  text?: string;
  heading?: string;
  location?: string;
  rationale: string;
  actor: Actor;
}) {
  const rationale = requireEditRationale(args.rationale);
  const { block, blocks } = await requireBlock(args.block_id);
  const patch: Partial<Pick<BlockRow, "text" | "heading" | "location">> = {};
  if (args.text !== undefined && args.text.trim() !== block.text) {
    if (!args.text.trim()) throw new TrustedApplicationError("Block text is required.");
    patch.text = args.text.trim();
  }
  if (args.heading !== undefined && args.heading.trim() !== block.heading) patch.heading = args.heading.trim();
  if (args.location !== undefined && args.location.trim() && args.location.trim() !== block.location) {
    patch.location = args.location.trim();
  }
  if (Object.keys(patch).length === 0) throw new TrustedApplicationError("Nothing changed: the block already has these values.");
  if (patch.text !== undefined) {
    await guardQuotes(block.source_id, blocks, blocks.map((b) => (b.id === block.id ? patch.text! : b.text)));
  }
  await db().update(t.sourceBlocks).set(patch).where(eq(t.sourceBlocks.id, block.id));
  await markHuman({ block: toBlock(block), current_text: patch.text ?? block.text, position: block.position, actor: args.actor });
  for (const field of Object.keys(patch) as (keyof typeof patch)[]) {
    await logEdit({
      entity_id: block.id,
      field,
      action: "edit",
      before: block[field],
      after: patch[field] ?? null,
      rationale,
      actor: args.actor,
      detail: `Edited ${field} of ${block.id}`,
    });
  }
  return { ...toBlock(block), ...patch };
});

export const addSourceBlock = assessmentSourceEdit(async function addSourceBlock(args: {
  source_id: string;
  /** Place after this block; `null` = first; omitted = last. */
  after_block_id?: string | null;
  text: string;
  heading?: string;
  location?: string;
  rationale: string;
  actor: Actor;
  /** Audit action label (restore of a dropped unit uses its own). */
  detail?: string;
}) {
  const rationale = requireEditRationale(args.rationale);
  const source = await requireSourceRow(args.source_id);
  const text = args.text.trim();
  if (!text) throw new TrustedApplicationError("Block text is required.");
  const blocks = await listSourceBlocks(args.source_id);
  let position: number;
  if (args.after_block_id === null) position = (blocks[0]?.position ?? 1) - 1;
  else if (args.after_block_id) {
    const at = blocks.findIndex((b) => b.id === args.after_block_id);
    if (at < 0) throw new Error(`Block ${args.after_block_id} is not in ${args.source_id}.`);
    position = positionAfter(blocks, at);
  } else position = (blocks.at(-1)?.position ?? 0) + 1;
  const row: BlockRow = {
    id: nextHumanId(args.source_id),
    source_id: args.source_id,
    heading: args.heading?.trim() || source.title,
    text,
    location: args.location?.trim() || "Added by hand",
  };
  await db().insert(t.sourceBlocks).values(row);
  await markHuman({ block: row, current_text: text, origin: "human", position, actor: args.actor });
  await logEdit({
    entity_id: row.id,
    field: "block",
    action: "add",
    after: text,
    rationale,
    actor: args.actor,
    detail: args.detail ?? `Added block ${row.id} to ${args.source_id}`,
  });
  return row;
});

export const deleteSourceBlock = assessmentSourceEdit(async function deleteSourceBlock(args: { block_id: string; rationale: string; actor: Actor }) {
  const rationale = requireEditRationale(args.rationale);
  const { block, blocks } = await requireBlock(args.block_id);
  await guardQuotes(block.source_id, blocks, blocks.filter((b) => b.id !== block.id).map((b) => b.text));
  await db().delete(t.sourceBlocks).where(eq(t.sourceBlocks.id, block.id));
  // Tombstone: a re-parse will not bring this text back.
  await markHuman({ block: toBlock(block), current_text: block.text, position: block.position, deleted: true, actor: args.actor });
  await logEdit({
    entity_id: block.id,
    field: "block",
    action: "reject",
    before: block.text,
    after: null,
    rationale,
    actor: args.actor,
    detail: `Deleted block ${block.id}`,
  });
  return { deleted: block.id };
});

/** Move citations only when the entire quotation has one destination. */
async function moveSplitOrMergedCitations(
  sourceId: string, original: BlockRow, replacements: BlockRow[], recordConsolidation: RecordCitationConsolidation,
) {
  const movedCitation = (quote: string) => {
    if (!validateQuoteAgainstBlock({ block: original, quote }).ok) return;
    if (replacements.some(block => block.id === original.id && validateQuoteAgainstBlock({ block, quote }).ok)) return;
    const matches = replacements.filter(block => validateQuoteAgainstBlock({ block, quote }).ok);
    if (matches.length !== 1) return;
    const block = matches[0]!;
    return { block_id: block.id, source_context: { heading: block.heading, location: block.location } };
  };
  const d = db();
  const needs = await d.select().from(t.needs).where(and(eq(t.needs.source_id, sourceId), eq(t.needs.block_id, original.id)));
  for (const need of needs) {
    if (!need.source_context && !need.run_id) continue;
    const citation = movedCitation(need.source_quote);
    if (citation) await d.update(t.needs).set(citation).where(eq(t.needs.id, need.id));
  }
  const tactics = await d.select().from(t.tactics).where(eq(t.tactics.block_id, original.id));
  for (const tactic of tactics) {
    const citation = movedCitation(tactic.source_quote ?? "");
    if (citation) await d.update(t.tactics).set(citation).where(eq(t.tactics.id, tactic.id));
  }
  // Edits to different sources can share a suggestion. Lock its current row
  // before reading the array, in the same source-first order as decisions.
  const extraCitation = JSON.stringify([{ source_id: sourceId, block_id: original.id }]);
  const suggestions = await d.select().from(t.gapSuggestions).where(and(
    eq(t.gapSuggestions.status, "pending"),
    or(
      and(eq(t.gapSuggestions.source_id, sourceId), eq(t.gapSuggestions.block_id, original.id)),
      sql`${t.gapSuggestions.extra_sources} @> ${extraCitation}::jsonb`,
    ),
  )).orderBy(t.gapSuggestions.id).for("update");
  for (const suggestion of suggestions) {
    const primary = suggestion.source_id === sourceId && suggestion.block_id === original.id
      ? movedCitation(suggestion.source_quote)
      : undefined;
    const sources = Array.isArray(suggestion.extra_sources) ? suggestion.extra_sources : [];
    let changed = false;
    const extra_sources = sources.map(source => {
      if (source.source_id !== sourceId || source.block_id !== original.id) return source;
      const citation = movedCitation(source.source_quote);
      if (!citation) return source;
      changed = true;
      return { ...source, ...citation };
    });
    if (primary || changed) {
      await d.update(t.gapSuggestions).set({ ...primary, ...(changed ? { extra_sources } : {}) })
        .where(eq(t.gapSuggestions.id, suggestion.id));
    }
  }
  await moveTacticSourceCitations(sourceId, original, replacements, recordConsolidation);
}

export const splitSourceBlock = assessmentSourceEdit(async function splitSourceBlock(args: {
  block_id: string;
  offset?: number;
  at_text?: string;
  rationale: string;
  actor: Actor;
}, recordConsolidation) {
  const rationale = requireEditRationale(args.rationale);
  const { block, blocks } = await requireBlock(args.block_id);
  const [first, second] = splitAtOffset(block.text, resolveSplitOffset(block.text, args));
  await guardQuotes(
    block.source_id,
    blocks,
    blocks.flatMap((b) => (b.id === block.id ? [first, second] : [b.text])),
  );
  const at = blocks.findIndex((b) => b.id === block.id);
  const secondRow: BlockRow = { ...toBlock(block), id: nextHumanId(block.source_id), text: second };
  await db().update(t.sourceBlocks).set({ text: first }).where(eq(t.sourceBlocks.id, block.id));
  await db().insert(t.sourceBlocks).values(secondRow);
  await moveSplitOrMergedCitations(block.source_id, block, [{ ...block, text: first }, secondRow], recordConsolidation);
  await markHuman({ block: toBlock(block), current_text: first, position: block.position, actor: args.actor });
  await markHuman({ block: secondRow, current_text: second, origin: "human", position: positionAfter(blocks, at), actor: args.actor });
  await logEdit({
    entity_id: block.id,
    field: "text",
    action: "split",
    before: block.text,
    after: JSON.stringify({ [block.id]: first, [secondRow.id]: second }),
    rationale,
    actor: args.actor,
    detail: `Split ${block.id} into ${block.id} + ${secondRow.id}`,
  });
  return { first_id: block.id, second_id: secondRow.id };
}, true);

export const mergeSourceBlocks = assessmentSourceEdit(async function mergeSourceBlocks(
  args: { block_id: string; rationale: string; actor: Actor }, recordConsolidation,
) {
  const rationale = requireEditRationale(args.rationale);
  const { block, blocks } = await requireBlock(args.block_id);
  const next = blocks[blocks.findIndex((b) => b.id === block.id) + 1];
  if (!next) throw new TrustedApplicationError("This is the last block: there is nothing after it to merge.");
  const merged = `${block.text}\n\n${next.text}`;
  await db().update(t.sourceBlocks).set({ text: merged }).where(eq(t.sourceBlocks.id, block.id));
  await db().delete(t.sourceBlocks).where(eq(t.sourceBlocks.id, next.id));
  await moveSplitOrMergedCitations(block.source_id, next, [{ ...block, text: merged }], recordConsolidation);
  await markHuman({ block: toBlock(block), current_text: merged, position: block.position, actor: args.actor });
  await markHuman({ block: toBlock(next), current_text: next.text, position: next.position, deleted: true, actor: args.actor });
  await logEdit({
    entity_id: block.id,
    field: "text",
    action: "edit",
    before: JSON.stringify({ [block.id]: block.text, [next.id]: next.text }),
    after: merged,
    rationale,
    actor: args.actor,
    detail: `Merged ${next.id} into ${block.id}`,
  });
  return { block_id: block.id, absorbed_id: next.id, text: merged };
}, true);

/* ------------------------------------------------------------------------- */
/* Dropped noise units                                                         */
/* ------------------------------------------------------------------------- */

export async function listDroppedSourceUnits(source_id: string) {
  await pruneStale(source_id);
  return db().select().from(sourceDroppedUnits).where(eq(sourceDroppedUnits.source_id, source_id));
}

export async function persistDroppedSourceUnits(
  source_id: string,
  units: { location: string; reason: string; text: string; occurrence_id?: string }[],
) {
  const existing = await listDroppedSourceUnits(source_id);
  const source_generation = await generationOf(source_id);
  const stale = existing.filter((row) => !row.restored_block_id).map((row) => row.id);
  if (stale.length) await db().delete(sourceDroppedUnits).where(inArray(sourceDroppedUnits.id, stale));
  const restored = existing.filter((row) => row.restored_block_id);
  const matchedRestored = new Set<string>();
  const created_at = nowIso();
  for (const unit of units) {
    const matchingRestored = restored.find((row) => {
      if (matchedRestored.has(row.id)) return false;
      if (unit.occurrence_id && row.occurrence_id) return row.occurrence_id === unit.occurrence_id;
      return squashText(row.text) === squashText(unit.text);
    });
    if (matchingRestored) {
      matchedRestored.add(matchingRestored.id);
      continue;
    }
    await db().insert(sourceDroppedUnits).values({ id: newId("drop"), source_id, ...unit, restored_block_id: null, created_at, source_generation });
  }
}

export async function restoreDroppedSourceUnit(args: {
  dropped_id: string;
  after_block_id?: string | null;
  heading?: string;
  rationale: string;
  actor: Actor;
}) {
  await ensureSourceBlocksSchema();
  const [found] = await db().select().from(sourceDroppedUnits).where(eq(sourceDroppedUnits.id, args.dropped_id));
  if (found) await pruneStale(found.source_id);
  const [unit] = found
    ? await db().select().from(sourceDroppedUnits).where(eq(sourceDroppedUnits.id, args.dropped_id))
    : [];
  if (!unit) throw new Error(`Dropped unit ${args.dropped_id} not found.`);
  if (unit.restored_block_id) throw new Error(`Already restored as block ${unit.restored_block_id}.`);
  const row = await addSourceBlock({
    source_id: unit.source_id,
    after_block_id: args.after_block_id,
    text: unit.text,
    heading: args.heading,
    location: unit.location,
    rationale: args.rationale,
    actor: args.actor,
    detail: `Restored dropped unit (${unit.location}: ${unit.reason}) as ${unit.source_id} block`,
  });
  await db().update(sourceDroppedUnits).set({ restored_block_id: row.id }).where(eq(sourceDroppedUnits.id, unit.id));
  // The dropped unit's own record: dropped before, restored as this block after (KAN-90).
  await recordEdit({
    stage: "S1",
    entity_type: "source_dropped_unit",
    entity_id: unit.id,
    field: "restored_block_id",
    action: "override",
    before: `dropped: ${unit.reason}`,
    after: row.id,
    rationale: args.rationale,
    actor: args.actor,
  });
  return row;
}

/* ------------------------------------------------------------------------- */
/* Stakeholder function                                                        */
/* ------------------------------------------------------------------------- */

export type SourceStakeholderView = {
  source_id: string;
  /** Effective value on `sources.stakeholder_function`. */
  stakeholder_function: string;
  /** "human" when a person overrode it here; else it is the value chosen at upload. */
  set_by: "human" | "upload";
  llm_function: string | null;
  llm_rationale: string | null;
  override_function: string | null;
  override_rationale: string | null;
  override_by: string | null;
  override_at: string | null;
};

export async function readSourceStakeholder(source_id: string): Promise<SourceStakeholderView> {
  const source = await requireSourceRow(source_id);
  await pruneStale(source_id);
  const [meta] = await db().select().from(sourceStakeholderMeta).where(eq(sourceStakeholderMeta.source_id, source_id));
  return {
    source_id,
    stakeholder_function: source.stakeholder_function,
    set_by: meta?.override_function ? "human" : "upload",
    llm_function: meta?.llm_function ?? null,
    llm_rationale: meta?.llm_rationale ?? null,
    override_function: meta?.override_function ?? null,
    override_rationale: meta?.override_rationale ?? null,
    override_by: meta?.override_by ?? null,
    override_at: meta?.override_at ?? null,
  };
}

/** The parse model's classification and why. Never changes the source's effective function. */
export async function recordLlmSourceStakeholder(args: { source_id: string; stakeholder_function: string; rationale: string }) {
  const source_generation = await pruneStale(args.source_id);
  const at = nowIso();
  await db()
    .insert(sourceStakeholderMeta)
    .values({
      source_id: args.source_id,
      llm_function: args.stakeholder_function,
      llm_rationale: args.rationale,
      llm_at: at,
      source_generation,
    })
    .onConflictDoUpdate({
      target: sourceStakeholderMeta.source_id,
      set: { llm_function: args.stakeholder_function, llm_rationale: args.rationale, llm_at: at },
    });
}

export async function setSourceStakeholder(args: {
  source_id: string;
  stakeholder_function: string;
  rationale: string;
  actor: Actor;
}) {
  const rationale = requireEditRationale(args.rationale);
  if (!(ACTOR_FUNCTIONS as readonly string[]).includes(args.stakeholder_function)) {
    throw new Error(`Unknown stakeholder function "${args.stakeholder_function}".`);
  }
  const before = await readSourceStakeholder(args.source_id);
  const at = nowIso();
  await db().update(t.sources).set({ stakeholder_function: args.stakeholder_function }).where(eq(t.sources.id, args.source_id));
  await db()
    .insert(sourceStakeholderMeta)
    .values({
      source_id: args.source_id,
      override_function: args.stakeholder_function,
      override_rationale: rationale,
      override_by: args.actor.name,
      override_at: at,
      source_generation: await generationOf(args.source_id),
    })
    .onConflictDoUpdate({
      target: sourceStakeholderMeta.source_id,
      set: {
        override_function: args.stakeholder_function,
        override_rationale: rationale,
        override_by: args.actor.name,
        override_at: at,
      },
    });
  await recordEdit({
    stage: "S1",
    entity_type: "source",
    entity_id: args.source_id,
    field: "stakeholder_function",
    action: "override",
    before: before.stakeholder_function,
    after: args.stakeholder_function,
    rationale,
    actor: args.actor,
  });
  await appendAudit(
    args.actor.name,
    args.actor.function,
    "source",
    args.source_id,
    "stakeholder_function",
    `${before.stakeholder_function} → ${args.stakeholder_function} — ${rationale}`,
  );
  return readSourceStakeholder(args.source_id);
}

/* ------------------------------------------------------------------------- */
/* Manual entry (no AI) and re-parse                                           */
/* ------------------------------------------------------------------------- */

/** A source typed or pasted by a person, stored as the blocks they confirmed. No LLM runs. */
export async function createManualSource(args: {
  title: string;
  source_type: string;
  stakeholder_function: string;
  blocks: { text: string; heading?: string }[];
  rationale: string;
  actor: Actor;
}) {
  const rationale = requireEditRationale(args.rationale);
  const title = args.title.trim();
  if (!title) throw new TrustedApplicationError("A title is required.");
  if (!(SOURCE_TYPES as readonly string[]).includes(args.source_type)) {
    throw new Error(`Unknown source type "${args.source_type}".`);
  }
  if (!(ACTOR_FUNCTIONS as readonly string[]).includes(args.stakeholder_function)) {
    throw new Error(`Unknown stakeholder function "${args.stakeholder_function}".`);
  }
  const blocks = args.blocks.map((b) => ({ text: b.text.trim(), heading: b.heading?.trim() || title })).filter((b) => b.text);
  if (blocks.length === 0) throw new TrustedApplicationError("Add at least one block of text.");
  await ensureSourceBlocksSchema();
  const created = await persistSourceAndBlocks({
    title,
    source_type: args.source_type as SourceType,
    stakeholder_function: args.stakeholder_function as ActorFunction,
    text: blocks.map((b) => b.text).join("\n\n"),
    filename: `${title.replaceAll(/\s+/g, "_")}.typed.txt`,
    sections: blocks.map((b) => ({ heading: b.heading, text: b.text, location: "Typed by hand" })),
  });
  const source_generation = await pruneStale(created.source_id);
  for (const [index, block] of created.blocks.entries()) {
    await markHuman({ block, current_text: block.text, origin: "human", position: index + 1, actor: args.actor });
  }
  await db()
    .insert(sourceStakeholderMeta)
    .values({
      source_id: created.source_id,
      override_function: args.stakeholder_function,
      override_rationale: rationale,
      override_by: args.actor.name,
      override_at: nowIso(),
      source_generation,
    })
    .onConflictDoNothing();
  await recordEdit({
    stage: "S1",
    entity_type: "source",
    entity_id: created.source_id,
    field: "blocks",
    action: "add",
    after: `${created.blocks.length} human-entered block(s)`,
    rationale,
    actor: args.actor,
  });
  await appendAudit(
    args.actor.name,
    args.actor.function,
    "source",
    created.source_id,
    "manual_source",
    `Typed source "${title}" with ${created.blocks.length} human-entered block(s) — ${rationale}`,
  );
  return created;
}

export type ReparseResult = {
  source_id: string;
  blocks: BlockRow[];
  inserted: number;
  kept_human: number;
  kept_cited: number;
  skipped_duplicates: number;
};

/**
 * Re-parse into an existing source. Human blocks (locked meta) stay exactly as
 * they are. Model blocks cited by needs, source reviews, gap and tactic
 * suggestions, or tactic source references keep their IDs and text. New model
 * blocks are skipped when their text is already covered by a kept block, the
 * original text of a human edit, or a human deletion.
 */
export const reparseSourceBlocks = assessmentSourceEdit(async function reparseSourceBlocks(args: {
  source_id: string;
  sections: { heading: string; text: string; location: string; split_unit?: { index: number; text: string } }[];
}): Promise<ReparseResult> {
  await requireSourceRow(args.source_id);
  await pruneStale(args.source_id);
  const current = await listSourceBlocks(args.source_id);
  const metas = await metasFor(args.source_id);
  const quotes = await quotesFor(args.source_id);
  const state = await loadState();
  const citedBlockIds = new Set(state.source_reviews
    ?.filter(review => review.source_id === args.source_id)
    .map(review => review.block_id));
  const tacticCitations = await db().select({
    blockId: sql<string | null>`${tacticSuggestions.payload}->>'block_id'`,
    quote: sql<string | null>`${tacticSuggestions.payload}->>'source_quote'`,
  }).from(tacticSuggestions).where(eq(tacticSuggestions.source_id, args.source_id))
    .unionAll(db().select({
      blockId: tacticSourceReferences.block_id,
      quote: tacticSourceReferences.source_quote,
    }).from(tacticSourceReferences).where(eq(tacticSourceReferences.source_id, args.source_id)));
  const gapCitations = state.gap_suggestions
    .flatMap(suggestion => [suggestion, ...suggestion.extra_sources])
    .filter(citation => citation.source_id === args.source_id)
    .map(citation => ({ blockId: citation.block_id, quote: citation.source_quote }));
  const blocksById = new Map(current.map(block => [block.id, block]));
  for (const { blockId, quote } of [...tacticCitations, ...gapCitations]) {
    const block = blockId ? blocksById.get(blockId) : undefined;
    // Older reparses may have reused a block ID for an unrelated passage.
    if (block && quote?.trim() && containsQuote(block.text.toLowerCase(), quote.toLowerCase())) {
      citedBlockIds.add(block.id);
    }
  }
  const kept: SourceBlockView[] = [];
  const replaced: string[] = [];
  let kept_human = 0;
  let kept_cited = 0;
  for (const block of current) {
    if (block.human) {
      kept.push(block);
      kept_human += 1;
    } else if (quotes.some((quote) => citesBlock(quote, block)) || citedBlockIds.has(block.id)) {
      kept.push(block);
      kept_cited += 1;
    } else replaced.push(block.id);
  }
  if (replaced.length) {
    await db().delete(t.sourceBlocks).where(and(eq(t.sourceBlocks.source_id, args.source_id), inArray(t.sourceBlocks.id, replaced)));
    await db().delete(sourceBlockMeta).where(and(inArray(sourceBlockMeta.block_id, replaced), eq(sourceBlockMeta.locked, false)));
  }
  const covered = new Map<string, number>();
  const cover = (text: string) => {
    const key = squashText(text);
    covered.set(key, (covered.get(key) ?? 0) + 1);
  };
  kept.forEach((block) => cover(block.text));
  for (const meta of metas) {
    if (!meta.locked) continue;
    if (meta.original_text && squashText(meta.original_text) !== squashText(meta.current_text)) cover(meta.original_text);
    if (meta.deleted) cover(meta.current_text);
  }
  // Reconcile a legacy whole block before checking individual new slices.
  // Consume its text once per raw occurrence, even when the model dropped part of it.
  const matchedSplitUnits = new Map<number, boolean>();
  for (const { split_unit } of args.sections) {
    if (!split_unit || matchedSplitUnits.has(split_unit.index)) continue;
    const key = squashText(split_unit.text);
    const remaining = covered.get(key) ?? 0;
    matchedSplitUnits.set(split_unit.index, remaining > 0);
    if (remaining > 0) covered.set(key, remaining - 1);
  }
  const usedIds = new Set([...kept.map((b) => b.id), ...metas.map((m) => m.block_id)]);
  let ordinal = Math.max(0, ...[...usedIds].map(idOrdinal).filter((n) => n < 1_000_000));
  let skipped_duplicates = 0;
  let inserted = 0;
  for (const [index, section] of args.sections.entries()) {
    if (!section.text.trim()) continue;
    if (section.split_unit && matchedSplitUnits.get(section.split_unit.index)) {
      skipped_duplicates += 1;
      continue;
    }
    const key = squashText(section.text);
    const remaining = covered.get(key) ?? 0;
    if (remaining > 0) {
      covered.set(key, remaining - 1);
      skipped_duplicates += 1;
      continue;
    }
    ordinal += 1;
    const row: BlockRow = {
      id: `${args.source_id}-B${String(ordinal).padStart(2, "0")}`,
      source_id: args.source_id,
      heading: section.heading,
      text: section.text,
      location: section.location,
    };
    await db().insert(t.sourceBlocks).values(row);
    // Position follows the new parse's order; kept blocks hold theirs.
    await upsertMeta({ block_id: row.id, source_id: row.source_id, origin: "llm", locked: false, position: index + 1, current_text: row.text });
    inserted += 1;
  }
  return {
    source_id: args.source_id,
    blocks: (await listSourceBlocks(args.source_id)).map(toBlock),
    inserted,
    kept_human,
    kept_cited,
    skipped_duplicates,
  };
});
