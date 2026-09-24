import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { boolean, pgTable, text } from "drizzle-orm/pg-core";
import { accuracyDb, ensureAccuracySchema } from "./db";
import * as t from "./schema";
import { newId, nowIso } from "@/modules/kernel/ids";
import type { ParseBlock } from "./quote-validator";
import { insertSourceFile } from "./source-store";
import {
  describeOrphans,
  orphanedQuotes,
  requireEditRationale,
  resolveSplitOffset,
  splitAtOffset,
  squashText,
  type QuoteDependent,
} from "@/lib/ingest/manual-blocks";
import { STAKEHOLDER_FUNCTIONS, type StakeholderFunction } from "@/lib/schema";

/* ------------------------------------------------------------------------- */
/* Human-edit side tables (owned by the parse store, created on first use).  */
/* ------------------------------------------------------------------------- */

/**
 * One row per parse block a human touched or created. `origin` says who made
 * the block; `locked` blocks are never replaced or removed by a re-parse.
 * `deleted` rows are tombstones: a re-parse will not bring that text back.
 */
export const accuracyParseBlockMeta = pgTable("accuracy_parse_block_meta", {
  block_id: text("block_id").primaryKey(),
  workspace_id: text("workspace_id").notNull(),
  source_file_id: text("source_file_id").notNull(),
  origin: text("origin").notNull(),
  locked: boolean("locked").notNull().default(true),
  deleted: boolean("deleted").notNull().default(false),
  current_text: text("current_text").notNull(),
  original_text: text("original_text"),
  original_kind: text("original_kind"),
  original_heading: text("original_heading"),
  edited_by: text("edited_by").notNull(),
  edited_function: text("edited_function").notNull(),
  edited_at: text("edited_at").notNull(),
});

/** Audit trail for every human change to a parse block or its source's classification. */
export const accuracyParseBlockEdits = pgTable("accuracy_parse_block_edits", {
  id: text("id").primaryKey(),
  workspace_id: text("workspace_id").notNull(),
  source_file_id: text("source_file_id").notNull(),
  block_id: text("block_id"),
  action: text("action").notNull(),
  field: text("field").notNull(),
  before: text("before"),
  after: text("after"),
  rationale: text("rationale").notNull(),
  actor_name: text("actor_name").notNull(),
  actor_function: text("actor_function").notNull(),
  at: text("at").notNull(),
});

/** Units the parse LLM dropped as noise, verbatim, so a human can restore one. */
export const accuracyParseDropped = pgTable("accuracy_parse_dropped", {
  id: text("id").primaryKey(),
  workspace_id: text("workspace_id").notNull(),
  source_file_id: text("source_file_id").notNull(),
  location: text("location").notNull(),
  reason: text("reason").notNull(),
  text: text("text").notNull(),
  restored_block_id: text("restored_block_id"),
  created_at: text("created_at").notNull(),
});

/** The LLM's stakeholder classification (with its rationale) and any human override. */
export const accuracySourceStakeholder = pgTable("accuracy_source_stakeholder", {
  source_file_id: text("source_file_id").primaryKey(),
  workspace_id: text("workspace_id").notNull(),
  llm_function: text("llm_function"),
  llm_rationale: text("llm_rationale"),
  llm_at: text("llm_at"),
  override_function: text("override_function"),
  override_rationale: text("override_rationale"),
  override_by: text("override_by"),
  override_at: text("override_at"),
});

const PARSE_EDIT_DDL = [
  `CREATE TABLE IF NOT EXISTS accuracy_parse_block_meta (
    block_id text PRIMARY KEY,
    workspace_id text NOT NULL,
    source_file_id text NOT NULL,
    origin text NOT NULL,
    locked boolean NOT NULL DEFAULT true,
    deleted boolean NOT NULL DEFAULT false,
    current_text text NOT NULL,
    original_text text,
    original_kind text,
    original_heading text,
    edited_by text NOT NULL,
    edited_function text NOT NULL,
    edited_at text NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS accuracy_parse_block_edits (
    id text PRIMARY KEY,
    workspace_id text NOT NULL,
    source_file_id text NOT NULL,
    block_id text,
    action text NOT NULL,
    field text NOT NULL,
    before text,
    after text,
    rationale text NOT NULL,
    actor_name text NOT NULL,
    actor_function text NOT NULL,
    at text NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS accuracy_parse_dropped (
    id text PRIMARY KEY,
    workspace_id text NOT NULL,
    source_file_id text NOT NULL,
    location text NOT NULL,
    reason text NOT NULL,
    text text NOT NULL,
    restored_block_id text,
    created_at text NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS accuracy_source_stakeholder (
    source_file_id text PRIMARY KEY,
    workspace_id text NOT NULL,
    llm_function text,
    llm_rationale text,
    llm_at text,
    override_function text,
    override_rationale text,
    override_by text,
    override_at text
  )`,
];

const globalParseStore = globalThis as unknown as { accuracyParseEditSchema?: Promise<void> };

async function ensureParseSchema() {
  await ensureAccuracySchema();
  if (!globalParseStore.accuracyParseEditSchema) {
    globalParseStore.accuracyParseEditSchema = (async () => {
      const d = accuracyDb();
      for (const stmt of PARSE_EDIT_DDL) await d.execute(sql.raw(stmt));
    })();
  }
  await globalParseStore.accuracyParseEditSchema;
}

export type ParseEditActor = { name: string; function: string };

export const PARSE_BLOCK_KINDS = ["prose", "table_row", "list_item", "heading", "caption", "other"] as const;

function requireKind(kind: string): ParseBlock["kind"] {
  if (!(PARSE_BLOCK_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`Unknown block kind "${kind}". Use one of ${PARSE_BLOCK_KINDS.join(", ")}.`);
  }
  return kind as ParseBlock["kind"];
}

function requireText(text: string | undefined | null): string {
  const trimmed = (text ?? "").trim();
  if (!trimmed) throw new Error("Block text is required.");
  return trimmed;
}

function normHeading(heading: string | null | undefined): string | null {
  const trimmed = (heading ?? "").trim();
  return trimmed ? trimmed : null;
}

type BlockRow = typeof t.accuracyParseBlocks.$inferSelect;
type MetaRow = typeof accuracyParseBlockMeta.$inferSelect;

/* ------------------------------------------------------------------------- */
/* Persist (parse module) — re-parse keeps human blocks.                     */
/* ------------------------------------------------------------------------- */

export type PersistParseBlocksResult = {
  inserted: number;
  /** Human-made or human-edited blocks a re-parse kept untouched. */
  kept_human: number;
  /** Model blocks a re-parse kept because a claim cites them. */
  kept_cited: number;
  /** Model blocks skipped because a kept block or a human deletion already covers their text. */
  skipped_duplicates: number;
};

/**
 * Stores the parse LLM's blocks for a source. On the first parse this is a
 * plain insert. On a re-parse of the same source:
 * - blocks a human created or edited (meta `locked`) are kept as they are;
 * - model blocks that a claim's provenance cites are kept, so no quote breaks;
 * - every other model block is replaced by the new parse;
 * - a new block whose text equals a kept block, or a block a human deleted,
 *   is not inserted (a human deletion survives the re-run).
 * Returns the number of blocks inserted by this call.
 */
export async function persistParseBlocks(args: {
  workspace_id: string;
  source_file_id: string;
  parser: string;
  blocks: Omit<ParseBlock, "workspace_id">[];
}): Promise<number> {
  return (await persistParseBlocksDetailed(args)).inserted;
}

export async function persistParseBlocksDetailed(args: {
  workspace_id: string;
  source_file_id: string;
  parser: string;
  blocks: Omit<ParseBlock, "workspace_id">[];
}): Promise<PersistParseBlocksResult> {
  await ensureParseSchema();
  const db = accuracyDb();
  const created_at = nowIso();
  const existing = await readParseBlocks(args.workspace_id, args.source_file_id);
  const metas = await readMetaForSource(args.workspace_id, args.source_file_id);
  const metaById = new Map(metas.map((m) => [m.block_id, m]));

  if (existing.length === 0 && metas.length === 0) {
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
    return { inserted: args.blocks.length, kept_human: 0, kept_cited: 0, skipped_duplicates: 0 };
  }

  const cited = new Set(
    (await dependentsFor(args.workspace_id, existing.map((b) => b.id))).map((d) => d.block_id),
  );
  const kept: BlockRow[] = [];
  const replaced: string[] = [];
  let kept_human = 0;
  let kept_cited = 0;
  for (const block of existing) {
    const meta = metaById.get(block.id);
    if (meta?.locked) {
      kept.push(block);
      kept_human += 1;
    } else if (cited.has(block.id)) {
      kept.push(block);
      kept_cited += 1;
    } else {
      replaced.push(block.id);
    }
  }
  if (replaced.length) {
    await db
      .delete(t.accuracyParseBlocks)
      .where(and(eq(t.accuracyParseBlocks.workspace_id, args.workspace_id), inArray(t.accuracyParseBlocks.id, replaced)));
  }

  const coveredTexts = new Set<string>();
  for (const block of kept) coveredTexts.add(squashText(block.text));
  for (const meta of metas) {
    if (meta.original_text) coveredTexts.add(squashText(meta.original_text));
    if (meta.deleted) coveredTexts.add(squashText(meta.current_text));
  }
  const usedIds = new Set([...kept.map((b) => b.id), ...metas.map((m) => m.block_id)]);
  let skipped_duplicates = 0;
  const fresh: { id: string; index: number; block: Omit<ParseBlock, "workspace_id"> }[] = [];
  for (const block of args.blocks) {
    if (coveredTexts.has(squashText(block.text))) {
      skipped_duplicates += 1;
      continue;
    }
    let id = block.id;
    for (let n = 2; usedIds.has(id); n += 1) id = `${block.id}-r${n}`;
    usedIds.add(id);
    fresh.push({ id, index: block.index, block });
  }
  for (const entry of fresh) {
    await db.insert(t.accuracyParseBlocks).values({
      id: entry.id,
      workspace_id: args.workspace_id,
      source_file_id: args.source_file_id,
      // Placed by the new parse's position; kept blocks hold theirs. Renumbered below.
      index: entry.index,
      kind: entry.block.kind,
      heading: entry.block.heading,
      text: entry.block.text,
      parser: args.parser,
      created_at,
    });
  }
  await renumber(args.workspace_id, args.source_file_id, new Set(kept.map((b) => b.id)));
  return { inserted: fresh.length, kept_human, kept_cited, skipped_duplicates };
}

/** Rewrites indices 0..n-1 in current order; on ties kept (human/cited) blocks come first. */
async function renumber(workspace_id: string, source_file_id: string, preferred: Set<string> = new Set()) {
  const rows = await readParseBlocks(workspace_id, source_file_id);
  const ordered = [...rows].sort(
    (a, b) => a.index - b.index || Number(preferred.has(b.id)) - Number(preferred.has(a.id)),
  );
  const db = accuracyDb();
  for (const [index, row] of ordered.entries()) {
    if (row.index !== index) {
      await db.update(t.accuracyParseBlocks).set({ index }).where(eq(t.accuracyParseBlocks.id, row.id));
    }
  }
}

/* ------------------------------------------------------------------------- */
/* Reads                                                                      */
/* ------------------------------------------------------------------------- */

export async function readParseBlocks(workspace_id: string, source_file_id: string) {
  await ensureAccuracySchema();
  return accuracyDb()
    .select()
    .from(t.accuracyParseBlocks)
    .where(
      and(
        eq(t.accuracyParseBlocks.workspace_id, workspace_id),
        eq(t.accuracyParseBlocks.source_file_id, source_file_id),
      ),
    )
    .orderBy(asc(t.accuracyParseBlocks.index));
}

/** All parse blocks for a workspace (completeness audit / review inbox). */
export async function readAllParseBlocks(workspace_id: string) {
  await ensureAccuracySchema();
  return accuracyDb()
    .select()
    .from(t.accuracyParseBlocks)
    .where(eq(t.accuracyParseBlocks.workspace_id, workspace_id));
}

/** Resolve parse blocks by id within a workspace (order follows block_ids). */
export async function readParseBlocksByIds(workspace_id: string, block_ids: string[]) {
  if (block_ids.length === 0) return [];
  await ensureAccuracySchema();
  const rows = await accuracyDb()
    .select()
    .from(t.accuracyParseBlocks)
    .where(eq(t.accuracyParseBlocks.workspace_id, workspace_id));
  const byId = new Map(rows.map((row) => [row.id, row]));
  return block_ids.flatMap((id) => {
    const row = byId.get(id);
    return row ? [row] : [];
  });
}

async function readMetaForSource(workspace_id: string, source_file_id: string): Promise<MetaRow[]> {
  await ensureParseSchema();
  return accuracyDb()
    .select()
    .from(accuracyParseBlockMeta)
    .where(
      and(
        eq(accuracyParseBlockMeta.workspace_id, workspace_id),
        eq(accuracyParseBlockMeta.source_file_id, source_file_id),
      ),
    );
}

export type BlockProvenanceMeta = {
  /** "llm" = produced by the parse model; "human" = typed, added or restored by a person. */
  origin: "llm" | "human";
  /** A human made or changed this block; a re-parse keeps it. */
  human: boolean;
  locked: boolean;
  original_text: string | null;
  original_kind: string | null;
  original_heading: string | null;
  edited_by: string | null;
  edited_at: string | null;
  /** Claims whose provenance quotes this block. */
  cited_by: string[];
};

/** Blocks with who-made-it metadata and their citing claims, for the edit UI. */
export async function readParseBlocksWithMeta(workspace_id: string, source_file_id: string) {
  await ensureParseSchema();
  const blocks = await readParseBlocks(workspace_id, source_file_id);
  const metas = new Map((await readMetaForSource(workspace_id, source_file_id)).map((m) => [m.block_id, m]));
  const deps = await dependentsFor(workspace_id, blocks.map((b) => b.id));
  return blocks.map((block) => {
    const meta = metas.get(block.id);
    const provenance: BlockProvenanceMeta = {
      origin: meta?.origin === "human" ? "human" : "llm",
      human: Boolean(meta?.locked),
      locked: Boolean(meta?.locked),
      original_text: meta?.original_text ?? null,
      original_kind: meta?.original_kind ?? null,
      original_heading: meta?.original_heading ?? null,
      edited_by: meta?.edited_by ?? null,
      edited_at: meta?.edited_at ?? null,
      cited_by: [...new Set(deps.filter((d) => d.block_id === block.id).map((d) => d.id))],
    };
    return { ...block, provenance };
  });
}

export async function listParseBlockEdits(workspace_id: string, source_file_id: string) {
  await ensureParseSchema();
  return accuracyDb()
    .select()
    .from(accuracyParseBlockEdits)
    .where(
      and(
        eq(accuracyParseBlockEdits.workspace_id, workspace_id),
        eq(accuracyParseBlockEdits.source_file_id, source_file_id),
      ),
    )
    .orderBy(desc(accuracyParseBlockEdits.at));
}

export async function listDroppedUnits(workspace_id: string, source_file_id: string) {
  await ensureParseSchema();
  return accuracyDb()
    .select()
    .from(accuracyParseDropped)
    .where(
      and(eq(accuracyParseDropped.workspace_id, workspace_id), eq(accuracyParseDropped.source_file_id, source_file_id)),
    )
    .orderBy(asc(accuracyParseDropped.created_at), asc(accuracyParseDropped.location));
}

/** Claim provenance rows quoting any of these blocks. */
async function dependentsFor(
  workspace_id: string,
  block_ids: string[],
): Promise<(QuoteDependent & { block_id: string; provenance_id: string })[]> {
  if (block_ids.length === 0) return [];
  const rows = await accuracyDb()
    .select()
    .from(t.accuracyProvenance)
    .where(and(eq(t.accuracyProvenance.workspace_id, workspace_id), inArray(t.accuracyProvenance.block_id, block_ids)));
  return rows.map((row) => ({ id: row.claim_id, quote: row.quote, block_id: row.block_id, provenance_id: row.id }));
}

/* ------------------------------------------------------------------------- */
/* Human edits                                                                */
/* ------------------------------------------------------------------------- */

async function audit(args: {
  workspace_id: string;
  source_file_id: string;
  block_id: string | null;
  action: string;
  field: string;
  before?: string | null;
  after?: string | null;
  rationale: string;
  actor: ParseEditActor;
}) {
  await accuracyDb().insert(accuracyParseBlockEdits).values({
    id: newId("pbe"),
    workspace_id: args.workspace_id,
    source_file_id: args.source_file_id,
    block_id: args.block_id,
    action: args.action,
    field: args.field,
    before: args.before ?? null,
    after: args.after ?? null,
    rationale: args.rationale,
    actor_name: args.actor.name,
    actor_function: args.actor.function,
    at: nowIso(),
  });
}

/** Upserts the human meta row; the first touch records the model's original. */
async function markHuman(args: {
  block: Pick<BlockRow, "id" | "workspace_id" | "source_file_id" | "text" | "kind" | "heading">;
  current_text: string;
  origin?: "llm" | "human";
  deleted?: boolean;
  actor: ParseEditActor;
}) {
  const db = accuracyDb();
  const [meta] = await db
    .select()
    .from(accuracyParseBlockMeta)
    .where(eq(accuracyParseBlockMeta.block_id, args.block.id));
  const at = nowIso();
  if (meta) {
    await db
      .update(accuracyParseBlockMeta)
      .set({
        locked: true,
        deleted: args.deleted ?? meta.deleted,
        current_text: args.current_text,
        edited_by: args.actor.name,
        edited_function: args.actor.function,
        edited_at: at,
      })
      .where(eq(accuracyParseBlockMeta.block_id, args.block.id));
    return;
  }
  const origin = args.origin ?? "llm";
  await db.insert(accuracyParseBlockMeta).values({
    block_id: args.block.id,
    workspace_id: args.block.workspace_id,
    source_file_id: args.block.source_file_id,
    origin,
    locked: true,
    deleted: args.deleted ?? false,
    current_text: args.current_text,
    original_text: origin === "llm" ? args.block.text : null,
    original_kind: origin === "llm" ? args.block.kind : null,
    original_heading: origin === "llm" ? args.block.heading : null,
    edited_by: args.actor.name,
    edited_function: args.actor.function,
    edited_at: at,
  });
}

async function requireBlock(workspace_id: string, block_id: string): Promise<BlockRow> {
  await ensureParseSchema();
  const [block] = await accuracyDb()
    .select()
    .from(t.accuracyParseBlocks)
    .where(and(eq(t.accuracyParseBlocks.workspace_id, workspace_id), eq(t.accuracyParseBlocks.id, block_id)));
  if (!block) throw new Error(`Unknown parse block ${block_id}.`);
  return block;
}

export class ProvenanceConflictError extends Error {
  readonly orphans: QuoteDependent[];
  constructor(orphans: QuoteDependent[]) {
    super(describeOrphans(orphans));
    this.name = "ProvenanceConflictError";
    this.orphans = orphans;
  }
}

/**
 * Edit a block's text, kind and/or heading. Provenance policy: a text edit is
 * refused when a claim quotes text the new version no longer contains (the
 * quote would be orphaned). The model's original text is kept on the meta row.
 */
export async function editParseBlock(args: {
  workspace_id: string;
  block_id: string;
  text?: string;
  kind?: string;
  heading?: string | null;
  rationale: string;
  actor: ParseEditActor;
}) {
  const rationale = requireEditRationale(args.rationale);
  const block = await requireBlock(args.workspace_id, args.block_id);
  const patch: Partial<Pick<BlockRow, "text" | "kind" | "heading">> = {};
  if (args.text !== undefined) {
    const next = requireText(args.text);
    if (next !== block.text) {
      const orphans = orphanedQuotes(await dependentsFor(args.workspace_id, [block.id]), [next]);
      if (orphans.length) throw new ProvenanceConflictError(orphans);
      patch.text = next;
    }
  }
  if (args.kind !== undefined && args.kind !== block.kind) patch.kind = requireKind(args.kind);
  if (args.heading !== undefined && normHeading(args.heading) !== block.heading) patch.heading = normHeading(args.heading);
  if (Object.keys(patch).length === 0) throw new Error("Nothing changed: the block already has these values.");

  await accuracyDb().update(t.accuracyParseBlocks).set(patch).where(eq(t.accuracyParseBlocks.id, block.id));
  await markHuman({ block, current_text: patch.text ?? block.text, actor: args.actor });
  for (const field of Object.keys(patch) as (keyof typeof patch)[]) {
    await audit({
      workspace_id: args.workspace_id,
      source_file_id: block.source_file_id,
      block_id: block.id,
      action: "edit",
      field,
      before: block[field] ?? null,
      after: patch[field] ?? null,
      rationale,
      actor: args.actor,
    });
  }
  return { ...block, ...patch };
}

/**
 * Split one block in two at a character offset (or where `at_text` starts).
 * Every claim quote must fall wholly inside one half; its provenance is
 * re-pointed to that half. A quote spanning the split refuses the split.
 */
export async function splitParseBlock(args: {
  workspace_id: string;
  block_id: string;
  offset?: number;
  at_text?: string;
  rationale: string;
  actor: ParseEditActor;
}) {
  const rationale = requireEditRationale(args.rationale);
  const block = await requireBlock(args.workspace_id, args.block_id);
  const [first, second] = splitAtOffset(block.text, resolveSplitOffset(block.text, args));
  const deps = await dependentsFor(args.workspace_id, [block.id]);
  const orphans = orphanedQuotes(deps, [first, second]);
  if (orphans.length) throw new ProvenanceConflictError(orphans);

  const db = accuracyDb();
  const secondId = `${block.source_file_id}-${newId("H")}`;
  // Shift later blocks to make room right after the split block.
  await db
    .update(t.accuracyParseBlocks)
    .set({ index: sql`${t.accuracyParseBlocks.index} + 1` })
    .where(
      and(
        eq(t.accuracyParseBlocks.workspace_id, args.workspace_id),
        eq(t.accuracyParseBlocks.source_file_id, block.source_file_id),
        sql`${t.accuracyParseBlocks.index} > ${block.index}`,
      ),
    );
  await db.update(t.accuracyParseBlocks).set({ text: first }).where(eq(t.accuracyParseBlocks.id, block.id));
  await db.insert(t.accuracyParseBlocks).values({
    id: secondId,
    workspace_id: args.workspace_id,
    source_file_id: block.source_file_id,
    index: block.index + 1,
    kind: block.kind,
    heading: block.heading,
    text: second,
    parser: "human",
    created_at: nowIso(),
  });
  for (const dep of deps) {
    if (!squashText(first).includes(squashText(dep.quote))) {
      await db.update(t.accuracyProvenance).set({ block_id: secondId }).where(eq(t.accuracyProvenance.id, dep.provenance_id));
    }
  }
  await markHuman({ block, current_text: first, actor: args.actor });
  await markHuman({
    block: { ...block, id: secondId, text: second },
    current_text: second,
    origin: "human",
    actor: args.actor,
  });
  await audit({
    workspace_id: args.workspace_id,
    source_file_id: block.source_file_id,
    block_id: block.id,
    action: "split",
    field: "text",
    before: block.text,
    after: JSON.stringify({ [block.id]: first, [secondId]: second }),
    rationale,
    actor: args.actor,
  });
  return { first_id: block.id, second_id: secondId };
}

/**
 * Merge a block with the next one (or `next_block_id`). The merged text is
 * both texts joined by a blank line, so every quote still matches; provenance
 * on the absorbed block is re-pointed to the merged block.
 */
export async function mergeParseBlocks(args: {
  workspace_id: string;
  block_id: string;
  next_block_id?: string;
  rationale: string;
  actor: ParseEditActor;
}) {
  const rationale = requireEditRationale(args.rationale);
  const block = await requireBlock(args.workspace_id, args.block_id);
  let next: BlockRow | undefined;
  if (args.next_block_id) {
    next = await requireBlock(args.workspace_id, args.next_block_id);
    if (next.source_file_id !== block.source_file_id) throw new Error("Only blocks of the same source can be merged.");
  } else {
    const rows = await readParseBlocks(args.workspace_id, block.source_file_id);
    next = rows.find((row) => row.index > block.index);
    if (!next) throw new Error("This is the last block: there is nothing after it to merge.");
  }
  if (next.id === block.id) throw new Error("A block cannot be merged with itself.");
  const merged = `${block.text}\n\n${next.text}`;
  const db = accuracyDb();
  await db.update(t.accuracyParseBlocks).set({ text: merged }).where(eq(t.accuracyParseBlocks.id, block.id));
  await db
    .update(t.accuracyProvenance)
    .set({ block_id: block.id })
    .where(and(eq(t.accuracyProvenance.workspace_id, args.workspace_id), eq(t.accuracyProvenance.block_id, next.id)));
  await db.delete(t.accuracyParseBlocks).where(eq(t.accuracyParseBlocks.id, next.id));
  await markHuman({ block, current_text: merged, actor: args.actor });
  // Tombstone the absorbed block so a re-parse does not bring it back as a duplicate.
  await markHuman({ block: next, current_text: next.text, deleted: true, actor: args.actor });
  await renumber(args.workspace_id, block.source_file_id);
  await audit({
    workspace_id: args.workspace_id,
    source_file_id: block.source_file_id,
    block_id: block.id,
    action: "merge",
    field: "text",
    before: JSON.stringify({ [block.id]: block.text, [next.id]: next.text }),
    after: merged,
    rationale,
    actor: args.actor,
  });
  return { block_id: block.id, absorbed_id: next.id, text: merged };
}

/** Delete a block. Refused while any claim quotes it (the quote would be orphaned). */
export async function deleteParseBlock(args: {
  workspace_id: string;
  block_id: string;
  rationale: string;
  actor: ParseEditActor;
}) {
  const rationale = requireEditRationale(args.rationale);
  const block = await requireBlock(args.workspace_id, args.block_id);
  const deps = await dependentsFor(args.workspace_id, [block.id]);
  if (deps.length) throw new ProvenanceConflictError(deps);
  await accuracyDb().delete(t.accuracyParseBlocks).where(eq(t.accuracyParseBlocks.id, block.id));
  await markHuman({ block, current_text: block.text, deleted: true, actor: args.actor });
  await renumber(args.workspace_id, block.source_file_id);
  await audit({
    workspace_id: args.workspace_id,
    source_file_id: block.source_file_id,
    block_id: block.id,
    action: "delete",
    field: "block",
    before: block.text,
    after: null,
    rationale,
    actor: args.actor,
  });
  return { deleted: block.id };
}

async function insertHumanBlock(args: {
  workspace_id: string;
  source_file_id: string;
  after_block_id?: string | null;
  text: string;
  kind?: string;
  heading?: string | null;
  actor: ParseEditActor;
}): Promise<BlockRow> {
  const text = requireText(args.text);
  const kind = requireKind(args.kind ?? "prose");
  const rows = await readParseBlocks(args.workspace_id, args.source_file_id);
  let index = rows.length;
  if (args.after_block_id) {
    const after = rows.find((row) => row.id === args.after_block_id);
    if (!after) throw new Error(`Unknown parse block ${args.after_block_id} in this source.`);
    index = after.index + 1;
  } else if (args.after_block_id === null) {
    index = 0;
  }
  const db = accuracyDb();
  await db
    .update(t.accuracyParseBlocks)
    .set({ index: sql`${t.accuracyParseBlocks.index} + 1` })
    .where(
      and(
        eq(t.accuracyParseBlocks.workspace_id, args.workspace_id),
        eq(t.accuracyParseBlocks.source_file_id, args.source_file_id),
        sql`${t.accuracyParseBlocks.index} >= ${index}`,
      ),
    );
  const row: BlockRow = {
    id: `${args.source_file_id}-${newId("H")}`,
    workspace_id: args.workspace_id,
    source_file_id: args.source_file_id,
    index,
    kind,
    heading: normHeading(args.heading),
    text,
    parser: "human",
    created_at: nowIso(),
  };
  await db.insert(t.accuracyParseBlocks).values(row);
  await markHuman({ block: row, current_text: text, origin: "human", actor: args.actor });
  return row;
}

async function requireSource(workspace_id: string, source_file_id: string) {
  await ensureParseSchema();
  const [row] = await accuracyDb()
    .select()
    .from(t.accuracySourceFiles)
    .where(and(eq(t.accuracySourceFiles.workspace_id, workspace_id), eq(t.accuracySourceFiles.id, source_file_id)));
  if (!row) throw new Error(`Unknown source file ${source_file_id}.`);
  return row;
}

/**
 * Add a block by hand. `after_block_id` places it after that block; `null`
 * puts it first; omitted appends it. Labelled human, locked against re-parse.
 */
export async function addParseBlock(args: {
  workspace_id: string;
  source_file_id: string;
  after_block_id?: string | null;
  text: string;
  kind?: string;
  heading?: string | null;
  rationale: string;
  actor: ParseEditActor;
}) {
  const rationale = requireEditRationale(args.rationale);
  await requireSource(args.workspace_id, args.source_file_id);
  const row = await insertHumanBlock(args);
  await audit({
    workspace_id: args.workspace_id,
    source_file_id: args.source_file_id,
    block_id: row.id,
    action: "add",
    field: "block",
    before: null,
    after: row.text,
    rationale,
    actor: args.actor,
  });
  return row;
}

/** Store the units a parse dropped as noise (replaces that source's unrestored list). */
export async function persistDroppedUnits(args: {
  workspace_id: string;
  source_file_id: string;
  units: { location: string; reason: string; text: string }[];
}) {
  await ensureParseSchema();
  const db = accuracyDb();
  const existing = await listDroppedUnits(args.workspace_id, args.source_file_id);
  const restored = existing.filter((row) => row.restored_block_id);
  const stale = existing.filter((row) => !row.restored_block_id).map((row) => row.id);
  if (stale.length) await db.delete(accuracyParseDropped).where(inArray(accuracyParseDropped.id, stale));
  const restoredTexts = new Set(restored.map((row) => squashText(row.text)));
  const created_at = nowIso();
  let stored = 0;
  for (const unit of args.units) {
    if (restoredTexts.has(squashText(unit.text))) continue;
    await db.insert(accuracyParseDropped).values({
      id: newId("drop"),
      workspace_id: args.workspace_id,
      source_file_id: args.source_file_id,
      location: unit.location,
      reason: unit.reason,
      text: unit.text,
      restored_block_id: null,
      created_at,
    });
    stored += 1;
  }
  return stored;
}

/** Restore a unit the model dropped as noise as a human block (appended, or after a block). */
export async function restoreDroppedUnit(args: {
  workspace_id: string;
  dropped_id: string;
  after_block_id?: string | null;
  kind?: string;
  heading?: string | null;
  rationale: string;
  actor: ParseEditActor;
}) {
  const rationale = requireEditRationale(args.rationale);
  await ensureParseSchema();
  const [unit] = await accuracyDb()
    .select()
    .from(accuracyParseDropped)
    .where(and(eq(accuracyParseDropped.workspace_id, args.workspace_id), eq(accuracyParseDropped.id, args.dropped_id)));
  if (!unit) throw new Error(`Unknown dropped unit ${args.dropped_id}.`);
  if (unit.restored_block_id) throw new Error(`Already restored as block ${unit.restored_block_id}.`);
  const row = await insertHumanBlock({
    workspace_id: args.workspace_id,
    source_file_id: unit.source_file_id,
    after_block_id: args.after_block_id,
    text: unit.text,
    kind: args.kind,
    heading: args.heading ?? unit.location,
    actor: args.actor,
  });
  await accuracyDb()
    .update(accuracyParseDropped)
    .set({ restored_block_id: row.id })
    .where(eq(accuracyParseDropped.id, unit.id));
  await audit({
    workspace_id: args.workspace_id,
    source_file_id: unit.source_file_id,
    block_id: row.id,
    action: "restore_dropped",
    field: "block",
    before: `dropped (${unit.location}): ${unit.reason}`,
    after: row.text,
    rationale,
    actor: args.actor,
  });
  return row;
}

/* ------------------------------------------------------------------------- */
/* Stakeholder function                                                        */
/* ------------------------------------------------------------------------- */

export type SourceStakeholder = {
  source_file_id: string;
  /** Effective value: the human override when present, else the model's. */
  stakeholder_function: string | null;
  set_by: "human" | "llm" | null;
  llm_function: string | null;
  llm_rationale: string | null;
  override_function: string | null;
  override_rationale: string | null;
  override_by: string | null;
  override_at: string | null;
};

export async function readSourceStakeholder(workspace_id: string, source_file_id: string): Promise<SourceStakeholder> {
  await ensureParseSchema();
  const [row] = await accuracyDb()
    .select()
    .from(accuracySourceStakeholder)
    .where(
      and(
        eq(accuracySourceStakeholder.workspace_id, workspace_id),
        eq(accuracySourceStakeholder.source_file_id, source_file_id),
      ),
    );
  return {
    source_file_id,
    stakeholder_function: row?.override_function ?? row?.llm_function ?? null,
    set_by: row?.override_function ? "human" : row?.llm_function ? "llm" : null,
    llm_function: row?.llm_function ?? null,
    llm_rationale: row?.llm_rationale ?? null,
    override_function: row?.override_function ?? null,
    override_rationale: row?.override_rationale ?? null,
    override_by: row?.override_by ?? null,
    override_at: row?.override_at ?? null,
  };
}

/** The parse LLM's classification. Never touches a human override. */
export async function recordLlmStakeholder(args: {
  workspace_id: string;
  source_file_id: string;
  stakeholder_function: string;
  rationale: string;
}) {
  await ensureParseSchema();
  const at = nowIso();
  await accuracyDb()
    .insert(accuracySourceStakeholder)
    .values({
      source_file_id: args.source_file_id,
      workspace_id: args.workspace_id,
      llm_function: args.stakeholder_function,
      llm_rationale: args.rationale,
      llm_at: at,
    })
    .onConflictDoUpdate({
      target: accuracySourceStakeholder.source_file_id,
      set: { llm_function: args.stakeholder_function, llm_rationale: args.rationale, llm_at: at },
    });
}

/** A human sets or overrides the document's stakeholder function. */
export async function setSourceStakeholder(args: {
  workspace_id: string;
  source_file_id: string;
  stakeholder_function: string;
  rationale: string;
  actor: ParseEditActor;
}) {
  const rationale = requireEditRationale(args.rationale);
  if (!(STAKEHOLDER_FUNCTIONS as readonly string[]).includes(args.stakeholder_function)) {
    throw new Error(`Unknown stakeholder function "${args.stakeholder_function}".`);
  }
  await requireSource(args.workspace_id, args.source_file_id);
  const before = await readSourceStakeholder(args.workspace_id, args.source_file_id);
  const at = nowIso();
  await accuracyDb()
    .insert(accuracySourceStakeholder)
    .values({
      source_file_id: args.source_file_id,
      workspace_id: args.workspace_id,
      override_function: args.stakeholder_function,
      override_rationale: rationale,
      override_by: args.actor.name,
      override_at: at,
    })
    .onConflictDoUpdate({
      target: accuracySourceStakeholder.source_file_id,
      set: {
        override_function: args.stakeholder_function,
        override_rationale: rationale,
        override_by: args.actor.name,
        override_at: at,
      },
    });
  await audit({
    workspace_id: args.workspace_id,
    source_file_id: args.source_file_id,
    block_id: null,
    action: "override",
    field: "stakeholder_function",
    before: before.stakeholder_function,
    after: args.stakeholder_function,
    rationale,
    actor: args.actor,
  });
  return readSourceStakeholder(args.workspace_id, args.source_file_id);
}

/* ------------------------------------------------------------------------- */
/* Manual source entry — no AI                                                 */
/* ------------------------------------------------------------------------- */

/**
 * Create a source from typed/pasted text with the blocks the user defined.
 * No LLM runs; every block is `origin: human`, `parser: "human"`.
 */
export async function createManualSource(args: {
  workspace_id: string;
  org_id?: string;
  filename: string;
  doc_role?: string;
  blocks: { text: string; kind?: string; heading?: string | null }[];
  stakeholder_function?: StakeholderFunction | null;
  rationale: string;
  actor: ParseEditActor;
}) {
  const rationale = requireEditRationale(args.rationale);
  const blocks = args.blocks
    .map((block) => ({ ...block, text: (block.text ?? "").trim() }))
    .filter((block) => block.text);
  if (blocks.length === 0) throw new Error("Add at least one block of text.");
  for (const block of blocks) requireKind(block.kind ?? "prose");
  const filename = args.filename.trim() || "typed-source.txt";
  const fullText = blocks.map((block) => block.text).join("\n\n");
  const source = await insertSourceFile({
    workspace_id: args.workspace_id,
    org_id: args.org_id,
    filename,
    mime: "text/plain",
    checksum: createHash("sha256").update(fullText).digest("hex"),
    doc_role: args.doc_role ?? "other",
  });
  await ensureParseSchema();
  const created_at = nowIso();
  const db = accuracyDb();
  const ids: string[] = [];
  for (const [index, block] of blocks.entries()) {
    const row: BlockRow = {
      id: `${source.id}-H${String(index + 1).padStart(3, "0")}`,
      workspace_id: args.workspace_id,
      source_file_id: source.id,
      index,
      kind: block.kind ?? "prose",
      heading: normHeading(block.heading),
      text: block.text,
      parser: "human",
      created_at,
    };
    await db.insert(t.accuracyParseBlocks).values(row);
    await markHuman({ block: row, current_text: row.text, origin: "human", actor: args.actor });
    ids.push(row.id);
  }
  await audit({
    workspace_id: args.workspace_id,
    source_file_id: source.id,
    block_id: null,
    action: "manual_source",
    field: "blocks",
    before: null,
    after: `${blocks.length} human-entered block(s)`,
    rationale,
    actor: args.actor,
  });
  if (args.stakeholder_function) {
    await setSourceStakeholder({
      workspace_id: args.workspace_id,
      source_file_id: source.id,
      stakeholder_function: args.stakeholder_function,
      rationale,
      actor: args.actor,
    });
  }
  return { source, block_ids: ids };
}

/* ------------------------------------------------------------------------- */
/* Parsed-document mapping (unchanged contract)                                */
/* ------------------------------------------------------------------------- */

function storeKindFromParsed(
  kind: string,
): ParseBlock["kind"] {
  if (kind === "title" || kind === "heading") return "heading";
  if (kind === "bullet") return "list_item";
  if (kind === "cell" || kind === "table_cell") return "table_row";
  if (kind === "chart" || kind === "figure") return "caption";
  return "prose";
}

export function blocksFromParsedDocument(args: {
  workspace_id: string;
  source_file_id: string;
  blocks: {
    id: string;
    text: string;
    kind?: string;
    heading?: string;
    location?: { ref?: string };
  }[];
}): Omit<ParseBlock, "workspace_id">[] {
  return args.blocks.map((b, index) => ({
    id: b.id,
    source_file_id: args.source_file_id,
    index,
    kind: storeKindFromParsed(b.kind ?? "paragraph"),
    heading: b.heading ?? b.location?.ref ?? null,
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
