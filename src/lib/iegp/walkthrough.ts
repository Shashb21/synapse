import { sql } from "drizzle-orm";
import { db, ensureSchema } from "./db";

/**
 * Walkthrough progress, stored in the workspace's own schema so it is kept per
 * person per workspace. `status`: active (the tour is showing), dismissed
 * (closed part-way; it can be resumed or restarted), done (finished).
 */
export const WALKTHROUGH_STATUSES = ["active", "dismissed", "done"] as const;
export type WalkthroughStatus = (typeof WALKTHROUGH_STATUSES)[number];
export type WalkthroughProgress = { status: WalkthroughStatus | "not_started"; step: number; updated_at: string | null };

const NOT_STARTED: WalkthroughProgress = { status: "not_started", step: 0, updated_at: null };

export async function getWalkthrough(principal: string): Promise<WalkthroughProgress> {
  await ensureSchema();
  const rows = (await db().execute(
    sql`select step, status, updated_at from walkthrough_progress where principal = ${principal} limit 1`,
  )) as unknown as { step: number; status: string; updated_at: string }[];
  const row = rows[0];
  if (!row) return { ...NOT_STARTED };
  const status = (WALKTHROUGH_STATUSES as readonly string[]).includes(row.status) ? (row.status as WalkthroughStatus) : "dismissed";
  return { status, step: Math.max(0, Number(row.step) || 0), updated_at: row.updated_at };
}

export async function saveWalkthrough(
  principal: string,
  next: { status: WalkthroughStatus; step: number },
): Promise<WalkthroughProgress> {
  if (!(WALKTHROUGH_STATUSES as readonly string[]).includes(next.status)) throw new Error(`Unknown walkthrough status ${next.status}`);
  const step = Math.max(0, Math.min(50, Math.floor(Number(next.step) || 0)));
  const at = new Date().toISOString();
  await ensureSchema();
  await db().execute(sql`
    insert into walkthrough_progress (principal, step, status, updated_at)
    values (${principal}, ${step}, ${next.status}, ${at})
    on conflict (principal) do update set step = excluded.step, status = excluded.status, updated_at = excluded.updated_at`);
  return { status: next.status, step, updated_at: at };
}
