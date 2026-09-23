import { z } from "zod";
import { agenticModule } from "../_factory";
import { runShallowAgenticCycle } from "../../kernel/agentic";

const emptyOut = z.object({
  workspace_id: z.string(),
  source_file_id: z.string().optional(),
  items: z.array(z.record(z.string(), z.unknown())),
});

export const inventoryExtractModule = agenticModule({
  id: "inventory-extract.agent-v1",
  call_kind: "inventory_extract",
  title: "Inventory extract",
  summary: "Tactic inventory from parse blocks (1× PCJ default).",
  inputSchema: z.object({
    workspace_id: z.string(),
    source_file_id: z.string(),
    block_ids: z.array(z.string()),
  }),
  outputSchema: emptyOut,
  run: async (input, ctx) => {
    const cycle = await runShallowAgenticCycle({
      proposer: async () => ({ items: [] as Record<string, unknown>[] }),
      critic: async () => ({ score: 1, issues: [] }),
      judge: async (d) => d,
    });
    ctx.run.note("agentic:trace", cycle.trace);
    return {
      output: { workspace_id: input.workspace_id, source_file_id: input.source_file_id, items: [] },
      summary: "Inventory extract stub (await reference gold wiring)",
    };
  },
});
