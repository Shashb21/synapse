import type { IegpState } from "./types";

/**
 * The workspace audit action a reset to blank or a demo load writes (KAN-89).
 * The audit and gap_versions tables survive a reset, so gap ids restart at
 * GAP-001 while older versions are still on file.
 */
export const WORKSPACE_RESET_ACTION = "workspace_reset";

/** When the workspace's contents were last replaced, or null if never. */
export function lastResetAt(state: Pick<IegpState, "audit">): string | null {
  let latest: string | null = null;
  for (const row of state.audit) {
    if (row.action === WORKSPACE_RESET_ACTION && (!latest || row.at > latest)) latest = row.at;
  }
  return latest;
}

/**
 * A gap's version history: only versions recorded since the last reset, so a
 * new gap that reuses an id never shows the history of the gap it replaced.
 */
export function gapVersionsFor(state: Pick<IegpState, "audit" | "gap_versions">, gapId: string): IegpState["gap_versions"] {
  const since = lastResetAt(state);
  return state.gap_versions.filter((row) => row.live_gap_id === gapId && (!since || row.at >= since));
}
