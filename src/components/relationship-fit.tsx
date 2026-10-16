/** Read-only relationship explanation, shared by linked tactics and chooser previews. */
import type { RelationshipFitModel } from "@/lib/iegp/engine";
import { DIMENSION_LABELS, OVERALL_COVERAGE_LABELS } from "@/lib/iegp/enums";
import type { Lock } from "@/lib/iegp/types";

const FIT_LABELS = {
  documented_match: "Documented match (recorded Yes)",
  known_mismatch: "Known mismatch (recorded No)",
  partial: "Partial answer (recorded Partial)",
  unknown: "Unknown information",
  not_applicable: "Not applicable — recorded justification",
};
const ORIGIN_LABELS = { human: "Human", ai: "AI proposal", workflow: "Workflow proposal" };

function confirmationText(lock: Lock): string {
  if (!lock.locked) return "Not confirmed";
  return `Confirmed by ${lock.actor_name || "an unrecorded reviewer"}${lock.locked_at ? ` at ${lock.locked_at}` : " (date not recorded)"}`;
}

/** Show saved fit, design intent and review facts without offering assessment or AI actions. */
export function RelationshipFit({ fit, tacticName }: { fit: RelationshipFitModel; tacticName: string }) {
  const unanswered = fit.dimensions.filter(d => d.unanswered);
  const freshness = [
    fit.stale ? "Marked stale" : null,
    fit.needs_review ? "Relationship review requested" : null,
    fit.source_changed ? "Requirement sources changed" : null,
  ].filter(Boolean).join("; ") || "No recorded freshness warning";
  return (
    <details className="mt-3 rounded-md border border-border text-[12px]" data-testid="relationship-fit">
      <summary className="cursor-pointer px-3 py-2 font-medium text-foreground focus-visible:outline-2 focus-visible:outline-ring">
        Fit to this gap <span className="font-normal text-muted-foreground">· {tacticName}</span>
      </summary>
      <section aria-label={`Relationship fit for ${tacticName}`} className="grid gap-3 border-t border-border p-3">
        <p className="leading-5 text-muted-foreground">
          Matches and mismatches reflect this relationship&apos;s recorded dimension judgements. Unknown information establishes neither a match nor a mismatch. Study wording alone does not verify fit.
        </p>
        <dl className="grid gap-x-4 gap-y-2 sm:grid-cols-[auto_1fr]">
          <dt className="font-medium">Assessment origin</dt><dd>{fit.assessment_origin ? ORIGIN_LABELS[fit.assessment_origin] : "Not recorded"}</dd>
          <dt className="font-medium">Saved judgement</dt>
          <dd>{OVERALL_COVERAGE_LABELS[fit.overall]}{fit.overall !== "unassessed" && !fit.confirmation.locked ? " · Provisional" : ""}
            {fit.overall_rationale ? <p className="mt-1 text-muted-foreground">{fit.overall_rationale}</p> : null}</dd>
          <dt className="font-medium">Human confirmation</dt><dd>{confirmationText(fit.confirmation)}</dd>
          <dt className="font-medium">Requirement basis</dt><dd>{confirmationText(fit.requirement_confirmation)}</dd>
          <dt className="font-medium">Freshness</dt><dd>{freshness}</dd>
        </dl>
        {fit.review_reasons.length ? (
          <div>
            <p className="font-medium">Review reasons</p>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-muted-foreground">
              {fit.review_reasons.map(reason => <li key={reason}>{reason}</li>)}
            </ul>
          </div>
        ) : null}
        <div>
          <p className="font-medium">Expected contribution · Design intent</p>
          <p className="mt-1">{fit.contribution.evidence_question || "Evidence question not documented."}</p>
          {fit.contribution.description ? <p className="mt-1 text-muted-foreground">{fit.contribution.description}</p> : null}
          <p className="mt-1 text-muted-foreground">
            Lifecycle: {fit.contribution.status}. {fit.contribution.counts_toward_addressing ? "Eligible to contribute under the coverage engine's lifecycle rules." : "Does not currently count under the coverage engine's lifecycle rules."}
            {fit.contribution.evidence_available ? ` Recorded evidence-availability date: ${fit.contribution.evidence_available}.` : " Evidence-availability date not documented."}
            {" "}Delivery of evidence has not been verified by this view.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[12px]">
            <caption className="pb-2 text-left font-medium text-foreground">Documented fit by requirement</caption>
            <thead><tr className="text-muted-foreground">
              <th scope="col" className="py-1 pr-3 font-medium">Requirement</th>
              <th scope="col" className="py-1 pr-3 font-medium">Recorded fit and rationale</th>
              <th scope="col" className="py-1 font-medium">Documented tactic design</th>
            </tr></thead>
            <tbody>{fit.dimensions.map(row => (
              <tr key={row.dimension} className="border-t border-border align-top">
                <th scope="row" className="min-w-40 py-2 pr-3 font-normal">
                  <p className="font-medium">{DIMENSION_LABELS[row.dimension]}</p>
                  <p className="mt-1 text-muted-foreground">{row.requirement.requirement || "Requirement not documented."}</p>
                  <p className="mt-1 text-muted-foreground">Applicability: {row.requirement.applicability === "undetermined" ? "not yet determined" : row.requirement.applicability.replaceAll("_", " ")}</p>
                  {row.requirement.rationale ? <p className="mt-1 text-muted-foreground">{row.requirement.rationale}</p> : null}
                  {row.requirement.conflicts.length > 0 ? <p className="mt-1">Sourced conflicts: {row.requirement.conflicts.join("; ")}. {row.requirement.resolution || "Resolution not recorded."}</p> : null}
                </th>
                <td className="min-w-48 py-2 pr-3">
                  <p>{FIT_LABELS[row.fit]}</p>
                  <p className="mt-1 text-muted-foreground">{row.rationale || "Assessment rationale not recorded."}</p>
                  <p className="mt-1 text-muted-foreground">Dimension: {confirmationText(row.confirmation)}</p>
                </td>
                <td className="min-w-36 py-2 text-muted-foreground">{row.documented_tactic || "Not documented; no match or mismatch inferred."}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
        <div>
          <p className="font-medium">Unanswered requirements for this tactic</p>
          {unanswered.length ? <ul className="mt-1 list-disc space-y-1 pl-5">
            {unanswered.map(row => <li key={row.dimension}>
              {DIMENSION_LABELS[row.dimension]}: {row.requirement.applicability === "undetermined" ? "requirement applicability is unresolved" : FIT_LABELS[row.fit]}.
              {row.rationale ? ` ${row.rationale}` : " No assessment rationale recorded."}
              {row.requirement.conflicts.length > 0 && !row.requirement.resolution.trim() ? " Requirement conflicts remain unresolved." : ""}
            </li>)}
          </ul> : <p className="mt-1 text-muted-foreground">No unanswered requirements in the recorded dimensions. Human confirmation and freshness remain separate above.</p>}
          <p className="mt-2 text-muted-foreground">Other tactics do not erase these relationship-specific answers. Combined remaining need is determined by the gap coverage engine.</p>
        </div>
      </section>
    </details>
  );
}
