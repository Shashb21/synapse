import { z } from "zod";
import { agenticModule } from "../_factory";
import { gapsEligibleForIdeation } from "../../domain/iegp-semantics";

const ideationProposalSchema = z.object({
  gap_id: z.string(),
  name: z.string(),
  type: z.string(),
  origin: z.literal("ideated"),
  status: z.literal("proposed"),
  design_summary: z.string(),
  /** Ideated tactics are created net-new — not expected to match reference inventory extract. */
  not_from_reference: z.literal(true),
});

export const ideateModule = agenticModule({
  id: "ideate.agent-v1",
  call_kind: "ideate",
  title: "Ideate",
  summary:
    "Create net-new proposed tactics for validated HIGH-priority open gaps only (not inventory extract).",
  inputSchema: z.object({
    workspace_id: z.string(),
    gaps: z.array(
      z.object({
        id: z.string(),
        status: z.enum(["open", "partial", "addressed"]),
        priority_band: z.enum(["high", "medium", "low"]).nullable(),
      }),
    ),
    existing_tactic_names: z.array(z.string()),
  }),
  outputSchema: z.object({ proposals: z.array(ideationProposalSchema) }),
  run: async (input, ctx) => {
    const eligible = gapsEligibleForIdeation(input.gaps);
    ctx.run.note("ideate:eligible_high_open", eligible.map((g) => g.id));
    return {
      output: { proposals: [] },
      summary: `Ideation stub — ${eligible.length} high-priority open gap(s) eligible`,
    };
  },
});

export { ideationProposalSchema };
