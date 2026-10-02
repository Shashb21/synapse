import { z } from "zod";
import { TACTIC_STATUSES, TACTIC_TYPES } from "@/lib/iegp/enums";
import { CLAIM_PRIORITIES, GAP_STATUS_OVERRIDES } from "./claim-edit";

/** Wire schema for a human claim patch (PATCH /api/accuracy/claims). */
export const claimPatchSchema = z
  .object({
    statement: z.string().min(1).optional(),
    external_id: z.string().nullable().optional(),
    provenance_quote: z.string().nullable().optional(),
    priority: z.enum(CLAIM_PRIORITIES).optional(),
    status_override: z.enum(GAP_STATUS_OVERRIDES).nullable().optional(),
    type: z.enum(TACTIC_TYPES).nullable().optional(),
    tactic_status: z.enum(TACTIC_STATUSES).optional(),
    evidence_question: z.string().nullable().optional(),
    design_summary: z.string().nullable().optional(),
    start: z.string().nullable().optional(),
    end: z.string().nullable().optional(),
    readout: z.string().nullable().optional(),
    depends_on: z.array(z.string()).optional(),
  })
  .strict();

/**
 * Older clients still send who they are; the fields are accepted and ignored.
 * Writes are credited to the signed-in owner server-side (api/accuracy/_lib/request.ts).
 */
export const actorFieldsSchema = {
  actor_name: z.string().optional(),
  actor_function: z.string().optional(),
};
