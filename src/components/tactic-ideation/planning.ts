/** Shared planning labels and visible-population counts; never computes scientific coverage. */
import type { PlanTactic } from "@/lib/iegp/engine";
import { gapNumberLabel } from "@/lib/iegp/gap-number";

type PlanningGap = { gap_id: string; gap_name: string; number: number; domain: string; tactics: PlanTactic[] };
export type PlanningFilters = { query: string; domain: string; links: "" | "linked" | "unlinked" };

/** Describe saved planning activity, keeping cancelled links outside committed work. */
export function planningLabel(tactics: PlanTactic[]): "No candidate linked" | "Candidate linked" | "Tactic planned" {
  if (tactics.some(tactic => ["planned", "ongoing", "completed"].includes(tactic.status))) return "Tactic planned";
  return tactics.length ? "Candidate linked" : "No candidate linked";
}

/** Apply the same search, domain and saved-link filters to either board population. */
export function filterPlanningGaps<T extends PlanningGap>(gaps: T[], filters: PlanningFilters): T[] {
  const query = filters.query.trim().toLowerCase();
  return gaps.filter(gap => {
    if (query && !gap.gap_name.toLowerCase().includes(query) && !gap.gap_id.toLowerCase().includes(query) && !gapNumberLabel(gap.number).includes(query)) return false;
    if (filters.domain && gap.domain !== filters.domain) return false;
    if (filters.links === "linked" && !gap.tactics.length) return false;
    if (filters.links === "unlinked" && gap.tactics.length) return false;
    return true;
  });
}

/** Count mutually exclusive planning labels for precisely the supplied visible gaps. */
export function summarizePlanning(gaps: PlanningGap[]) {
  const summary = { total: gaps.length, unlinked: 0, linked: 0, planned: 0 };
  for (const gap of gaps) {
    const label = planningLabel(gap.tactics);
    if (label === "Tactic planned") summary.planned += 1;
    else if (label === "Candidate linked") summary.linked += 1;
    else summary.unlinked += 1;
  }
  return summary;
}
