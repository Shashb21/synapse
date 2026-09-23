import {
  asTacticLifecycle,
  deriveWorkspaceGapStatuses,
  type GapStatus,
} from "@/accuracy/modules/status-derive/engine";

export const UNASSIGNED_BOARD_ID = "unassigned";
export const UNASSIGNED_BOARD_LABEL = "Unassigned";

export type WorkshopCoverageStatus = GapStatus;
export type WorkshopScene = "gaps" | "prioritize";

export type WorkshopGapLite = {
  id: string;
  statement: string;
  validated: boolean;
  status: string;
  coverage_status: WorkshopCoverageStatus;
  priority: string | null;
  source_badge: string | null;
};

export type WorkshopTacticLite = {
  id: string;
  statement: string;
  validated: boolean;
  origin: string | null;
  tactic_status: string | null;
};

export type WorkshopJoinLite = {
  id: string;
  gap_id: string;
  tactic_id: string;
  overall: string;
  validated: boolean;
  rationale: string | null;
};

export type WorkshopInventory = {
  workspace_id: string;
  captured_at: string;
  gaps: WorkshopGapLite[];
  tactics: WorkshopTacticLite[];
  joins: WorkshopJoinLite[];
};

export type WorkshopReadiness = {
  ready: boolean;
  blockers: string[];
  live_gap_count: number;
  unvalidated_gap_count: number;
  partial_gap_ids: string[];
};

export type FacilitatorTag = {
  id: string;
  label: string;
};

export type FacilitatorTagState = {
  tags: FacilitatorTag[];
  /** gap_id → tag_id. Missing / unknown / unassigned → Unassigned board. */
  assignments: Record<string, string>;
};

export type WorkshopGapView = WorkshopGapLite & { parked: boolean };

export type WorkshopBoard = {
  id: string;
  label: string;
  gaps: WorkshopGapView[];
};

export type WorkshopGapOverlay = {
  coverage_status?: WorkshopCoverageStatus;
  parked?: boolean;
  park_rationale?: string;
  parked_at?: string;
  parked_by?: string;
  priority?: string | null;
  priority_rationale?: string;
};

export type WorkshopActionKind = "mark_addressed" | "remap" | "park" | "set_priority";

export type WorkshopActionLog = {
  id: string;
  kind: WorkshopActionKind;
  gap_id: string;
  rationale: string;
  origin: "workshop";
  at: string;
  by: string;
  detail?: Record<string, unknown>;
};

export type WorkshopSnapshotPayload = {
  inventory: WorkshopInventory;
  facilitator_tags: FacilitatorTagState;
  overlays: Record<string, WorkshopGapOverlay>;
  actions: WorkshopActionLog[];
  scene: WorkshopScene;
};

export function emptyFacilitatorTags(): FacilitatorTagState {
  return { tags: [], assignments: {} };
}

export function emptyWorkshopPayload(inventory: WorkshopInventory): WorkshopSnapshotPayload {
  return {
    inventory,
    facilitator_tags: emptyFacilitatorTags(),
    overlays: {},
    actions: [],
    scene: "gaps",
  };
}

/** Live gaps: skip merged/rejected. */
export function isLiveWorkshopGap(status: string): boolean {
  return status !== "merged" && status !== "rejected";
}

export function coverageStatusFromJoins(args: {
  gap_ids: string[];
  joins: Array<{ gap_id: string; tactic_id: string; overall: string; validated: boolean }>;
  tactics: Array<{ id: string; tactic_status?: string | null; status?: string | null }>;
  overrides?: Record<string, GapStatus | null | undefined>;
}): Record<string, WorkshopCoverageStatus> {
  const tacticLites = args.tactics.flatMap((tactic) => {
    const status =
      asTacticLifecycle(tactic.tactic_status) ?? asTacticLifecycle(tactic.status) ?? "planned";
    return [{ id: tactic.id, status }];
  });
  const rows = deriveWorkspaceGapStatuses({
    gap_ids: args.gap_ids,
    coverages: args.joins,
    tactics: tacticLites,
    overrides: args.overrides,
  });
  return Object.fromEntries(rows.map((row) => [row.gap_id, row.status]));
}

/**
 * Snapshot CTA gate: every live gap validated; no blocking Partial residuals.
 * Open and Addressed are workshop-ready.
 */
export function evaluateWorkshopReadiness(args: {
  gaps: Array<{
    id: string;
    validated: boolean;
    status: string;
    coverage_status: WorkshopCoverageStatus;
  }>;
}): WorkshopReadiness {
  const live = args.gaps.filter((gap) => isLiveWorkshopGap(gap.status));
  const blockers: string[] = [];
  if (live.length === 0) {
    blockers.push("No live gaps to freeze for workshop.");
  }
  const unvalidated = live.filter((gap) => !gap.validated);
  if (unvalidated.length > 0) {
    blockers.push(
      `${unvalidated.length} live gap(s) are not validated — finish Ledger validation first.`,
    );
  }
  const partial = live.filter((gap) => gap.coverage_status === "partial");
  if (partial.length > 0) {
    blockers.push(
      `${partial.length} gap(s) remain Partially Addressed — split or rewrite before workshop.`,
    );
  }
  return {
    ready: blockers.length === 0,
    blockers,
    live_gap_count: live.length,
    unvalidated_gap_count: unvalidated.length,
    partial_gap_ids: partial.map((gap) => gap.id),
  };
}

export function effectiveGapView(
  gap: WorkshopGapLite,
  overlay: WorkshopGapOverlay | undefined,
): WorkshopGapView {
  return {
    ...gap,
    coverage_status: overlay?.coverage_status ?? gap.coverage_status,
    priority: overlay?.priority !== undefined ? overlay.priority : gap.priority,
    parked: Boolean(overlay?.parked),
  };
}

/** Gaps scene: one facilitator tag = one board. Unassigned is last. Never chapter/SI-only. */
export function boardsFromFacilitatorTags(
  gaps: WorkshopGapLite[],
  tags: FacilitatorTagState,
  overlays: Record<string, WorkshopGapOverlay> = {},
): WorkshopBoard[] {
  const viewed = gaps.map((gap) => effectiveGapView(gap, overlays[gap.id]));
  const known = new Map(tags.tags.map((tag) => [tag.id, tag]));
  const boards: WorkshopBoard[] = tags.tags.map((tag) => ({
    id: tag.id,
    label: tag.label,
    gaps: [],
  }));
  const unassigned: WorkshopBoard = {
    id: UNASSIGNED_BOARD_ID,
    label: UNASSIGNED_BOARD_LABEL,
    gaps: [],
  };
  for (const gap of viewed) {
    const tagId = tags.assignments[gap.id];
    const board =
      tagId && tagId !== UNASSIGNED_BOARD_ID && known.has(tagId)
        ? boards.find((b) => b.id === tagId) ?? unassigned
        : unassigned;
    board.gaps.push(gap);
  }
  return [...boards, unassigned];
}

/** Prioritize scene: H / M / L / unbanded on Open (not parked) gaps. */
export function boardsFromPriorityBands(
  gaps: WorkshopGapLite[],
  overlays: Record<string, WorkshopGapOverlay> = {},
): WorkshopBoard[] {
  const bands: WorkshopBoard[] = [
    { id: "band_high", label: "High", gaps: [] },
    { id: "band_medium", label: "Medium", gaps: [] },
    { id: "band_low", label: "Low", gaps: [] },
    { id: "band_unbanded", label: "Unbanded", gaps: [] },
  ];
  for (const gap of gaps) {
    const viewed = effectiveGapView(gap, overlays[gap.id]);
    if (viewed.parked) continue;
    if (viewed.coverage_status !== "open") continue;
    const band = String(viewed.priority ?? "")
      .trim()
      .toLowerCase();
    const target =
      band === "high" || band === "critical"
        ? bands[0]
        : band === "medium"
          ? bands[1]
          : band === "low"
            ? bands[2]
            : bands[3];
    target.gaps.push(viewed);
  }
  return bands;
}

export function normalizeTagLabel(label: string): string {
  return label.trim().replace(/\s+/g, " ");
}

export function assignGapToTag(
  state: FacilitatorTagState,
  gap_id: string,
  tag_id: string,
): FacilitatorTagState {
  const next = {
    tags: state.tags.map((tag) => ({ ...tag })),
    assignments: { ...state.assignments },
  };
  if (!tag_id || tag_id === UNASSIGNED_BOARD_ID) {
    delete next.assignments[gap_id];
    return next;
  }
  if (!next.tags.some((tag) => tag.id === tag_id)) {
    throw new Error("Unknown facilitator tag.");
  }
  next.assignments[gap_id] = tag_id;
  return next;
}
