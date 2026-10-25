/** S9's sourced per-gap evidence brief and semantic context used at acceptance. */
import { createHash } from "node:crypto";
import { COVERAGE_DIMENSIONS } from "@/lib/iegp/enums";
import { assessmentRequirementVersion, getRequirementBasisReview } from "@/lib/iegp/requirement-basis";
import type { IegpState, Tactic } from "@/lib/iegp/types";

/** Recorded placement fields that affect the reason or eligibility for ideation. */
export type IdeationPriorityPlacement = {
  gap_id: string;
  band: "high" | "medium" | "low" | "defer" | null;
  validated: boolean;
  rationale: string | null;
  needs_review?: boolean;
  review_reason?: string | null;
  axis_scores?: Record<string, number>;
};

/** Design/lifecycle meaning, deliberately excluding titles, owners and write versions. */
function tacticMeaning(tactic: Tactic) {
  const { id, type, description, evidence_question, population, intervention, comparator, outcomes, geography, data_source, study_design, lifecycle_stage, status, review_status, start_date, evidence_available, budget, intended_use, source_quote } = tactic;
  return { id, type, description, evidence_question, population, intervention, comparator, outcomes, geography, data_source, study_design, lifecycle_stage, status, review_status, start_date, evidence_available, budget, intended_use, source_quote };
}

/** Sort object keys so equivalent JSON write order cannot invalidate a review. */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
  return value;
}

/**
 * Build a brief from recorded facts only. An absent requirement remains undetermined;
 * planning questionnaire defaults never become confirmed gap requirements.
 * Throws when the requested gap is absent.
 */
export function buildIdeationGapBrief(state: IegpState, gapId: string, placements: IdeationPriorityPlacement[]) {
  const gap = state.gaps.find(item => item.id === gapId);
  if (!gap) throw new Error("Gap not found");
  const review = getRequirementBasisReview(state, gapId);
  const objective = state.objectives.find(item => item.id === gap.objective_id);
  const placement = placements.find(item => item.gap_id === gapId);
  const priority = placement ? {
    band: placement.band, validated: placement.validated, rationale: placement.rationale,
    needs_review: placement.needs_review ?? false, review_reason: placement.review_reason ?? null,
    axis_scores: placement.axis_scores ?? {},
  } : null;
  const coverage = state.coverages.filter(item => item.gap_id === gapId).sort((a, b) => a.id.localeCompare(b.id));
  return {
    gap_id: gap.id,
    statement: gap.statement,
    domain: gap.domain,
    requirements: {
      confirmed: review.basis.origin === "human" && review.basis.confirmation.locked && !review.source_changed,
      source_changed: review.source_changed,
      dimensions: review.basis.dimensions,
      unknown_dimensions: COVERAGE_DIMENSIONS.filter(dim => review.basis.dimensions[dim].applicability === "undetermined"),
      conflicting_dimensions: COVERAGE_DIMENSIONS.filter(dim => review.basis.dimensions[dim].conflicts.length > 0 && !review.basis.dimensions[dim].resolution.trim()),
      suggestions_require_human_confirmation: true as const,
    },
    objective: objective ? {
      id: objective.id, description: objective.description, key_decision: objective.key_decision,
      decision_date: objective.decision_date, evidence_needed_by: objective.evidence_needed_by ?? null,
      indication: objective.indication, geography: objective.geography, lifecycle_stage: objective.lifecycle_stage,
    } : null,
    priority,
    mapped_tactics: coverage.map(item => ({
      tactic: state.tactics.find(tactic => tactic.id === item.tactic_id) ?? null,
      expansion: item.expansion_id ? state.expansions.find(child => child.id === item.expansion_id) ?? null : null,
      coverage: item,
    })),
    coverage_authority: "S4 recorded assessments; ideation does not confirm or overwrite coverage" as const,
    planned_output_is_delivered_evidence: false as const,
  };
}

export type IdeationGapBrief = ReturnType<typeof buildIdeationGapBrief>;

/**
 * Hash material supporting meaning rather than UI/write metadata. Includes the
 * available library because alternatives can change contribution/feasibility.
 * Prior reasoning is retained separately; callers must request renewed review
 * when this token differs, rather than silently replacing it.
 */
export function ideationAcceptanceBasis(state: IegpState, gapId: string, placements: IdeationPriorityPlacement[]): string {
  const brief = buildIdeationGapBrief(state, gapId, placements);
  const gap = state.gaps.find(item => item.id === gapId)!;
  const meaning = {
    schema: 1,
    requirements: assessmentRequirementVersion(state, gapId),
    requirements_confirmed: brief.requirements.confirmed,
    requirement_rationales: COVERAGE_DIMENSIONS.map(dim => [dim, brief.requirements.dimensions[dim].rationale]),
    objective: brief.objective,
    priority: brief.priority,
    eligibility: { status: gap.status, human_validated: gap.human_validated, retired: gap.retired, parked_at: gap.parked_at, status_override: gap.status_override ? {status: gap.status_override.status, reason: gap.status_override.reason, stale: gap.status_override.stale} : null, computed_status: gap.computed_status },
    tactics: state.tactics.map(tacticMeaning).sort((a, b) => a.id.localeCompare(b.id)),
    expansions: state.expansions.map(child => {
      const scope = Object.fromEntries(Object.entries(child.scope).filter(([key]) => key !== "name"));
      return { id: child.id, tactic_id: child.tactic_id, status: child.status, scope };
    }).sort((a, b) => a.id.localeCompare(b.id)),
    coverage: brief.mapped_tactics.map(({ coverage }) => ({
      id: coverage.id, tactic_id: coverage.tactic_id, expansion_id: coverage.expansion_id ?? null,
      overall: coverage.overall, overall_rationale: coverage.overall_rationale,
      confirmed: coverage.overall_lock.locked, stale: coverage.stale, needs_review: coverage.needs_review,
      assessed_basis: coverage.assessed_basis ?? null,
      assessment_origin: coverage.assessment_origin ?? null,
      confirmed_requirements: coverage.confirmed_requirement_basis ? {
        origin: coverage.confirmed_requirement_basis.origin,
        confirmed: coverage.confirmed_requirement_basis.confirmation.locked,
        dimensions: COVERAGE_DIMENSIONS.map(dim => {
          const requirement = coverage.confirmed_requirement_basis!.dimensions[dim];
          return [dim, requirement.applicability, requirement.requirement, requirement.rationale, requirement.conflicts, requirement.resolution];
        }),
      } : null,
      dimensions: COVERAGE_DIMENSIONS.map(dim => ({dimension: dim, value: coverage.dimensions[dim].value, rationale: coverage.dimensions[dim].rationale, confirmed: coverage.dimensions[dim].lock.locked})),
    })),
  };
  return createHash("sha256").update(JSON.stringify(stable(meaning))).digest("hex");
}
