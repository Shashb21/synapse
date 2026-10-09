import type { TimelineActivity } from "./build";

type Fingerprinted = Pick<
  TimelineActivity,
  "id" | "tactic_name" | "band" | "start_date" | "end_date" | "readout_date" | "depends_on" | "tactic_status"
>;

/**
 * What a saved plan froze, as one comparable string: each activity's dates,
 * band, status, name and dependencies. "Changed since the last save" compares
 * these, not only how many activities there are, so moving a date counts
 * (KAN-18).
 */
export function planFingerprint(activities: readonly Fingerprinted[]): string {
  return JSON.stringify(
    [...activities]
      .map((row) => [
        row.id,
        row.tactic_name,
        row.band,
        row.tactic_status,
        row.start_date,
        row.end_date,
        row.readout_date ?? null,
        [...(row.depends_on ?? [])].sort(),
      ])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  );
}
