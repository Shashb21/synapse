import { z } from "zod";
import { TACTIC_TYPES } from "@/lib/iegp/enums";

const tacticTypeSchema = z.enum(TACTIC_TYPES);

/** One net-new ideated tactic proposal (not inventory extract). */
export const ideationProposalSchema = z.object({
  gap_id: z.string(),
  name: z.string().min(8).max(280),
  type: tacticTypeSchema,
  origin: z.literal("ideated"),
  status: z.literal("proposed"),
  design_summary: z.string().min(3),
  /** Ideated tactics are created net-new — not expected to match reference inventory extract. */
  not_from_reference: z.literal(true),
  rationale: z.string().min(3),
});

export type IdeationProposal = z.infer<typeof ideationProposalSchema>;

export const ideateInputSchema = z.object({
  workspace_id: z.string(),
  gaps: z.array(
    z.object({
      id: z.string(),
      statement: z.string().optional(),
      status: z.enum(["open", "partial", "addressed"]),
      priority_band: z.enum(["high", "medium", "low"]).nullable(),
    }),
  ),
  existing_tactic_names: z.array(z.string()),
  /** When set, only invent for this gap (must still be high + open). */
  focus_gap_id: z.string().optional(),
  /** Mechanical stub fields / optional LLM hints. */
  mechanical: z
    .object({
      title: z.string().optional(),
      rationale: z.string().optional(),
    })
    .optional(),
});

export type IdeateInput = z.infer<typeof ideateInputSchema>;

export const ideateOutputSchema = z.object({
  mode: z.enum(["llm", "stub"]),
  proposals: z.array(ideationProposalSchema),
});

export type IdeateOutput = z.infer<typeof ideateOutputSchema>;
