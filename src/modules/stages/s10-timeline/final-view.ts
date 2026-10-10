import { isCompletePackage, LEGACY_PACKAGE_NOTE, packageFingerprint, type FinalPackage } from "./final-package";
import type { IegpPlanRecord } from "./module";

/**
 * A saved plan as a reader sees it (KAN-86), built only from what was frozen.
 * A final saved before KAN-86 is a legacy package: its timeline is shown as it
 * was, and nothing is filled in for the parts that were never frozen.
 */
export type FinalPlanView =
  | {
      kind: "complete";
      version: number;
      status: IegpPlanRecord["status"];
      saved_by: string;
      saved_at: string;
      note: string | null;
      schema_version: string;
      package_fingerprint: string;
      /** False when the stored fingerprint no longer matches the stored package. */
      intact: boolean;
      package: FinalPackage;
    }
  | {
      kind: "legacy";
      version: number;
      status: IegpPlanRecord["status"];
      saved_by: string;
      saved_at: string;
      note: string | null;
      legacy_note: typeof LEGACY_PACKAGE_NOTE;
      timeline: Pick<IegpPlanRecord["snapshot"], "activities" | "window" | "lanes" | "unscheduled" | "counts"> & {
        fingerprint: string | null;
      };
    };

export function finalPlanView(record: IegpPlanRecord): FinalPlanView {
  const base = {
    version: record.version,
    status: record.status,
    saved_by: record.saved_by,
    saved_at: record.saved_at,
    note: record.note,
  };
  const snapshot = record.snapshot;
  if (isCompletePackage(snapshot)) {
    const stored = snapshot.package_fingerprint ?? "";
    return {
      kind: "complete",
      ...base,
      schema_version: snapshot.package.schema_version,
      package_fingerprint: stored,
      intact: stored === packageFingerprint(snapshot.package),
      package: snapshot.package,
    };
  }
  return {
    kind: "legacy",
    ...base,
    legacy_note: LEGACY_PACKAGE_NOTE,
    timeline: {
      activities: snapshot.activities,
      window: snapshot.window,
      lanes: snapshot.lanes,
      unscheduled: snapshot.unscheduled,
      counts: snapshot.counts,
      fingerprint: snapshot.fingerprint ?? null,
    },
  };
}
