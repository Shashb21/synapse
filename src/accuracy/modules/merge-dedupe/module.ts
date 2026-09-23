import { z } from "zod";
import { mechanicalModule } from "../_factory";

export const mergeDedupeModule = mechanicalModule({
  id: "merge-dedupe.local-v1",
  call_kind: "merge_dedupe",
  title: "Merge dedupe",
  summary: "Study-ID aware merge of inventory + need candidates.",
  inputSchema: z.object({ workspace_id: z.string() }),
  outputSchema: z.object({ workspace_id: z.string(), merged: z.number().int() }),
  run: async (input) => ({
    output: { workspace_id: input.workspace_id, merged: 0 },
    summary: "Merge dedupe stub",
  }),
});

export const pairGenerateModule = mechanicalModule({
  id: "pair-generate.local-v1",
  call_kind: "pair_generate",
  title: "Pair generator",
  summary: "Deterministic gap↔tactic pair candidates.",
  inputSchema: z.object({ workspace_id: z.string() }),
  outputSchema: z.object({ pairs: z.array(z.object({ gap_id: z.string(), tactic_id: z.string() })) }),
  run: async () => ({ output: { pairs: [] }, summary: "Pair generator stub" }),
});

export const ganttProjectModule = mechanicalModule({
  id: "gantt-project.local-v1",
  call_kind: "gantt_project",
  title: "Gantt projection",
  summary: "Deterministic timeline from validated tactics only.",
  inputSchema: z.object({ workspace_id: z.string() }),
  outputSchema: z.object({
    activities: z.array(
      z.object({
        id: z.string(),
        tactic_id: z.string(),
        start: z.string(),
        end: z.string(),
        depends_on: z.array(z.string()),
      }),
    ),
  }),
  run: async () => ({ output: { activities: [] }, summary: "Gantt projection stub" }),
});
