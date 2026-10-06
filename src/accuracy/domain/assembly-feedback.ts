/** Typed operational observations about historically consumed approved assemblies. */
import type { Actor } from "@/accuracy/kernel/contracts";

export const ASSEMBLY_FEEDBACK_CATEGORIES = [
  "accepted_unchanged", "edited", "rejected", "missing_item", "split_merge", "override",
] as const;

export type AssemblyFeedbackCategory = typeof ASSEMBLY_FEEDBACK_CATEGORIES[number];

export type AssemblyFeedbackContributor = {
  subject: string;
  provider: string;
  actor: Actor;
};

export type AssemblyFeedbackInput = {
  workspace_id: string;
  assembly_id: string;
  expected_fingerprint: string;
  approval_review_id: string;
  consumer_run_id: string;
  selected_item_version_ids?: string[];
  category: AssemblyFeedbackCategory;
  rationale: string;
  contributor: AssemblyFeedbackContributor;
};

export type AssemblyFeedbackEvidence = {
  source_file_id: string;
  block_id: string;
  quote: string;
};

export type AssemblyFeedbackItem = {
  item_version_id: string;
  claim_type: "gap" | "tactic";
  source_file_id: string;
  evidence: AssemblyFeedbackEvidence[];
};

export type AssemblyFeedback = {
  id: string;
  workspace_id: string;
  assembly_id: string;
  assembly_fingerprint: string;
  approval_review_id: string;
  consumer_run_id: string;
  selected_item_version_ids: string[];
  items: AssemblyFeedbackItem[];
  category: AssemblyFeedbackCategory;
  rationale: string;
  actor_subject: string;
  actor_provider: string;
  actor_name: string;
  actor_function: string;
  created_at: string;
};

export type AssemblyFeedbackRun = {
  run_id: string;
  created_at: string;
  approval_review_id: string;
  consumed_item_version_ids: string[];
};

export type AssemblyFeedbackErrorCode = "invalid_input" | "not_found" | "conflict";

/** A request or historical consumption proof is invalid for feedback. */
export class AssemblyFeedbackError extends Error {
  constructor(readonly code: AssemblyFeedbackErrorCode, message: string) {
    super(message);
    this.name = "AssemblyFeedbackError";
  }
}

function required(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new AssemblyFeedbackError("invalid_input", `${label} is required.`);
  }
  return value.trim();
}

/** Validate form fields before the transactional historical proof check. */
export function validateAssemblyFeedbackInput(input: AssemblyFeedbackInput): AssemblyFeedbackInput {
  if (!input || typeof input !== "object") {
    throw new AssemblyFeedbackError("invalid_input", "Feedback input is required.");
  }
  const ids = input.selected_item_version_ids ?? [];
  if (!Array.isArray(ids) || ids.some(id => typeof id !== "string" || !id.trim()) || new Set(ids).size !== ids.length) {
    throw new AssemblyFeedbackError("invalid_input", "Selected item versions must be distinct nonempty IDs.");
  }
  if (!ASSEMBLY_FEEDBACK_CATEGORIES.includes(input.category)) {
    throw new AssemblyFeedbackError("invalid_input", "Feedback category is unsupported.");
  }
  return {
    workspace_id: required(input.workspace_id, "Workspace"),
    assembly_id: required(input.assembly_id, "Assembly"),
    expected_fingerprint: required(input.expected_fingerprint, "Assembly fingerprint"),
    approval_review_id: required(input.approval_review_id, "Approval review"),
    consumer_run_id: required(input.consumer_run_id, "Consumer run"),
    selected_item_version_ids: ids,
    category: input.category,
    rationale: required(input.rationale, "Feedback rationale"),
    contributor: {
      subject: required(input.contributor?.subject, "Contributor subject"),
      provider: required(input.contributor?.provider, "Contributor provider"),
      actor: {
        name: required(input.contributor?.actor?.name, "Contributor name"),
        function: required(input.contributor?.actor?.function, "Contributor function") as Actor["function"],
      },
    },
  };
}
