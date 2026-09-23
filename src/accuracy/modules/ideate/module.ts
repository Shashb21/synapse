import { agenticModule } from "../_factory";
import { runIdeate } from "./run";
import { ideateInputSchema, ideateOutputSchema } from "./schema";

export { ideationProposalSchema, ideateInputSchema, ideateOutputSchema } from "./schema";
export type { IdeateInput, IdeateOutput, IdeationProposal } from "./schema";
export { ideateRouteAllowsLlm } from "./route-allows";
export { mechanicalIdeateProposal, runIdeate } from "./run";
export { IDEATE_PROPOSER_SYSTEM, ideateProposerUser } from "./prompts";

export const ideateModule = agenticModule({
  id: "ideate.agent-v1",
  call_kind: "ideate",
  title: "Ideate",
  summary:
    "Create net-new proposed tactics for validated HIGH-priority open gaps only (not inventory extract).",
  inputSchema: ideateInputSchema,
  outputSchema: ideateOutputSchema,
  run: async (input, ctx) => {
    const result = await runIdeate(input, ctx);
    ctx.run.note("ideate:mode", result.output.mode);
    return { output: result.output, summary: result.summary };
  },
});
