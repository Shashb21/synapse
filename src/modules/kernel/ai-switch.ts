import { sql } from "drizzle-orm";
import { db, ensurePlatformSchema } from "./db";
import { nowIso } from "./ids";

/**
 * The admin AI switch. With AI off the tool is fully manual: no model is
 * called, no suggestion or automatic AI action runs, and the UI shows only the
 * hand-entry paths. The switch is platform-wide and survives workspace resets.
 */

export const PLATFORM_SETTINGS_DDL = `CREATE TABLE IF NOT EXISTS platform_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_by text NOT NULL,
  updated_at text NOT NULL
)`;

const AI_KEY = "ai_enabled";

export const AI_OFF_MESSAGE =
  "AI is turned off in the control panel. Do this step by hand, or ask an admin to turn AI on.";

/** Thrown by every AI entry point while the switch is off. */
export class AiDisabledError extends Error {
  constructor(what?: string) {
    super(what ? `${what}: ${AI_OFF_MESSAGE}` : AI_OFF_MESSAGE);
    this.name = "AiDisabledError";
  }
}

export type AiSwitch = {
  enabled: boolean;
  updated_by: string | null;
  updated_at: string | null;
  rationale: string | null;
};

type StoredValue = { enabled: boolean; rationale?: string };

export async function aiSwitch(): Promise<AiSwitch> {
  await ensurePlatformSchema([PLATFORM_SETTINGS_DDL]);
  const rows = (await db().execute(
    sql`select value, updated_by, updated_at from platform_settings where key = ${AI_KEY} limit 1`,
  )) as unknown as { value: StoredValue; updated_by: string; updated_at: string }[];
  const row = rows[0];
  // AI is on until an admin turns it off.
  if (!row) return { enabled: true, updated_by: null, updated_at: null, rationale: null };
  return {
    enabled: row.value.enabled !== false,
    updated_by: row.updated_by,
    updated_at: row.updated_at,
    rationale: row.value.rationale ?? null,
  };
}

export async function aiEnabled(): Promise<boolean> {
  return (await aiSwitch()).enabled;
}

/** Throws AiDisabledError when the switch is off. */
export async function assertAiEnabled(what?: string): Promise<void> {
  if (!(await aiEnabled())) throw new AiDisabledError(what);
}

/** A plain switch: no reason is asked for, and it is not an edit that feeds hillclimb. */
export async function setAiEnabled(args: {
  enabled: boolean;
  actor_name: string;
  rationale?: string;
}): Promise<AiSwitch> {
  const rationale = args.rationale?.trim() || undefined;
  await ensurePlatformSchema([PLATFORM_SETTINGS_DDL]);
  const value = JSON.stringify({ enabled: args.enabled, rationale } satisfies StoredValue);
  const at = nowIso();
  await db().execute(
    sql`insert into platform_settings (key, value, updated_by, updated_at)
        values (${AI_KEY}, ${value}::jsonb, ${args.actor_name}, ${at})
        on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  );
  return { enabled: args.enabled, updated_by: args.actor_name, updated_at: at, rationale: rationale ?? null };
}
