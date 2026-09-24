import { and, eq, inArray, sql } from "drizzle-orm";
import { boolean, doublePrecision, pgTable, text } from "drizzle-orm/pg-core";
import { db, ensureSchema } from "./db";
import * as t from "./schema";
import { ACTOR_FUNCTIONS, SOURCE_TYPES, type ActorFunction, type SourceType } from "./enums";
import { appendAudit, persistSourceAndBlocks } from "./store";
import type { IegpState } from "./types";
import { recordEdit } from "@/modules/kernel/edit-records";
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
 * Provenance policy: needs quote their source (`needs.source_quote`). A change
 * that would leave a quote with no block of that source containing it is
 * refused, naming the needs. Merges keep both texts, so they never orphan one.
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

const SOURCE_BLOCKS_DDL = [
  `CREATE TABLE IF NOT EXISTS source_block_meta (
    block_id text PRIMARY KEY, source_id text NOT NULL, origin text NOT NULL,
    locked boolean NOT NULL DEFAULT false, deleted boolean NOT NULL DEFAULT false,
    position double precision, current_text text NOT NULL,
    original_text text, original_heading text,
    edited_by text, edited_function text, edited_at text
  )`,
  `CREATE TABLE IF NOT EXISTS source_dropped_units (
    id text PRIMARY KEY, source_id text NOT NULL, location text NOT NULL,
    reason text NOT NULL, text text NOT NULL, restored_block_id text, created_at text NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS source_stakeholder_meta (
    source_id text PRIMARY KEY, llm_function text, llm_rationale text, llm_at text,
    override_function text, override_rationale text, override_by text, override_at text
  )`,
];

const SOURCE_BLOCKS_MIGRATIONS = [
  "ALTER TABLE source_block_meta ADD COLUMN IF NOT EXISTS source_generation text",
  "ALTER TABLE source_dropped_units ADD COLUMN IF NOT EXISTS source_generation text",
  "ALTER TABLE source_stakeholder_meta ADD COLUMN IF NOT EXISTS source_generation text",
];

const globalSourceBlocks = globalThis as unknown as { sourceBlocksSchema?: Promise<void> };

async function ensureSourceBlocksSchema() {
  await ensureSchema();
  if (!globalSourceBlocks.sourceBlocksSchema) {
    globalSourceBlocks.sourceBlocksSchema = (async () => {
      for (const stmt of [...SOURCE_BLOCKS_DDL, ...SOURCE_BLOCKS_MIGRATIONS]) await db().execute(sql.raw(stmt));
    })();
  }
  await globalSourceBlocks.sourceBlocksSchema;
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

async function quotesFor(source_id: string): Promise<QuoteDependent[]> {
  const rows = await db()
    .select({ id: t.needs.id, quote: t.needs.source_quote })
    .from(t.needs)
    .where(eq(t.needs.source_id, source_id));
  return rows.filter((row) => row.quote.trim());
}

/** Blocks of one source in reading order, with human/model provenance and citing needs. */
export async function listSourceBlocks(source_id: string): Promise<SourceBlockView[]> {
  await pruneStale(source_id);
  const [blocks, metas, quotes] = await Promise.all([rawBlocks(source_id), metasFor(source_id), quotesFor(source_id)]);
  const metaById = new Map(metas.map((m) => [m.block_id, m]));
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
        cited_by: quotes.filter((q) => containsQuote(block.text, q.quote)).map((q) => q.id),
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
  const quotes = (await quotesFor(source_id)).filter((q) => before.some((b) => containsQuote(b.text, q.quote)));
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

export async function editSourceBlock(args: {
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
    if (!args.text.trim()) throw new Error("Block text is required.");
    patch.text = args.text.trim();
  }
  if (args.heading !== undefined && args.heading.trim() !== block.heading) patch.heading = args.heading.trim();
  if (args.location !== undefined && args.location.trim() && args.location.trim() !== block.location) {
    patch.location = args.location.trim();
  }
  if (Object.keys(patch).length === 0) throw new Error("Nothing changed: the block already has these values.");
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
}

export async function addSourceBlock(args: {
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
  if (!text) throw new Error("Block text is required.");
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
}

export async function deleteSourceBlock(args: { block_id: string; rationale: string; actor: Actor }) {
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
}

export async function splitSourceBlock(args: {
  block_id: string;
  offset?: number;
  at_text?: string;
  rationale: string;
  actor: Actor;
}) {
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
}

export async function mergeSourceBlocks(args: { block_id: string; rationale: string; actor: Actor }) {
  const rationale = requireEditRationale(args.rationale);
  const { block, blocks } = await requireBlock(args.block_id);
  const next = blocks[blocks.findIndex((b) => b.id === block.id) + 1];
  if (!next) throw new Error("This is the last block: there is nothing after it to merge.");
  const merged = `${block.text}\n\n${next.text}`;
  await db().update(t.sourceBlocks).set({ text: merged }).where(eq(t.sourceBlocks.id, block.id));
  await db().delete(t.sourceBlocks).where(eq(t.sourceBlocks.id, next.id));
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
}

/* ------------------------------------------------------------------------- */
/* Dropped noise units                                                         */
/* ------------------------------------------------------------------------- */

export async function listDroppedSourceUnits(source_id: string) {
  await pruneStale(source_id);
  return db().select().from(sourceDroppedUnits).where(eq(sourceDroppedUnits.source_id, source_id));
}

export async function persistDroppedSourceUnits(
  source_id: string,
  units: { location: string; reason: string; text: string }[],
) {
  const existing = await listDroppedSourceUnits(source_id);
  const source_generation = await generationOf(source_id);
  const stale = existing.filter((row) => !row.restored_block_id).map((row) => row.id);
  if (stale.length) await db().delete(sourceDroppedUnits).where(inArray(sourceDroppedUnits.id, stale));
  const restored = new Set(existing.filter((row) => row.restored_block_id).map((row) => squashText(row.text)));
  const created_at = nowIso();
  for (const unit of units) {
    if (restored.has(squashText(unit.text))) continue;
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
  if (!title) throw new Error("A title is required.");
  if (!(SOURCE_TYPES as readonly string[]).includes(args.source_type)) {
    throw new Error(`Unknown source type "${args.source_type}".`);
  }
  if (!(ACTOR_FUNCTIONS as readonly string[]).includes(args.stakeholder_function)) {
    throw new Error(`Unknown stakeholder function "${args.stakeholder_function}".`);
  }
  const blocks = args.blocks.map((b) => ({ text: b.text.trim(), heading: b.heading?.trim() || title })).filter((b) => b.text);
  if (blocks.length === 0) throw new Error("Add at least one block of text.");
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
 * they are; model blocks that a need quotes stay so no quote breaks; every
 * other model block is replaced. New model blocks whose text a kept block, a
 * human edit's original, or a human deletion already covers are skipped.
 */
export async function reparseSourceBlocks(args: {
  source_id: string;
  sections: { heading: string; text: string; location: string }[];
}): Promise<ReparseResult> {
  await requireSourceRow(args.source_id);
  const current = await listSourceBlocks(args.source_id);
  const metas = await metasFor(args.source_id);
  const quotes = await quotesFor(args.source_id);
  const kept: SourceBlockView[] = [];
  const replaced: string[] = [];
  let kept_human = 0;
  let kept_cited = 0;
  for (const block of current) {
    if (block.human) {
      kept.push(block);
      kept_human += 1;
    } else if (quotes.some((q) => containsQuote(block.text, q.quote))) {
      kept.push(block);
      kept_cited += 1;
    } else replaced.push(block.id);
  }
  if (replaced.length) {
    await db().delete(t.sourceBlocks).where(and(eq(t.sourceBlocks.source_id, args.source_id), inArray(t.sourceBlocks.id, replaced)));
    await db().delete(sourceBlockMeta).where(and(inArray(sourceBlockMeta.block_id, replaced), eq(sourceBlockMeta.locked, false)));
  }
  const covered = new Set<string>(kept.map((b) => squashText(b.text)));
  for (const meta of metas) {
    if (!meta.locked) continue;
    if (meta.original_text) covered.add(squashText(meta.original_text));
    if (meta.deleted) covered.add(squashText(meta.current_text));
  }
  const usedIds = new Set([...kept.map((b) => b.id), ...metas.map((m) => m.block_id)]);
  let ordinal = Math.max(0, ...[...usedIds].map(idOrdinal).filter((n) => n < 1_000_000));
  let skipped_duplicates = 0;
  let inserted = 0;
  for (const [index, section] of args.sections.entries()) {
    if (!section.text.trim()) continue;
    if (covered.has(squashText(section.text))) {
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
}
