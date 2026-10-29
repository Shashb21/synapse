import { TrustedApplicationError } from "@/modules/kernel/stage-errors";
/** Sourced requirement read model and confirmation rules, shared by assessment actions and views. */
import { COVERAGE_DIMENSIONS, DIMENSION_LABELS, type CoverageDimension } from "./enums";
import type { EvidenceNeed, GapTacticCoverage, IegpState, RequirementBasis, RequirementDimension, RequirementSource } from "./types";

export type RequirementReviewInput = Partial<Record<CoverageDimension, {
  applicability: RequirementDimension["applicability"];
  requirement?: string;
  rationale?: string;
  resolution?: string;
}>>;

const NEED_FIELDS: Partial<Record<CoverageDimension, keyof EvidenceNeed>> = {
  relevance: "statement", population: "population", intervention: "intervention", comparator: "comparator",
  outcomes: "outcome", geography: "geography", timing: "timing", decision_utility: "decision_supported",
};

/** Revision token also covers linked source content, so a source edit invalidates an open form. */
export function requirementSourceVersion(state: IegpState, gapId: string): string {
  const gap = state.gaps.find(g => g.id === gapId);
  if (!gap) throw new TrustedApplicationError("Gap not found", "not_found", 404);
  const ids = new Set(state.need_gap_links.filter(l => l.gap_id === gapId).map(l => l.need_id));
  const objective = state.objectives.find(o => o.id === gap.objective_id);
  // A quote identifies the narrow supporting meaning; block ids and surrounding
  // prose may change without changing that meaning. Source owners validate and
  // retain actual cited text for legacy block-only needs across split/merge.
  const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
  const support = (need: EvidenceNeed) => {
    const blocks = state.blocks.filter(block => block.source_id === need.source_id);
    const quote = normalize(need.source_quote ?? "");
    if (quote) return [quote, blocks.some(block => normalize(block.text).includes(quote))];
    if (need.source_basis_text) return normalize(need.source_basis_text);
    if (need.block_id) return normalize(blocks.find(block => block.id === need.block_id)?.text ?? "");
    // Legacy records without a concrete citation conservatively depend on the source.
    return blocks.map(block => normalize(block.text)).sort();
  };
  return JSON.stringify([gap.id, gap.statement, gap.domain, gap.objective_id,
    objective && [objective.description, objective.lifecycle_stage, objective.indication, objective.geography, objective.key_decision, objective.decision_date],
    gap.metadata.geography, gap.metadata.regional_nuances, gap.settings.slice().sort(),
    state.needs.filter(n => ids.has(n.id)).sort((a, b) => a.id.localeCompare(b.id)).map(n =>
      [n.id, n.status, n.domain, n.statement, n.population, n.intervention, n.comparator, n.outcome, n.geography, n.timing, n.decision_supported, n.source_id, support(n)])]);
}

/** Reconstructs source-backed proposals without interpreting omitted fields as irrelevant. */
function sourcedDimensions(state: IegpState, gapId: string): RequirementBasis["dimensions"] {
  const gap = state.gaps.find(g => g.id === gapId)!;
  const ids = new Set(state.need_gap_links.filter(l => l.gap_id === gapId).map(l => l.need_id));
  const needs = state.needs.filter(n => ids.has(n.id));
  return Object.fromEntries(COVERAGE_DIMENSIONS.map(dim => {
    const sources: RequirementSource[] = [];
    const context = dim === "relevance" ? gap.statement : dim === "geography" ? gap.metadata.geography : dim === "setting" ? gap.settings.join(", ") : "";
    if (context?.trim()) sources.push({ kind: "gap", gap_id: gapId, quote: gap.statement, value: context.trim() });
    const field = NEED_FIELDS[dim];
    if (field) for (const need of needs) {
      const value = String(need[field] ?? "").trim();
      if (value) sources.push({ kind: "need", gap_id: gapId, need_id: need.id, source_id: need.source_id, block_id: need.block_id ?? null, quote: need.source_quote || need.statement, value });
    }
    const distinct = [...new Set(sources.map(s => s.value))];
    // Relevance statements can describe complementary needs; structured fields expose disagreements.
    const conflicts = dim !== "relevance" && distinct.length > 1 ? distinct : [];
    return [dim, { applicability: sources.length ? "required" : "undetermined", requirement: distinct.join("; "), rationale: "", sources, conflicts, resolution: "" }];
  })) as RequirementBasis["dimensions"];
}

/** Explain why a confirmed Full is unsupported. Unknown is uncertainty, never a mismatch. */
export function fullConfirmationIssues(basis: RequirementBasis | null | undefined, coverage: Pick<GapTacticCoverage, "dimensions">): string[] {
  if (!basis?.confirmation.locked || !basis.confirmation.actor_name?.trim() || !basis.confirmation.locked_at || basis.origin !== "human") return ["A human must confirm the requirement basis before Full coverage."];
  const issues: string[] = [];
  for (const dim of COVERAGE_DIMENSIONS) {
    const requirement = basis.dimensions[dim];
    const label = DIMENSION_LABELS[dim];
    if (!requirement || requirement.applicability === "undetermined") issues.push(`${label}: applicability is not yet determined.`);
    else if (requirement.applicability === "not_applicable") {
      if ((requirement.rationale?.trim().length ?? 0) < 3) issues.push(`${label}: non-applicability needs a justification.`);
    } else if (requirement.applicability !== "required" || !requirement.requirement?.trim() || coverage.dimensions[dim]?.value !== "yes") {
      issues.push(`${label}: required information has not been confirmed; Full requires Yes.`);
    }
    if (requirement?.conflicts.length && requirement.resolution.trim().length < 3) issues.push(`${label}: unresolved requirement conflicts.`);
  }
  return issues;
}

/** Current Full support is explicit; a historical lock alone cannot supply it. */
export function hasSupportedFullConfirmation(coverage: GapTacticCoverage): boolean {
  return coverage.overall === "full" && coverage.overall_lock.locked && !coverage.stale &&
    fullConfirmationIssues(coverage.confirmed_requirement_basis, coverage).length === 0;
}

/** A comparison token for overall/dimension writes, including imported historical records. */
export function coverageReviewVersion(coverage: GapTacticCoverage): string {
  return JSON.stringify([coverage.review_version ?? null, coverage.overall, coverage.overall_rationale, coverage.overall_lock, coverage.dimensions, coverage.confirmed_requirement_basis?.version ?? null, coverage.stale, coverage.assessed_basis ?? null]);
}

/** User-visible sourced basis, unresolved reasons, and per-relationship Full eligibility. */
export function getRequirementBasisReview(state: IegpState, gapId: string, coverage?: GapTacticCoverage) {
  const gap = state.gaps.find(g => g.id === gapId);
  if (!gap) throw new TrustedApplicationError("Gap not found", "not_found", 404);
  if (coverage && coverage.gap_id !== gapId) throw new TrustedApplicationError("Coverage does not belong to this gap");
  const sourceVersion = requirementSourceVersion(state, gapId);
  const saved = gap.requirement_basis;
  const sources = sourcedDimensions(state, gapId);
  const current = saved?.source_version === sourceVersion;
  const basis: RequirementBasis = saved && current ? saved : {
    version: saved?.version ?? "unreviewed", source_version: sourceVersion, origin: "extraction", dimensions: sources,
    confirmation: { locked: false, actor_name: null, actor_function: null, locked_at: null, note: null }, rationale: "", history: saved ? [...saved.history, saved] : [],
  };
  const issues = coverage ? fullConfirmationIssues(basis, coverage) : [];
  return {
    basis, version: JSON.stringify([saved?.version ?? null, sourceVersion]), source_changed: Boolean(saved && !current),
    full_eligible: Boolean(coverage && issues.length === 0), issues,
    legacy_unsupported_full: Boolean(coverage?.overall === "full" && coverage.overall_lock.locked && !coverage.confirmed_requirement_basis),
  };
}

/** Validates whole-basis human input while sources/conflicts remain owned by the server. */
export function reviewedRequirementDimensions(state: IegpState, gapId: string, input: RequirementReviewInput): RequirementBasis["dimensions"] {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TrustedApplicationError("Supply requirement dimensions.");
  if (Object.keys(input).some(key => !(COVERAGE_DIMENSIONS as readonly string[]).includes(key))) throw new TrustedApplicationError("Unknown requirement dimension.");
  const dimensions = sourcedDimensions(state, gapId);
  for (const dim of COVERAGE_DIMENSIONS) {
    const entry = input[dim];
    if (!entry) { dimensions[dim] = { ...dimensions[dim], applicability: "undetermined" }; continue; }
    if (!entry || typeof entry !== "object" || Object.keys(entry).some(key => !["applicability", "requirement", "rationale", "resolution"].includes(key))) throw new TrustedApplicationError("Requirement source references are server-owned; refresh the sourced basis.");
    if (!["required", "not_applicable", "undetermined"].includes(entry.applicability)) throw new TrustedApplicationError(`Choose applicability for ${dim}.`);
    for (const field of ["requirement", "rationale", "resolution"] as const) if (entry[field] !== undefined && typeof entry[field] !== "string") throw new TrustedApplicationError(`Invalid ${dim} ${field}.`);
    const rationale = entry.rationale?.trim() ?? "";
    const requirement = entry.requirement?.trim() ?? dimensions[dim].requirement;
    if (entry.applicability === "not_applicable" && rationale.length < 3) throw new TrustedApplicationError(`${dim}: Not applicable requires a justification.`);
    if (entry.applicability === "required" && !requirement) throw new TrustedApplicationError(`${dim}: describe the required information.`);
    dimensions[dim] = { ...dimensions[dim], applicability: entry.applicability, requirement, rationale, resolution: entry.resolution?.trim() ?? "" };
  }
  return dimensions;
}

/** Semantic requirement meaning, separate from whole-record/form versions and review attribution. */
export function assessmentRequirementVersion(state: IegpState, gapId: string): string {
  const review = getRequirementBasisReview(state, gapId);
  return JSON.stringify([requirementSourceVersion(state, gapId), COVERAGE_DIMENSIONS.map(dim => {
    const requirement = review.basis.dimensions[dim];
    return [dim, requirement.applicability, requirement.requirement, requirement.conflicts, requirement.resolution];
  })]);
}

/** Fields that change the study's ability to answer a requirement. Titles and administration are cosmetic. */
export function assessmentDesignVersion(state: IegpState, coverage: Pick<GapTacticCoverage, "tactic_id" | "expansion_id">): string {
  if (coverage.expansion_id) {
    const child = state.expansions.find(e => e.id === coverage.expansion_id);
    if (!child) throw new TrustedApplicationError("Expansion not found", "not_found", 404);
    const { name: _name, cost_effort: _cost, feasibility_risks: _risks, ...design } = child.scope;
    return JSON.stringify(design);
  }
  const tactic = state.tactics.find(t => t.id === coverage.tactic_id);
  if (!tactic) throw new TrustedApplicationError("Tactic not found", "not_found", 404);
  return JSON.stringify([tactic.type, tactic.evidence_question, tactic.description, tactic.population,
    tactic.intervention, tactic.comparator, tactic.outcomes, tactic.study_design, tactic.data_source,
    tactic.geography, tactic.start_date, tactic.evidence_available, tactic.intended_use, tactic.source_quote]);
}

/** The exact semantic basis retained alongside the last overall judgement. */
export function assessmentBasis(state: IegpState, coverage: Pick<GapTacticCoverage, "gap_id" | "tactic_id" | "expansion_id">) {
  return { requirements: assessmentRequirementVersion(state, coverage.gap_id), design: assessmentDesignVersion(state, coverage) };
}
