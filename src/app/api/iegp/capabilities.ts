import type { Capability } from "@/modules/auth/roles";

/**
 * What each action needs (REQ-AUTH-006). Every action here writes; reads go
 * through the pages. Viewers hold none of these. Reset wipes the workspace, so
 * only Medical Affairs (and the platform operator) may do it.
 */
export const IEGP_ACTION_CAPABILITY: Record<string, Capability> = {
  reset: "reset_workspace",
  ingest: "upload",
  ingest_demo: "upload",
  lock_priority: "prioritize",
  create_tactic: "ideate",
  record_missed_tactic: "ideate",
  promote_tactic_candidate: "ideate",
  lock_tactic: "ideate",
  lock_tactic_review: "ideate",
  modify_tactic: "ideate",
  unlock_tactics: "ideate",
  // Everything else is an edit with rationale: needs, gaps, mappings, coverage,
  // residuals, setup, roadmap and breakout groups.
  ...Object.fromEntries(
    [
      "lock_need",
      "create_need",
      "edit_need",
      "unlink_need",
      "move_need",
      "promote_gap_candidate",
      "lock_gap",
      "classify_gap",
      "override_gap_status",
      "clear_gap_status_override",
      "park_gap",
      "unpark_gap",
      "lock_dimension",
      "lock_overall",
      "confirm_coverage_review",
      "lock_residual",
      "assign_tactic",
      "unassign_tactic",
      "accept_mapping",
      "reject_mapping",
      "save_mapping_row",
      "accept_residual_gap",
      "reject_residual_gap",
      "modify_residual_gap",
      "create_gap",
      "modify_gap",
      "complete_wizard",
      "save_product_setup",
      "validate_gap",
      "split_partial_gap",
      "rewrite_partial_gap",
      "create_addressed_gap",
      "lock_roadmap",
      "create_breakout_group",
      "delete_breakout_group",
      "assign_gap_to_breakout",
      "unassign_gap_from_breakout",
    ].map((action) => [action, "validate" as Capability]),
  ),
};

/** The capability an /api/iegp action needs; undefined for an unknown action. */
export function iegpActionCapability(action: string): Capability | undefined {
  return Object.hasOwn(IEGP_ACTION_CAPABILITY, action) ? IEGP_ACTION_CAPABILITY[action] : undefined;
}
