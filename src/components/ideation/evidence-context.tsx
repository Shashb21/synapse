/** Read-only evidence briefs and retained option reasoning shared across review and planning. */
import Link from "next/link";
import { DIMENSION_LABELS, OVERALL_COVERAGE_LABELS } from "@/lib/iegp/enums";
import type { IdeationGapBrief } from "@/modules/stages/s9-ideation/context";
import type { IdeationGapOutcome, IdeationRecommendation } from "@/modules/stages/s9-ideation/recommendation-contract";
import type { acceptedIdeationContexts } from "@/modules/stages/s9-ideation/module";

export type AcceptedContext = ReturnType<typeof acceptedIdeationContexts>[number];

/** Show recorded requirements, unknowns and priority independently of AI and proposals. */
export function IdeationBrief({ brief }: { brief: IdeationGapBrief }) {
  return <section aria-label="Evidence brief" className="grid gap-2 border-t border-border pt-2 text-[12px]">
    <h3 className="font-medium">Evidence brief</h3>
    <p>Priority rationale: {brief.priority?.rationale || "Not recorded"}{brief.priority?.needs_review ? " · Priority needs review" : ""}</p>
    <p>Requirement basis: {brief.requirements.confirmed ? "Human confirmed" : "Needs human confirmation"}{brief.requirements.source_changed ? " · Sources changed" : ""}. Suggested requirements need human confirmation.</p>
    <dl className="grid gap-2 sm:grid-cols-2">{Object.entries(brief.requirements.dimensions).map(([key, dimension]) => <div key={key}>
      <dt className="font-medium">{DIMENSION_LABELS[key as keyof typeof DIMENSION_LABELS]}</dt>
      <dd>{dimension.applicability === "undetermined" ? "Unknown — requirement not determined" : dimension.applicability === "not_applicable" ? "Not applicable" : dimension.requirement || "Requirement not recorded"}</dd>
      {dimension.conflicts.length && !dimension.resolution.trim() ? <dd>Unresolved conflict: {dimension.conflicts.join("; ")}</dd> : null}
      {dimension.rationale ? <dd className="text-muted-foreground">{dimension.rationale}</dd> : null}
    </div>)}</dl>
    <p>Evidence needed by: {brief.objective?.evidence_needed_by || "Not recorded"} · Decision date: {brief.objective?.decision_date || "Not recorded"}</p>
    {brief.objective ? <p>Decision: {brief.objective.key_decision || brief.objective.description}</p> : null}
    <ul className="grid gap-1">{brief.mapped_tactics.map(({ tactic, expansion, coverage }) => {
      // A child scope is a separate piece of work. An explicitly blank child
      // value means unknown; only a field absent from historical child data may
      // inherit its parent's value.
      const child = expansion?.scope;
      const own = <K extends keyof NonNullable<typeof child>>(key: K, parent: string | null | undefined, fallback: string) =>
        child && Object.hasOwn(child, key) && child[key] !== undefined ? (child[key] || fallback) : (parent || fallback);
      const evidenceAvailable = child ? (child.evidence_available || "Not documented") : (tactic?.evidence_available || "Not documented");
      return <li key={coverage.id}>
      <Link href={`/tactics/${encodeURIComponent(coverage.tactic_id)}`}>{expansion?.scope.name ?? tactic?.name ?? coverage.tactic_id}</Link>
      {" · Lifecycle: "}{expansion?.status ?? tactic?.status ?? "Unknown"}{" · Coverage: "}{OVERALL_COVERAGE_LABELS[coverage.overall]}
      {coverage.overall_lock.locked ? " · Human confirmed" : " · Not confirmed"}{coverage.stale || coverage.needs_review ? " · Review needed" : ""}
      <p>Recorded design: {own("study_design", tactic?.study_design, "Unknown")} · Comparator: {own("comparator", tactic?.comparator, "Unknown")}</p>
      <details><summary>Recorded design and coverage</summary>
        <p>Evidence question: {own("evidence_question", tactic?.evidence_question, "Not recorded")}</p>
        <p>Population: {own("population", tactic?.population, "Unknown")} · Outcomes: {own("outcomes", tactic?.outcomes, "Unknown")}</p>
        <p>Data source: {own("data_source", tactic?.data_source, "Unknown")} · Evidence available: {evidenceAvailable}</p>
        <ul>{Object.entries(coverage.dimensions).map(([key, assessment]) => <li key={key}>{DIMENSION_LABELS[key as keyof typeof DIMENSION_LABELS]}: {assessment.value}{assessment.lock.locked ? " · Human confirmed" : ""}{assessment.rationale ? ` · ${assessment.rationale}` : ""}</li>)}</ul>
      </details>
      {coverage.overall_rationale ? <p>{coverage.overall_rationale}</p> : null}
    </li>})}</ul>
    <p>Planned output is not delivered evidence. Recorded coverage remains authoritative; ideation does not confirm or overwrite it.</p>
  </section>;
}

/** Keep unresolved outcomes visible even when a run produced no candidates. */
export function IdeationOutcome({ outcome }: { outcome?: IdeationGapOutcome }) {
  if (!outcome || outcome.status === "options") return null;
  return <div role="note" className="grid gap-1 text-[12px]">
    <p className="font-medium">{outcome.status === "no_timely_option" ? "No timely option" : "No credible option"}</p>
    <p>{outcome.explanation}</p><p>The evidence need remains unresolved. Recorded coverage is unchanged.</p>
  </div>;
}

/** Present contribution and unresolved checks before numerical model ratings. */
export function RecommendationReasoning({ recommendation, conditions = [], contribution, comparison }: {
  recommendation?: IdeationRecommendation;
  conditions?: string[];
  contribution?: string;
  comparison?: string;
}) {
  const checks = [...new Set([...conditions, ...(recommendation?.feasibility.required_checks ?? [])])];
  const displayedContribution = recommendation?.incremental_contribution || contribution?.trim();
  const displayedComparison = recommendation?.alternatives_rationale || comparison?.trim();
  if (!recommendation && !checks.length && !displayedContribution && !displayedComparison) return null;
  return <div aria-label="Option reasoning and checks" className="grid gap-1 text-[12px]">
    {recommendation ? <p>Remaining need: {recommendation.remaining_need}</p> : null}
    {displayedContribution ? <p>Additional contribution: {displayedContribution}</p> : null}
    {displayedComparison ? <p>Relevant alternatives: {displayedComparison}</p> : null}
    {recommendation ? <><p>Feasibility: {recommendation.feasibility.status}</p>
      {recommendation.coverage_discrepancy ? <p>Coverage discrepancy to review: {recommendation.coverage_discrepancy}. Recorded coverage is unchanged.</p> : null}
      <p>Deadline: {recommendation.deadline.status} · {recommendation.deadline.explanation}</p></> : null}
    {checks.length ? <div><p className="font-medium">Unresolved checks</p><ul className="list-disc pl-4">{checks.map(check => <li key={check}>{check}</li>)}</ul></div> : null}
  </div>;
}

/** Match the exact accepted work scope so child conditions never become parent conditions. */
export function AcceptedIdeationContext({ contexts, tacticId, expansionId, gapId }: { contexts: AcceptedContext[]; tacticId: string; expansionId?: string | null; gapId?: string }) {
  const rows = contexts.filter(row => row.tactic_id === tacticId && (row.expansion_id ?? null) === (expansionId ?? null) && (!gapId || row.gap_id === gapId));
  return <>{rows.map(row => <section key={row.proposal_id} aria-label="Accepted option context" className="grid gap-1 border-t border-border pt-2 text-[12px]">
    <p>Accepted {row.proposal_kind === "reuse" ? "reuse · no additional work; coverage review requested" : row.proposal_kind === "expansion" ? "expansion · added work" : "new activity"} · <Link href="/ideation">Source proposal {row.proposal_id}</Link></p>
    <RecommendationReasoning recommendation={row.recommendation} conditions={row.conditions} />
    {row.comparative_rationale ? <p>Comparison: {row.comparative_rationale}</p> : null}
    {row.renewed_review ? <p>Current context reviewed by {row.renewed_review.actor}: {row.renewed_review.rationale}</p> : null}
  </section>)}</>;
}
