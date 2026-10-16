/** Positive final-plan fixtures complete the same explicit reviews as the application. */
import { countingCoverages, displayedGapStatus, isLiveGap } from "@/lib/iegp/engine";
import { loadState, lockCoverageDimension, lockCoverageOverall, lockGapStatus, reviewRequirementBasis, rewritePartialGap, validateGap } from "@/lib/iegp/store";
import { COVERAGE_DIMENSIONS, type ActorFunction } from "@/lib/iegp/enums";
import { getRequirementBasisReview } from "@/lib/iegp/requirement-basis";
import { listPlacements, validatePlacement } from "@/modules/stages/s8-prioritization/module";

/**
 * Brings a seeded plan to where a complete final may be saved (KAN-86): every
 * Partially Addressed gap rewritten (Addressed with its mapped tactics, else
 * Open), every live gap confirmed, and every Open gap given a validated band.
 * Tests that exercise the roadmap call this before saving as final.
 */
export async function makeFinalReady(actor: { name: string; function: ActorFunction }) {
  let state = await loadState();
  for (const gap of state.gaps.filter(isLiveGap)) {
    if (displayedGapStatus(gap) !== "validated_partial") continue;
    const tacticIds = [...new Set(countingCoverages(state.coverages.filter((c) => c.gap_id === gap.id), state.tactics, state.expansions).map((c) => c.expansion_id ?? c.tactic_id))];
    const rewrittenGapId = await rewritePartialGap({
      gap_id: gap.id,
      name: gap.name,
      status: tacticIds.length > 0 ? "validated_addressed" : "validated_open",
      tactic_ids: tacticIds.length > 0 ? tacticIds : undefined,
      actor_name: actor.name,
      actor_function: actor.function,
      note: "Resolved before the final plan",
    });
    if (tacticIds.length > 0) {
      // Rewriting proposes Full; this synthetic positive fixture then reviews it explicitly.
      const rewritten = await loadState();
      const coverage = countingCoverages(rewritten.coverages.filter(c => c.gap_id === rewrittenGapId), rewritten.tactics, rewritten.expansions)[0]!;
      const review = getRequirementBasisReview(rewritten, rewrittenGapId, coverage);
      const basis = await reviewRequirementBasis({
        gap_id: rewrittenGapId, expected_version: review.version,
        dimensions: Object.fromEntries(COVERAGE_DIMENSIONS.map(dimension => {
          const requirement = review.basis.dimensions[dimension];
          return [dimension, {
            applicability: requirement.requirement.trim() ? "required" : "not_applicable",
            requirement: requirement.requirement,
            rationale: "Synthetic final-plan fixture: sourced requirements are required; unspecified dimensions are outside this fixture's decision",
            resolution: requirement.conflicts.length ? "Fixture reviewer requires the combined sourced requirements" : "",
          }];
        })),
        rationale: "Explicit requirement review for the positive final-plan fixture",
        actor_name: actor.name, actor_function: actor.function,
      });
      for (const dimension of COVERAGE_DIMENSIONS) {
        if (basis.dimensions[dimension].applicability !== "required") continue;
        await lockCoverageDimension({
          coverage_id: coverage.id, dimension, value: "yes",
          rationale: "Synthetic positive fixture: planned design satisfies this sourced requirement",
          actor_name: actor.name, actor_function: actor.function,
        });
      }
      await lockCoverageOverall({
        coverage_id: coverage.id, overall: "full",
        rationale: "Explicit Full review after all required positive-fixture dimensions are satisfied",
        actor_name: actor.name, actor_function: actor.function,
      });
    }
  }
  state = await loadState();
  for (const gap of state.gaps.filter(isLiveGap)) {
    if (gap.status === "candidate") {
      // A candidate is decided first: here it is kept, as an Open gap.
      await lockGapStatus({ gap_id: gap.id, status: "validated_open", actor_name: actor.name, actor_function: actor.function, note: "Kept as Open for the final plan" });
      await validateGap({ gap_id: gap.id, actor_name: actor.name, actor_function: actor.function, note: "Confirmed for the final plan" });
    } else if (!gap.human_validated) {
      await validateGap({ gap_id: gap.id, actor_name: actor.name, actor_function: actor.function, note: "Confirmed for the final plan" });
    }
  }
  state = await loadState();
  const banded = new Set((await listPlacements()).filter((p) => p.validated && p.band).map((p) => p.gap_id));
  for (const gap of state.gaps.filter(isLiveGap)) {
    if (displayedGapStatus(gap) !== "validated_open" || banded.has(gap.id)) continue;
    await validatePlacement({ gap_id: gap.id, band: "low", rationale: "Banded for the final plan", actor });
  }
}
