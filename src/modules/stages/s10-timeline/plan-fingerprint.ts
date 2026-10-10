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
/**
 * A short code for a fingerprint (FNV-1a, 8 hex characters), stamped on an
 * exported chart and its filename so an image can be matched to the saved
 * version it shows (KAN-85). Runs the same in the browser and on the server.
 */
export function fingerprintCode(fingerprint: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < fingerprint.length; index += 1) {
    hash ^= fingerprint.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

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
