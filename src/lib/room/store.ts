import { eq, sql } from "drizzle-orm";
import { integer, pgTable, text } from "drizzle-orm/pg-core";
import { db, onWorkspaceBootstrap } from "@/lib/iegp/db";
import { selectedWorkspaceId } from "@/modules/workspaces/context";
import { nowIso } from "@/modules/kernel/ids";
import { FIRST_SLIDE_ID, isShowableHref, slideById } from "./slides";

/**
 * Room state, per workspace (every table lives in the workspace's own schema):
 * - `room_notes`: the consultant's speaker notes, one row per slide.
 * - `room_presenter`: the slide (and exact page) the presenter is showing, so an
 *   audience window on another machine can follow. `rev` bumps on every change,
 *   including "the presenter edited something on this page".
 */

export const roomNotes = pgTable("room_notes", {
  slide_id: text("slide_id").primaryKey(),
  notes: text("notes").notNull(),
  updated_at: text("updated_at").notNull(),
});

export const roomPresenter = pgTable("room_presenter", {
  id: text("id").primaryKey(),
  slide_id: text("slide_id").notNull(),
  href: text("href").notNull(),
  rev: integer("rev").notNull(),
  updated_at: text("updated_at").notNull(),
});

const ROOM_DDL = [
  `CREATE TABLE IF NOT EXISTS room_notes (
    slide_id text PRIMARY KEY, notes text NOT NULL, updated_at text NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS room_presenter (
    id text PRIMARY KEY, slide_id text NOT NULL, href text NOT NULL,
    rev integer NOT NULL, updated_at text NOT NULL
  )`,
];

onWorkspaceBootstrap(async (run) => {
  for (const stmt of ROOM_DDL) await run(stmt);
});

const globalRoom = globalThis as unknown as { roomSchema?: Map<string, Promise<void>> };

/** Creates the room tables once per workspace schema (lazily, like source-blocks). */
async function ensureRoomSchema() {
  const key = (await selectedWorkspaceId()) ?? "default";
  globalRoom.roomSchema ??= new Map();
  let ready = globalRoom.roomSchema.get(key);
  if (!ready) {
    ready = (async () => {
      for (const stmt of ROOM_DDL) await db().execute(sql.raw(stmt));
    })();
    globalRoom.roomSchema.set(key, ready);
    ready.catch(() => globalRoom.roomSchema?.delete(key));
  }
  await ready;
}

export const NOTES_MAX = 20_000;
const CURRENT = "current";

export type RoomState = { slide_id: string; href: string; rev: number; updated_at: string | null };

export async function listRoomNotes(): Promise<Record<string, string>> {
  await ensureRoomSchema();
  const rows = await db().select().from(roomNotes);
  return Object.fromEntries(rows.map((row) => [row.slide_id, row.notes]));
}

export async function saveRoomNote(slide_id: string, notes: string): Promise<void> {
  if (!slideById(slide_id)) throw new Error(`Unknown slide: ${slide_id}`);
  if (typeof notes !== "string") throw new Error("Notes must be text.");
  if (notes.length > NOTES_MAX) throw new Error(`Notes are limited to ${NOTES_MAX} characters.`);
  await ensureRoomSchema();
  const at = nowIso();
  await db()
    .insert(roomNotes)
    .values({ slide_id, notes, updated_at: at })
    .onConflictDoUpdate({ target: roomNotes.slide_id, set: { notes, updated_at: at } });
}

export async function getRoomState(): Promise<RoomState> {
  await ensureRoomSchema();
  const [row] = await db().select().from(roomPresenter).where(eq(roomPresenter.id, CURRENT));
  const slide = slideById(row?.slide_id);
  if (!row || !slide) {
    const first = slideById(FIRST_SLIDE_ID)!;
    return { slide_id: first.id, href: first.href, rev: row?.rev ?? 0, updated_at: row?.updated_at ?? null };
  }
  return { slide_id: row.slide_id, href: row.href, rev: row.rev, updated_at: row.updated_at };
}

/**
 * Moves the presenter. `href` defaults to the slide's own page; a different
 * page (the consultant clicked into a gap) must be showable. With no slide or
 * href change this still bumps `rev`, which tells audiences to refresh.
 */
export async function setRoomState(input: { slide_id?: string; href?: string }): Promise<RoomState> {
  const current = await getRoomState();
  const slide_id = input.slide_id ?? current.slide_id;
  const slide = slideById(slide_id);
  if (!slide) throw new Error(`Unknown slide: ${slide_id}`);
  let href = input.slide_id && input.slide_id !== current.slide_id ? slide.href : current.href;
  if (input.href !== undefined) {
    if (!isShowableHref(input.href)) throw new Error("That page cannot be shown in the room.");
    href = input.href;
  }
  const at = nowIso();
  const [row] = await db()
    .insert(roomPresenter)
    .values({ id: CURRENT, slide_id, href, rev: current.rev + 1, updated_at: at })
    .onConflictDoUpdate({
      target: roomPresenter.id,
      set: { slide_id, href, rev: sql`${roomPresenter.rev} + 1`, updated_at: at },
    })
    .returning();
  return { slide_id: row.slide_id, href: row.href, rev: row.rev, updated_at: row.updated_at };
}
