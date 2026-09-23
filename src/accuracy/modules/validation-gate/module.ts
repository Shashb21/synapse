import { z } from "zod";
import { mechanicalModule } from "../_factory";
import { applyClaimValidation } from "@/accuracy/store/claim-store";

export const validationGateModule = mechanicalModule({
  id: "validation-gate.human-v1",
  call_kind: "validation_gate",
  title: "Validation gate",
  summary: "Promote draft claims; rationale required on edits.",
  inputSchema: z.object({
    workspace_id: z.string(),
    claim_ids: z.array(z.string()).min(1),
    action: z.enum(["validate", "reject"]),
    rationale: z.string().min(1),
  }),
  outputSchema: z.object({
    validated: z.number().int(),
    claim_ids: z.array(z.string()),
    action: z.enum(["validate", "reject"]),
  }),
  run: async (input, ctx) => {
    const result = await applyClaimValidation({
      workspace_id: input.workspace_id,
      claim_ids: input.claim_ids,
      action: input.action,
      rationale: input.rationale,
      actor: ctx.actor,
    });
    ctx.run.note("validation", {
      action: input.action,
      claim_ids: input.claim_ids,
      rationale: input.rationale.trim(),
      updated: result.updated,
    });
    return {
      output: {
        validated: result.updated,
        claim_ids: result.claims.map((c) => c.id),
        action: input.action,
      },
      summary:
        input.action === "validate"
          ? `Validated ${result.updated} claim(s)`
          : `Rejected ${result.updated} claim(s)`,
    };
  },
});
