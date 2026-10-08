import { z } from "zod";
import {
  mappingTableRowSchema,
  type MappingStatus,
  type MappingTableRow,
} from "@/modules/stages/s4-kg-mapping/module";
import { listRuns } from "@/modules/kernel/observability";
import { displayedGapStatus, gapEligibleForMapping } from "@/lib/iegp/engine";
import { humanMappingRow, isMappingRowKey } from "@/lib/iegp/store";
import type { IegpState, Lock } from "@/lib/iegp/types";

/** A person's decision on one gap ↔ tactic pair (accept, map, reject or remove). */
export type PairDecision = {
  status: "accepted" | "rejected";
  actor_name: string | null;
  note: string | null;
};

/**
 * One row of the /mappings table.
 * - "human": a person saved this row; its status and tactic set win over any S4 run.
 * - "proposal": the latest S4 run's verdict, waiting for a person to accept or reject each tactic.
 * - "workspace": a gap S4 has not mapped yet: status and confidence are undefined
 *   ("not mapped yet"), never invented.
 */
export type MappingTableViewRow = Omit<MappingTableRow, "mapping_status" | "confidence" | "mappings" | "review"> & {
  mapping_status: MappingStatus | undefined;
  confidence: number | undefined;
  mappings: MappingTableRow["mappings"];
  review: MappingTableRow["review"];
  source: "proposal" | "workspace" | "human";
  locked_tactic_ids: string[];
  /** Human decisions per tactic id for this gap. */
  decisions: Record<string, PairDecision>;
  /** Set when source is "human": who saved the row and when. */
  human_lock: Lock | null;
  /** Tactics mapped (e.g. by a later S4 run) that no person has accepted yet. */
  unreviewed_tactic_ids: string[];
  /**
   * The gap's status as the engine computes it from recorded coverage (proposed
   * tactics don't count), the same status the gap page shows. This is the row's
   * status; `mapping_status` is the AI's (or the saved row's) view (KAN-68).
   */
  gap_status: MappingStatus;
};

const GAP_TO_MAPPING_STATUS: Record<string, MappingStatus> = {
  validated_open: "open",
  validated_partial: "partially_addressed",
  validated_addressed: "addressed",
};

const storedRows = z.array(mappingTableRowSchema);

/**
 * Rows of the latest successful S4 run. A run whose rows do not carry the model
 * verdict contract (per-tactic coverage, confidence and rationale) is ignored,
 * so older rule-derived statuses are never shown as proposals.
 */
export async function latestS4MappingRows(): Promise<(MappingTableRow & { origin_run_id?: string })[] | null> {
  try {
    const runs = await listRuns({ stage: "S4", limit: 20 });
    // The newest successful run whose rows were stored whole: an output cut to a
    // preview by an older size bound is skipped, not shown as "not mapped" (KAN-68).
    for (const run of runs) {
      if (run.status !== "ok" || !run.output) continue;
      const output = run.output as { rows?: unknown; accepted?: unknown };
      for (const candidate of [output.rows, output.accepted]) {
        const parsed = storedRows.safeParse(candidate);
        if (parsed.success && parsed.data.length > 0) return parsed.data.map(row => ({ ...row, origin_run_id: run.id }));
      }
    }
    return null;
  } catch {
    return null;
  }
}

function decisionsFor(state: IegpState, gapId: string): Record<string, PairDecision> {
  const out: Record<string, PairDecision> = {};
  for (const m of state.mapping_suggestions) {
    if (m.gap_id !== gapId || isMappingRowKey(m.tactic_id) || !m.lock.locked) continue;
    out[m.tactic_id] = { status: m.status, actor_name: m.lock.actor_name, note: m.lock.note };
  }
  return out;
}

export const UNMAPPED_RATIONALE_AI = "Not mapped yet: choose Re-run mapping for a coverage verdict, or map tactics by hand.";
export const UNMAPPED_RATIONALE_MANUAL = "Not mapped yet: pick the tactics and a status by hand.";

export function buildMappingTableView(
  state: IegpState,
  proposed: MappingTableRow[] | null,
  options: { ai?: boolean } = {},
): MappingTableViewRow[] {
  const ai = options.ai !== false;
  const gaps = state.gaps.filter((gap) => gapEligibleForMapping(gap.status) && !gap.retired);
  const proposedByGap = new Map((proposed ?? []).map((row) => [row.gap_id, row]));
  const tacticName = (id: string) => state.tactics.find((t) => t.id === id)?.name ?? id;
  return gaps.map((gap) => {
    const locked = state.coverages.filter((c) => !c.expansion_id && c.gap_id === gap.id).map((c) => c.tactic_id);
    const decisions = decisionsFor(state, gap.id);
    const unreviewed = locked.filter((id) => decisions[id]?.status !== "accepted");
    const human = humanMappingRow(state, gap.id);
    const gap_status = GAP_TO_MAPPING_STATUS[displayedGapStatus(gap)] ?? "open";
    if (human) {
      // The person's row wins over the latest S4 run.
      return {
        gap_id: gap.id,
        gap_name: gap.name,
        tactic_ids: locked,
        tactic_names: locked.map(tacticName),
        mapping_status: human.mapping_status,
        confidence: undefined,
        rationale: [human.rationale],
        mappings: [],
        review: null,
        source: "human" as const,
        locked_tactic_ids: locked,
        decisions,
        human_lock: human.lock,
        unreviewed_tactic_ids: unreviewed,
        gap_status,
      };
    }
    const proposal = proposedByGap.get(gap.id);
    if (proposal) {
      return {
        ...proposal,
        gap_name: gap.name,
        source: "proposal" as const,
        locked_tactic_ids: locked,
        decisions,
        human_lock: null,
        unreviewed_tactic_ids: unreviewed,
        gap_status,
      };
    }
    return {
      gap_id: gap.id,
      gap_name: gap.name,
      tactic_ids: locked,
      tactic_names: locked.map(tacticName),
      mapping_status: undefined,
      confidence: undefined,
      rationale: [ai ? UNMAPPED_RATIONALE_AI : UNMAPPED_RATIONALE_MANUAL],
      mappings: [],
      review: null,
      source: "workspace" as const,
      locked_tactic_ids: locked,
      decisions,
      human_lock: null,
      unreviewed_tactic_ids: unreviewed,
      gap_status,
    };
  });
}
