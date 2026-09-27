import { sql } from "drizzle-orm";
import { scopedWorkspaceId } from "@/modules/workspaces/context";
import { getWorkspace } from "@/modules/workspaces/store";
import { sharedDb } from "./db";
import { nowIso } from "./ids";

/**
 * Whether AI may run. With AI off the tool is fully manual: no model is
 * called, no suggestion or automatic AI action runs, and the UI shows only the
 * hand-entry paths.
 *
 * Two switches decide it, and both must be on:
 * - the platform switch (the owner's master kill-switch in /admin/control),
 *   stored in platform_settings and surviving workspace resets;
 * - the workspace's own "AI assistance" setting, set by that workspace's
 *   owner (workspaces.ai_enabled; modules/workspaces/ai-setting.ts).
 *
 * `aiEnabled()` resolves the workspace the way `db()` resolves the schema: a
 * `runInWorkspace` scope, else the signed workspace cookie. Outside a request
 * only the platform switch counts.
 */

export const PLATFORM_SETTINGS_DDL = `CREATE TABLE IF NOT EXISTS platform_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_by text NOT NULL,
  updated_at text NOT NULL
)`;

const AI_KEY = "ai_enabled";

let settingsReady: Promise<unknown> | null = null;
/** Platform settings are shared by every workspace, so they live in the public schema. */
function ensureSettingsTable() {
  settingsReady ??= sharedDb()
    .execute(sql.raw(PLATFORM_SETTINGS_DDL))
    .catch((error) => {
      settingsReady = null; // retry on the next call
      throw error;
    });
  return settingsReady;
}

export const AI_OFF_MESSAGE =
  "AI is turned off. Do this step by hand, or ask your workspace owner or Synapse administrator to turn AI on.";

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
  await ensureSettingsTable();
  const rows = (await sharedDb().execute(
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

/** The platform (master) switch alone, whatever any workspace has set. */
export async function platformAiEnabled(): Promise<boolean> {
  return (await aiSwitch()).enabled;
}

/** The workspace's own AI assistance setting; an unknown workspace counts as on. */
export async function workspaceAiEnabled(workspaceId: string): Promise<boolean> {
  const workspace = await getWorkspace(workspaceId);
  return workspace ? workspace.ai_enabled : true;
}

export type AiState = {
  /** Effective: the platform switch AND the workspace setting. */
  enabled: boolean;
  platform: boolean;
  /** The workspace setting; true when no workspace is in scope. */
  workspace: boolean;
  workspace_id: string | null;
  /** Which switch turned AI off, or null while it is on. The platform wins when both are off. */
  off_by: "platform" | "workspace" | null;
};

/** Both switches for the workspace in scope (or `workspaceId` when given). */
export async function aiState(workspaceId?: string | null): Promise<AiState> {
  const id = workspaceId === undefined ? await scopedWorkspaceId() : workspaceId;
  const [platform, workspace] = await Promise.all([
    platformAiEnabled(),
    id ? workspaceAiEnabled(id) : Promise.resolve(true),
  ]);
  return {
    enabled: platform && workspace,
    platform,
    workspace,
    workspace_id: id,
    off_by: !platform ? "platform" : !workspace ? "workspace" : null,
  };
}

/** Effective AI for the current workspace: the platform switch AND the workspace setting. */
export async function aiEnabled(): Promise<boolean> {
  return (await aiState()).enabled;
}

/** Throws AiDisabledError when the switch is off. */
export async function assertAiEnabled(what?: string): Promise<void> {
  if (!(await aiEnabled())) throw new AiDisabledError(what);
}

/** The platform switch. A plain switch: no reason is asked for, and it is not an edit that feeds hillclimb. */
export async function setAiEnabled(args: {
  enabled: boolean;
  actor_name: string;
  rationale?: string;
}): Promise<AiSwitch> {
  const rationale = args.rationale?.trim() || undefined;
  await ensureSettingsTable();
  const value = JSON.stringify({ enabled: args.enabled, rationale } satisfies StoredValue);
  const at = nowIso();
  await sharedDb().execute(
    sql`insert into platform_settings (key, value, updated_by, updated_at)
        values (${AI_KEY}, ${value}::jsonb, ${args.actor_name}, ${at})
        on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  );
  return { enabled: args.enabled, updated_by: args.actor_name, updated_at: at, rationale: rationale ?? null };
}
