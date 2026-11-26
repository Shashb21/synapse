/** Synthetic, attributable S8 evidence for prompt-revision tests. */
import { buildBlankWorkspace } from "@/lib/iegp/blank";
import { frozenPriorityReviewHash } from "@/modules/stages/s8-prioritization/review-basis";
import { DEFAULT_AXES } from "@/modules/stages/s8-prioritization/axes";
import type { ResolvedRoute } from "@/modules/kernel/contracts";
import type { DecisionExample } from "@/modules/kernel/decision-examples";

export function priorityReviewExample(i: number, modelRoute: ResolvedRoute, workspaceId = "fiction"): DecisionExample {
  const gap = {
    id: "gap-" + i,
    statement: "Independent panel question " + i,
    objective_id: "obj",
    status: "validated_open",
    computed_status: "validated_open",
    status_override: null,
    parked_at: null,
    retired: false,
    related_gap_ids: [],
    parent_gap_id: null,
    origin_gap_id: null,
  };
  const snapshot = {
    version: 1,
    execution: "routed",
    workspace_id: workspaceId,
    stage: "S8",
    run_id: "run-" + i,
    module_id: "fiction-stage",
    module_version: "1",
    prompt_version: "v1.0-baseline",
    route: modelRoute,
    input: { gap_ids: [gap.id] },
    facts: {
      axesConfig: { ...DEFAULT_AXES, updated_by: "fixture", updated_at: "2026-01-01" },
      state: {
        ...buildBlankWorkspace(),
        objectives: [{ id: "obj", name: "Fictional review", evidence_needed_by: "2028-07-01" }],
        gaps: [gap],
        needs: [
          {
            id: "need-" + i,
            source_id: "SRC-PLAN-ENTRY",
            statement: gap.statement,
            source_quote: gap.statement,
            run_id: null,
          },
        ],
        need_gap_links: [{ gap_id: gap.id, need_id: "need-" + i, role: "primary" }],
        sources: [{ id: "SRC-PLAN-ENTRY", full_text: "Administrative manual plan entries" }],
        gap_versions: [],
      },
    },
    examples: [],
  };
  return {
    id: "example-" + i,
    stage: "S8",
    workspace_id: workspaceId,
    kind: "s8_band",
    subject_id: gap.id,
    actor_principal: "reviewer-" + i,
    run_id: snapshot.run_id,
    replay_input: snapshot,
    prompt_version: snapshot.prompt_version,
    model: modelRoute.model,
    provider_id: modelRoute.provider_id,
    priority_review_hash: frozenPriorityReviewHash(snapshot, gap.id),
    ai_input: { gap },
    ai_output: { band: "high" },
    outcome: "edited",
    final: { band: "low" },
    lesson: "reviewed " + i,
    lesson_status: "ok",
    created_at: "2026-11-0" + i,
    rationale: null,
  };
}
