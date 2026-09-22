import type { MappingTableRow } from "@/modules/stages/s4-kg-mapping/module";
import type { MappingOutput } from "@/modules/stages/s4-kg-mapping/module";
import { listRuns } from "@/modules/kernel/observability";
import { gapEligibleForMapping } from "@/lib/iegp/engine";
import type { IegpState } from "@/lib/iegp/types";

export type MappingTableViewRow = MappingTableRow & {
  source: "proposal" | "workspace";
  locked_tactic_ids: string[];
};

export async function latestS4MappingRows(): Promise<MappingTableRow[] | null> {
  try {
    const runs = await listRuns({ stage: "S4", limit: 20 });
    const ok = runs.find((run) => run.status === "ok" && run.output);
    if (!ok?.output) return null;
    const output = ok.output as MappingOutput;
    if (output.rows?.length) return output.rows;
    if (output.accepted?.length) return output.accepted;
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
    const tactic_ids = locked;
    const tactic_names = tactic_ids.map((id) => state.tactics.find((t) => t.id === id)?.name ?? id);
    return {
      gap_id: gap.id,
      gap_name: gap.name,
      tactic_ids,
      tactic_names,
      mapping_status: tactic_ids.length === 0 ? "open" : "partially_addressed",
      confidence: tactic_ids.length ? 70 : 0,
      rationale: tactic_ids.length
        ? ["Derived from workspace coverages until S4 is run."]
        : ["No tactics assigned yet."],
      source: "workspace" as const,
      locked_tactic_ids: locked,
    };
  });
}
