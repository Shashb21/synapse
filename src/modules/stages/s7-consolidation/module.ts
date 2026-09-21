import { z } from "zod";
import { registerModule } from "@/modules/kernel/registry";
import type { SynapseModule } from "@/modules/kernel/contracts";
import { loadState } from "@/lib/iegp/store";
import { countingCoverages, displayedGapStatus, isLiveGap, mappedTactics } from "@/lib/iegp/engine";

const inputSchema = z.object({}).default({});

const listItem = z.object({
  gap_id: z.string(),
  name: z.string(),
  statement: z.string(),
  domain: z.string(),
  human_validated: z.boolean(),
  tactic_ids: z.array(z.string()),
  need_count: z.number(),
});

const outputSchema = z.object({
  open: z.array(listItem),
  addressed: z.array(listItem),
  unresolved_partials: z.array(z.object({ gap_id: z.string(), name: z.string() })),
  flags: z.array(z.object({ code: z.string(), gap_id: z.string().nullable(), detail: z.string() })),
  ready_for_prioritization: z.boolean(),
});

export type ConsolidationInput = z.infer<typeof inputSchema>;
export type ConsolidationOutput = z.infer<typeof outputSchema>;

export const consolidationModule: SynapseModule<ConsolidationInput, ConsolidationOutput> = {
  manifest: {
    id: "s7-consolidation.derived",
    stage: "S7",
    version: "1.0.0",
    title: "Open / addressed consolidation",
    summary:
      "Derives the definitive open and addressed lists from validated state and flags inconsistencies. Writes nothing.",
    contract: 1,
    agentic: false,
    capabilities: ["consistency-flags"],
  },
  inputSchema,
  outputSchema,
  async run(_input, ctx) {
    const state = await loadState();
    const live = state.gaps.filter(isLiveGap);
    const open: ConsolidationOutput["open"] = [];
    const addressed: ConsolidationOutput["addressed"] = [];
    const unresolved_partials: ConsolidationOutput["unresolved_partials"] = [];
    const flags: ConsolidationOutput["flags"] = [];

    for (const gap of live) {
      const status = displayedGapStatus(gap);
      const needCount = state.need_gap_links.filter((link) => link.gap_id === gap.id).length;
      const item = {
        gap_id: gap.id,
        name: gap.name,
        statement: gap.statement,
        domain: gap.domain,
        human_validated: gap.human_validated,
        tactic_ids: mappedTactics(state, gap.id).map((tactic) => tactic.id),
        need_count: needCount,
      };
      if (status === "validated_open") open.push(item);
      if (status === "validated_addressed") addressed.push(item);
      if (status === "validated_partial") {
        unresolved_partials.push({ gap_id: gap.id, name: gap.name });
        flags.push({
          code: "partial_unresolved",
          gap_id: gap.id,
          detail: "Partially Addressed cannot enter the validated set. Split or rewrite it.",
        });
      }
      if (needCount === 0) {
        flags.push({
          code: "gap_without_provenance",
          gap_id: gap.id,
          detail: "No constituent need is linked, so this gap has no source provenance.",
        });
      }
      if (!gap.human_validated && status !== "candidate") {
        flags.push({
          code: "not_validated",
          gap_id: gap.id,
          detail: "Awaiting the S5 validation gate.",
        });
      }
      if (gap.status_override?.stale) {
        flags.push({
          code: "stale_override",
          gap_id: gap.id,
          detail: "A human override went stale after new evidence arrived.",
        });
      }
      if (
        status === "validated_addressed" &&
        countingCoverages(
          state.coverages.filter((coverage) => coverage.gap_id === gap.id),
          state.tactics,
        ).length === 0
      ) {
        flags.push({
          code: "addressed_without_evidence",
          gap_id: gap.id,
          detail: "Marked Addressed with no completed, ongoing or planned tactic and no literature.",
        });
      }
    }

    ctx.run.note("lists", { open: open.length, addressed: addressed.length, flags: flags.length });
    const ready = unresolved_partials.length === 0 && live.every((gap) => gap.human_validated);

    return {
      output: {
        open,
        addressed,
        unresolved_partials,
        flags,
        ready_for_prioritization: ready,
      },
      summary: `${open.length} open, ${addressed.length} addressed, ${flags.length} flag(s)`,
      evals: [
        {
          name: "validated_share",
          value: live.length === 0 ? 0 : Number((live.filter((gap) => gap.human_validated).length / live.length).toFixed(3)),
          unit: "ratio",
          target: 1,
        },
        { name: "unresolved_partials", value: unresolved_partials.length, unit: "count" },
        {
          name: "provenance_complete",
          value:
            live.length === 0
              ? 0
              : Number(
                  (
                    live.filter((gap) =>
                      state.need_gap_links.some((link) => link.gap_id === gap.id),
                    ).length / live.length
                  ).toFixed(3),
                ),
          unit: "ratio",
          target: 1,
        },
      ],
    };
  },
};

registerModule(consolidationModule);
