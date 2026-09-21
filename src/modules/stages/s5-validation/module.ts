import { z } from "zod";
import { registerModule } from "@/modules/kernel/registry";
import { recordEdit } from "@/modules/kernel/edit-records";
import type { SynapseModule } from "@/modules/kernel/contracts";
import { MAPPED_GAP_STATUSES } from "@/lib/iegp/enums";
import {
  acceptMapping,
  assignTacticToGap,
  loadState,
  modifyGap,
  modifyTactic,
  overrideGapStatus,
  rejectMapping,
  validateGap,
} from "@/lib/iegp/store";
import { displayedGapStatus } from "@/lib/iegp/engine";

const inputSchema = z.object({
  action: z.enum([
    "classify",
    "validate",
    "edit_gap",
    "edit_tactic",
    "map_tactic",
    "accept_mapping",
    "reject_mapping",
  ]),
  gap_id: z.string().optional(),
  tactic_id: z.string().optional(),
  status: z.enum(MAPPED_GAP_STATUSES).optional(),
  name: z.string().optional(),
  statement: z.string().optional(),
  evidence_question: z.string().optional(),
  /** Locked product rule: every edit at this gate carries a short rationale. */
  rationale: z.string().min(3),
});

const outputSchema = z.object({
  action: z.string(),
  entity_type: z.string(),
  entity_id: z.string(),
  status: z.string().nullable(),
  edit_id: z.string(),
});

export type ValidationInput = z.infer<typeof inputSchema>;
export type ValidationOutput = z.infer<typeof outputSchema>;

export const validationModule: SynapseModule<ValidationInput, ValidationOutput> = {
  manifest: {
    id: "s5-validation.human-gate",
    stage: "S5",
    version: "1.0.0",
    title: "Classification & validation gate",
    summary:
      "The first user touch. Applies a classification, validation, edit or mapping decision and files its rationale as a hillclimb signal.",
    contract: 1,
    agentic: false,
    capabilities: ["rationale-required", "audit-trail"],
  },
  inputSchema,
  outputSchema,
  async run(input, ctx) {
    const before = await loadState();
    const gap = input.gap_id ? before.gaps.find((row) => row.id === input.gap_id) : undefined;
    const tactic = input.tactic_id
      ? before.tactics.find((row) => row.id === input.tactic_id)
      : undefined;

    let entity_type = "gap";
    let entity_id = input.gap_id ?? "";
    let field: string = input.action;
    let beforeValue: string | null = null;
    let afterValue: string | null = null;
    let editAction: "edit" | "accept" | "reject" | "validate" | "override" = "edit";

    switch (input.action) {
      case "classify": {
        if (!input.gap_id || !input.status) throw new Error("gap_id and status are required.");
        await overrideGapStatus({
          gap_id: input.gap_id,
          status: input.status,
          reason: input.rationale,
          actor_name: ctx.actor.name,
          actor_function: ctx.actor.function,
        });
        field = "computed_status";
        beforeValue = gap ? displayedGapStatus(gap) : null;
        afterValue = input.status;
        editAction = "override";
        break;
      }
      case "validate": {
        if (!input.gap_id) throw new Error("gap_id is required.");
        await validateGap({
          gap_id: input.gap_id,
          actor_name: ctx.actor.name,
          actor_function: ctx.actor.function,
          note: input.rationale,
        });
        field = "human_validated";
        beforeValue = "false";
        afterValue = "true";
        editAction = "validate";
        break;
      }
      case "edit_gap": {
        if (!input.gap_id) throw new Error("gap_id is required.");
        await modifyGap({
          gap_id: input.gap_id,
          name: input.name ?? gap?.name ?? "",
          statement: input.statement ?? gap?.statement ?? "",
          actor_name: ctx.actor.name,
          actor_function: ctx.actor.function,
          note: input.rationale,
        });
        field = "statement";
        beforeValue = gap?.statement ?? null;
        afterValue = input.statement ?? gap?.statement ?? null;
        break;
      }
      case "edit_tactic": {
        if (!input.tactic_id) throw new Error("tactic_id is required.");
        await modifyTactic({
          tactic_id: input.tactic_id,
          name: input.name ?? tactic?.name ?? "",
          evidence_question: input.evidence_question ?? tactic?.evidence_question ?? "",
          actor_name: ctx.actor.name,
          actor_function: ctx.actor.function,
          note: input.rationale,
        });
        entity_type = "tactic";
        entity_id = input.tactic_id;
        field = "evidence_question";
        beforeValue = tactic?.evidence_question ?? null;
        afterValue = input.evidence_question ?? null;
        break;
      }
      case "map_tactic": {
        if (!input.gap_id || !input.tactic_id) throw new Error("gap_id and tactic_id are required.");
        await assignTacticToGap({
          gap_id: input.gap_id,
          tactic_id: input.tactic_id,
          actor_name: ctx.actor.name,
          actor_function: ctx.actor.function,
          note: input.rationale,
        });
        field = "mapping";
        afterValue = input.tactic_id;
        editAction = "accept";
        break;
      }
      case "accept_mapping":
      case "reject_mapping": {
        if (!input.gap_id || !input.tactic_id) throw new Error("gap_id and tactic_id are required.");
        const apply = input.action === "accept_mapping" ? acceptMapping : rejectMapping;
        await apply({
          gap_id: input.gap_id,
          tactic_id: input.tactic_id,
          actor_name: ctx.actor.name,
          actor_function: ctx.actor.function,
          note: input.rationale,
        });
        field = "mapping";
        afterValue = input.tactic_id;
        editAction = input.action === "accept_mapping" ? "accept" : "reject";
        break;
      }
    }

    const edit = await recordEdit({
      workspace_id: ctx.workspace_id,
      stage: "S5",
      entity_type,
      entity_id,
      field,
      action: editAction,
      before: beforeValue,
      after: afterValue,
      rationale: input.rationale,
      actor: ctx.actor,
    });

    const after = await loadState();
    const updated = input.gap_id ? after.gaps.find((row) => row.id === input.gap_id) : undefined;

    return {
      output: {
        action: input.action,
        entity_type,
        entity_id,
        status: updated ? displayedGapStatus(updated) : null,
        edit_id: edit.id,
      },
      summary: `${input.action.replace(/_/g, " ")} on ${entity_id || entity_type} — "${input.rationale}"`,
      evals: [{ name: "rationale_chars", value: input.rationale.trim().length, unit: "count", target: 10 }],
    };
  },
};

registerModule(validationModule);
