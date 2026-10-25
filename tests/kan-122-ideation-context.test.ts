import { describe, expect, it } from "vitest";
import { buildSeed } from "@/lib/iegp/seed";
import { getRequirementBasisReview } from "@/lib/iegp/requirement-basis";
import { buildIdeationGapBrief, ideationAcceptanceBasis } from "@/modules/stages/s9-ideation/context";

function fixture() {
  const state = buildSeed();
  const gap = state.gaps[0]!;
  state.needs = [];
  state.need_gap_links = [];
  state.asset.planning_context = { comparator: "Planning-only comparator" };
  const review = getRequirementBasisReview(state, gap.id);
  gap.requirement_basis = { ...review.basis, origin: "human", version: "confirmed-one", confirmation: { locked: true, actor_name: "Reviewer", actor_function: "medical_affairs", locked_at: "2026-10-25T12:00:00Z", note: null } };
  state.objectives.find(o => o.id === gap.objective_id)!.evidence_needed_by = "2027-01-31";
  const placements = [{gap_id: gap.id, band: "high" as const, validated: true, rationale: "Blocks January evidence decision", needs_review: false}];
  return {state, gap, placements};
}

describe("KAN-122 sourced ideation brief", () => {
  it("keeps a missing comparator unknown while exposing canonical requirements, deadline and mapped coverage", () => {
    // Arrange: confirmed dimensions can still contain an explicitly undetermined comparator.
    const { state, gap, placements } = fixture();
    // Act.
    const brief = buildIdeationGapBrief(state, gap.id, placements);
    // Assert: a planning comparator does not become a confirmed gap requirement.
    expect(brief.requirements.confirmed).toBe(true);
    expect(brief.requirements.dimensions.comparator.applicability).toBe("undetermined");
    expect(brief.requirements.dimensions.comparator.requirement).toBe("");
    expect(brief.requirements.unknown_dimensions).toContain("comparator");
    expect(brief.objective?.evidence_needed_by).toBe("2027-01-31");
    expect(brief.priority?.rationale).toBe("Blocks January evidence decision");
    expect(brief.mapped_tactics.length).toBeGreaterThan(0);
    expect(brief.mapped_tactics[0]).toHaveProperty("coverage.overall");
    expect(brief.mapped_tactics[0]).toHaveProperty("tactic.lifecycle_stage");
    expect(brief.coverage_authority).toBe("S4 recorded assessments; ideation does not confirm or overwrite coverage");
  });

  it("changes the acceptance basis for requirements, deadline, priority, lifecycle and coverage but ignores write metadata", () => {
    const {state, gap, placements} = fixture();
    const original = ideationAcceptanceBasis(state, gap.id, placements);
    for (const mutate of [
      () => { state.objectives.find(o => o.id === gap.objective_id)!.evidence_needed_by = "2028-01-31"; },
      () => { placements[0]!.rationale = "Different decision rationale"; },
      () => { state.tactics[0]!.lifecycle_stage = "completed"; },
      () => { state.coverages.find(c => c.gap_id === gap.id)!.needs_review = true; },
      () => { state.gaps[0]!.requirement_basis!.dimensions.comparator.requirement = "Confirmed comparator"; },
      () => { state.gaps[0]!.requirement_basis!.dimensions.comparator.rationale = "Comparator relevance changed"; },
    ]) {
      const saved = structuredClone({state, placements});
      mutate();
      expect(ideationAcceptanceBasis(state, gap.id, placements)).not.toBe(original);
      Object.assign(state, saved.state);
      placements.splice(0, placements.length, ...saved.placements);
    }
    state.tactics[0]!.owner = "New administrator";
    state.tactics[0]!.name = "Cosmetic title";
    state.gaps[0]!.name = "Cosmetic gap title";
    state.gaps[0]!.requirement_basis!.version = "new-write-version";
    expect(ideationAcceptanceBasis(state, gap.id, placements)).toBe(original);
  });

  it("rejects an unknown gap instead of inventing a brief", () => {
    const {state, placements} = fixture();
    expect(() => buildIdeationGapBrief(state, "missing", placements)).toThrow("Gap not found");
  });
});
