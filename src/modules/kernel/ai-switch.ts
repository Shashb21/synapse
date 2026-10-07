import { sql } from "drizzle-orm";
import { scopedWorkspaceId } from "@/modules/workspaces/context";
import { getWorkspace } from "@/modules/workspaces/store";
import { sharedDb } from "./db";
import { nowIso } from "./ids";
import { AI_SECTION_IDS, isAiSectionId, noAiSections, type AiSectionId, type AiSections } from "./ai-sections";

/**
 * Whether AI may run. With AI off the tool is fully manual: no model is
 * called, no suggestion or automatic AI action runs, and the UI shows only the
 * hand-entry paths.
 *
 * The Synapse admin decides it, for every customer (KAN-53):
 * - the platform master switch in /admin/control, which turns all AI off;
 * - one switch per AI section (ingestion, extraction, mapping, split,
 *   prioritization, ideation: ai-sections.ts). Every section starts off.
 * Customers have no AI switch. The old per-workspace setting
 * (workspaces.ai_enabled) no longer counts.
 */

export const PLATFORM_SETTINGS_DDL = `CREATE TABLE IF NOT EXISTS platform_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_by text NOT NULL,
  updated_at text NOT NULL
)`;

const AI_KEY = "ai_enabled";
const SECTIONS_KEY = "ai_sections";

type SettingsExecutor = Pick<ReturnType<typeof sharedDb>, "execute">;

let settingsReady: Promise<unknown> | null = null;
/** Platform settings are shared by every workspace, so they live in the public schema. */
function ensureSettingsTable(executor?: SettingsExecutor) {
  // A caller inside an Accuracy transaction must use its reserved connection.
  // Do not cache transactional DDL: that transaction may roll back.
  if (executor) return executor.execute(sql.raw(PLATFORM_SETTINGS_DDL));
  settingsReady ??= sharedDb()
    .execute(sql.raw(PLATFORM_SETTINGS_DDL))
    .catch((error) => {
      settingsReady = null; // retry on the next call
      throw error;
    });
  return settingsReady;
}

/**
 * What a customer reads when a step is refused because an admin switched AI off.
 * Customers are not told about AI (KAN-53) and have no switch, so it names the
 * manual path and the administrator only.
 */
export const AI_OFF_MESSAGE =
  "This step isn't available right now. Do it by hand, or contact your Synapse administrator.";

/** The same refusal on owner-only surfaces (accuracy lab, harness), where the switch is theirs. */
export const AI_OFF_ADMIN_MESSAGE = "AI is turned off platform-wide. Turn it on in AI & routing to run this.";

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

export async function aiSwitch(executor?: SettingsExecutor): Promise<AiSwitch> {
  await ensureSettingsTable(executor);
  const rows = (await (executor ?? sharedDb()).execute(
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
  /** Per section: the master switch AND the section switch (KAN-53). */
  sections: AiSections;
  /** Which switch turned AI off, or null while it is on. The platform wins when both are off. */
  off_by: "platform" | "workspace" | null;
};

/** The admin's per-section switches as stored; a section never set is off. */
export async function storedAiSections(executor?: SettingsExecutor): Promise<{ sections: AiSections; updated_by: string | null; updated_at: string | null }> {
  await ensureSettingsTable(executor);
  const rows = (await (executor ?? sharedDb()).execute(
    sql`select value, updated_by, updated_at from platform_settings where key = ${SECTIONS_KEY} limit 1`,
  )) as unknown as { value: Partial<Record<string, boolean>>; updated_by: string; updated_at: string }[];
  const stored = rows[0]?.value ?? {};
  const sections = noAiSections();
  for (const id of AI_SECTION_IDS) sections[id] = stored[id] === true;
  return { sections, updated_by: rows[0]?.updated_by ?? null, updated_at: rows[0]?.updated_at ?? null };
}

/** Effective per-section AI: the master switch AND the section's switch. */
export async function aiSections(): Promise<AiSections> {
  const [platform, stored] = await Promise.all([platformAiEnabled(), storedAiSections()]);
  const sections = noAiSections();
  for (const id of AI_SECTION_IDS) sections[id] = platform && stored.sections[id];
  return sections;
}

/** Turns one section on or off for every customer (admin only; the caller checks). */
export async function setAiSection(args: { section: AiSectionId; enabled: boolean; actor_name: string }): Promise<AiSections> {
  if (!isAiSectionId(args.section)) throw new Error("Unknown AI section.");
  const next = { ...(await storedAiSections()).sections, [args.section]: args.enabled };
  const at = nowIso();
  await sharedDb().execute(
    sql`insert into platform_settings (key, value, updated_by, updated_at)
        values (${SECTIONS_KEY}, ${JSON.stringify(next)}::jsonb, ${args.actor_name}, ${at})
        on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  );
  return next;
}

/** The switches for the workspace in scope. `workspace` stays for callers that read it. */
export async function aiState(workspaceId?: string | null): Promise<AiState> {
  const id = workspaceId === undefined ? await scopedWorkspaceId() : workspaceId;
  const [platform, sections] = await Promise.all([platformAiEnabled(), aiSections()]);
  const any = AI_SECTION_IDS.some((section) => sections[section]);
  return {
    enabled: platform && any,
    platform,
    workspace: true,
    workspace_id: id,
    sections,
    off_by: platform && any ? null : "platform",
  };
}

/** Whether any AI runs at all: the master switch AND at least one section on. */
export async function aiEnabled(executor?: SettingsExecutor): Promise<boolean> {
  if (!executor) return (await aiState()).enabled;
  const [platform, stored] = await Promise.all([aiSwitch(executor), storedAiSections(executor)]);
  return platform.enabled && AI_SECTION_IDS.some(section => stored.sections[section]);
}

/** Whether one section's AI runs: the master switch AND that section's switch. */
export async function aiSectionEnabled(section: AiSectionId): Promise<boolean> {
  return (await aiSections())[section];
}

/** Throws AiDisabledError when the section (or, with none given, all AI) is off. */
export async function assertAiEnabled(what?: string, section?: AiSectionId, executor?: SettingsExecutor): Promise<void> {
  const on = section ? await aiSectionEnabled(section) : await aiEnabled(executor);
  if (!on) throw new AiDisabledError(what);
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
