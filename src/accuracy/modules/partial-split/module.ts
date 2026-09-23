import { z } from "zod";
import { agenticModule } from "../_factory";

export const partialSplitModule = agenticModule({
  id: "partial-split.agent-v1",
  call_kind: "partial_split",
  title: "Partial split",
  summary: "Residual gap from partial coverage.",
  inputSchema: z.object({ workspace_id: z.string(), gap_id: z.string() }),
  outputSchema: z.object({
    addressed_gap_id: z.string(),
    open_residual_gap_id: z.string(),
  }),
  run: async (input) => ({
    output: { addressed_gap_id: input.gap_id, open_residual_gap_id: `${input.gap_id}-R` },
    summary: "Partial split stub",
  }),
});

export const prioritizeModule = agenticModule({
  id: "prioritize.agent-v1",
  call_kind: "prioritize",
  title: "Prioritize",
  summary: "H/M/L on validated open gaps.",
  inputSchema: z.object({ workspace_id: z.string(), gap_ids: z.array(z.string()) }),
  outputSchema: z.object({
    placements: z.array(
      z.object({ gap_id: z.string(), band: z.enum(["high", "medium", "low"]) }),
    ),
  }),
  run: async () => ({ output: { placements: [] }, summary: "Prioritize stub" }),
});

export const ideateModule = agenticModule({
  id: "ideate.agent-v1",
  call_kind: "ideate",
  title: "Ideate",
  summary: "Net-new tactics for high-priority open gaps.",
  inputSchema: z.object({ workspace_id: z.string(), gap_ids: z.array(z.string()) }),
  outputSchema: z.object({ proposals: z.array(z.record(z.string(), z.unknown())) }),
  run: async () => ({ output: { proposals: [] }, summary: "Ideation stub" }),
});
