import { z } from "zod";
import { mechanicalModule } from "../_factory";

export const validationGateModule = mechanicalModule({
  id: "validation-gate.human-v1",
  call_kind: "validation_gate",
  title: "Validation gate",
  summary: "Promote draft claims; rationale required on edits.",
  inputSchema: z.object({
    workspace_id: z.string(),
    claim_ids: z.array(z.string()),
    action: z.enum(["validate", "reject"]),
    rationale: z.string().min(1),
  }),
  outputSchema: z.object({ validated: z.number().int() }),
  run: async (input, ctx) => {
    ctx.run.note("validation", input);
    return { output: { validated: input.claim_ids.length }, summary: "Validation recorded" };
  },
});
