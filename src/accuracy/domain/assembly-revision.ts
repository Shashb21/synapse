/** Strict contributor change contracts and immutable revision lineage. */
import { z } from "zod";
import type { Actor } from "@/accuracy/kernel/contracts";
import { needGapSchema } from "@/accuracy/modules/need-extract/module";
import { inventoryTacticSchema } from "@/accuracy/modules/inventory-extract/module";

const reason = z.string().trim().min(1);
const id = z.string().trim().min(1);
const gap = needGapSchema.omit({ id: true }).extend({ statement: reason }).strict();
const tactic = inventoryTacticSchema.omit({ id: true }).extend({ name: reason, evidence_question: reason }).strict();
const content = z.discriminatedUnion("claim_type", [
  z.object({ claim_type: z.literal("gap"), source_file_id: id, payload: gap }).strict(),
  z.object({ claim_type: z.literal("tactic"), source_file_id: id, payload: tactic }).strict(),
]);
export const assemblyRevisionChangeSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("add"), reason, content }).strict(),
  z.object({ action: z.literal("edit"), reason, item_version_id: id, content }).strict(),
  z.object({ action: z.literal("remove"), reason, item_version_id: id }).strict(),
]);
export type AssemblyRevisionChange = z.infer<typeof assemblyRevisionChangeSchema>;
export type AssemblyRevisionAuthor = { subject: string; provider: string; actor: Actor; role: "contributor" };
export type AssemblyRevision = {
  id: string; workspace_id: string; baseline_assembly_id: string; parent_assembly_id: string;
  action: AssemblyRevisionChange["action"]; reason: string; author: AssemblyRevisionAuthor;
  predecessor_version_id: string | null; successor_version_id: string | null;
  source_file_id: string; provenance: unknown[]; created_at: string;
};
export type AssemblyRevisionState = {
  revision: AssemblyRevision | null; baseline_assembly_id: string;
  current_head_id: string; is_current: boolean; linking_error: string | null;
  can_retry: boolean;
};
