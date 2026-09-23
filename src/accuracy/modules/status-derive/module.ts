import { z } from "zod";
import { mechanicalModule } from "../_factory";
import { deriveGapStatus, gapStatusSchema } from "./engine";

const inputSchema = z.object({
  workspace_id: z.string(),
  gap_ids: z.array(z.string()),
  coverages: z.array(
    z.object({
      gap_id: z.string(),
      tactic_id: z.string(),
      overall: z.enum(["full", "partial", "limited", "not_relevant"]),
      validated: z.boolean(),
    }),
  ),
  tactics: z.array(
    z.object({
      id: z.string(),
      status: z.enum(["completed", "ongoing", "planned", "proposed", "cancelled"]),
    }),
  ),
});

const outputSchema = z.object({
  statuses: z.array(z.object({ gap_id: z.string(), status: gapStatusSchema })),
});

export const statusDeriveModule = mechanicalModule({
  id: "status-derive.engine-v1",
  call_kind: "status_derive",
  title: "Status engine",
  summary: "Compute Open/Partial/Addressed from validated coverage joins.",
  inputSchema,
  outputSchema,
  run: async (input, ctx) => {
    const statuses = input.gap_ids.map((gap_id) => ({
      gap_id,
      status: deriveGapStatus({
        gap_id,
        coverages: input.coverages,
        tactics: input.tactics,
      }),
    }));
    ctx.run.note("status:derived", statuses);
    return { output: { statuses }, summary: `Derived ${statuses.length} gap statuses` };
  },
});

export { deriveGapStatus } from "./engine";
