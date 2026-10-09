import type { IegpState } from "@/lib/iegp/types";

type Residual = IegpState["residuals"][number];
type Gap = IegpState["gaps"][number];
type Priority = IegpState["priorities"][number];

export type ResidualRow = { r: Residual; gap: Gap | null; pri: Priority | undefined };

const BAND_RANK = { critical: 0, high: 1, medium: 2, low: 3 } as const;

/**
 * The /residuals list: locked bands first, then by parent name. A residual
 * whose parent gap is gone (deleted, or merged away) still lists, with no
 * parent, instead of crashing the page (KAN-18).
 */
export function residualRows(state: Pick<IegpState, "residuals" | "gaps" | "priorities">): ResidualRow[] {
  const rows = state.residuals.map((r) => ({
    r,
    gap: state.gaps.find((g) => g.id === r.gap_id) ?? null,
    pri: state.priorities.find((p) => p.residual_id === r.id),
  }));
  const rank = (row: ResidualRow) => (row.pri?.lock.locked ? BAND_RANK[row.pri.band] : 8);
  return rows.sort((a, b) => rank(a) - rank(b) || (a.gap?.name ?? "").localeCompare(b.gap?.name ?? ""));
}
