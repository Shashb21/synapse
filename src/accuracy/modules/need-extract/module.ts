import { z } from "zod";
import { agenticModule } from "../_factory";
import { runShallowAgenticCycle } from "../../kernel/agentic";

export const needExtractModule = agenticModule({
  id: "need-extract.agent-v1",
  call_kind: "need_extract",
  title: "Need extract",
  summary: "Evidence gaps from parse blocks (1× PCJ default).",
  inputSchema: z.object({
    workspace_id: z.string(),
    source_file_id: z.string(),
    block_ids: z.array(z.string()),
  }),
  outputSchema: z.object({
    workspace_id: z.string(),
    source_file_id: z.string(),
    items: z.array(z.record(z.string(), z.unknown())),
  }),
  run: async (input, ctx) => {
    const cycle = await runShallowAgenticCycle({
      proposer: async () => ({ items: [] as Record<string, unknown>[] }),
      critic: async () => ({ score: 1, issues: [] }),
      judge: async (d) => d,
    });
    ctx.run.note("agentic:trace", cycle.trace);
    return {
      output: { workspace_id: input.workspace_id, source_file_id: input.source_file_id, items: [] },
      summary: "Need extract stub",
    };
  },
});
