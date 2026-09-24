import { z } from "zod";
import {
  mappingTableRowSchema,
  type MappingStatus,
  type MappingTableRow,
} from "@/modules/stages/s4-kg-mapping/module";
import { listRuns } from "@/modules/kernel/observability";
import { gapEligibleForMapping } from "@/lib/iegp/engine";
import type { IegpState } from "@/lib/iegp/types";

/**
 * One row of the /mappings table. A "proposal" row carries the S4 model's
 * verdict. A "workspace" row is a gap S4 has not mapped yet: its status and
 * confidence are undefined ("not mapped yet"), never invented.
 */
export type MappingTableViewRow = Omit<MappingTableRow, "mapping_status" | "confidence" | "mappings" | "review"> & {
  mapping_status: MappingStatus | undefined;
  confidence: number | undefined;
  mappings: MappingTableRow["mappings"];
  review: MappingTableRow["review"];
  source: "proposal" | "workspace";
  locked_tactic_ids: string[];
};

const storedRows = z.array(mappingTableRowSchema);

/**
 * Rows of the latest successful S4 run. A run whose rows do not carry the model
 * verdict contract (per-tactic coverage, confidence and rationale) is ignored,
 * so older rule-derived statuses are never shown as proposals.
 */
export async function latestS4MappingRows(): Promise<MappingTableRow[] | null> {
  try {
    const runs = await listRuns({ stage: "S4", limit: 20 });
    const ok = runs.find((run) => run.status === "ok" && run.output);
    if (!ok?.output) return null;
    const output = ok.output as { rows?: unknown; accepted?: unknown };
    for (const candidate of [output.rows, output.accepted]) {
      const parsed = storedRows.safeParse(candidate);
      if (parsed.success && parsed.data.length > 0) return parsed.data;
    }
    return null;
  } catch {
    return null;
  }
}

export function buildMappingTableView(state: IegpState, proposed: MappingTableRow[] | null): MappingTableViewRow[] {
  const gaps = state.gaps.filter((gap) => gapEligibleForMapping(gap.status) && !gap.retired);
  const proposedByGap = new Map((proposed ?? []).map((row) => [row.gap_id, row]));
  return gaps.map((gap) => {
    const locked = state.coverages.filter((c) => c.gap_id === gap.id).map((c) => c.tactic_id);
    const proposal = proposedByGap.get(gap.id);
    if (proposal) {
      return {
        ...proposal,
        gap_name: gap.name,
        source: "proposal" as const,
        locked_tactic_ids: locked,
      };
    }
    return {
      gap_id: gap.id,
      gap_name: gap.name,
      tactic_ids: locked,
      tactic_names: locked.map((id) => state.tactics.find((t) => t.id === id)?.name ?? id),
      mapping_status: undefined,
      confidence: undefined,
      rationale: ["Not mapped yet: run S4 for a coverage verdict."],
      mappings: [],
      review: null,
      source: "workspace" as const,
      locked_tactic_ids: locked,
    };
  });
}
