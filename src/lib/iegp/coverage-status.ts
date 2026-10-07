/** Authoritative coverage only; mapping previews and human status overrides are separate. */
export type StatusAssessment = {
  overall: string | null | undefined;
  lifecycle: string | null | undefined;
  validated: boolean;
  freshness?: "current" | "stale" | "unknown" | "unassessed";
};

export function computeCoverageStatus(rows: readonly StatusAssessment[]): "open" | "partial" | "addressed" {
  const eligible = rows.filter((row) => row.validated && row.freshness === "current" &&
    (row.lifecycle === "planned" || row.lifecycle === "ongoing" || row.lifecycle === "completed"));
  if (eligible.some((row) => row.overall === "full")) return "addressed";
  if (eligible.some((row) => row.overall === "partial" || row.overall === "limited")) return "partial";
  return "open";
}
