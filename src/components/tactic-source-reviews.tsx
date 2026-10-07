/** Source review queue reuses the existing rationale/actor dialog and keeps tactic ownership separate. */
import Link from "next/link";
import { ActionDialog, type ActionField, type ActionIdentity } from "@/components/platform/action-dialog";
import type { IegpState, TacticSuggestion } from "@/lib/iegp/types";
import { tacticVersion } from "@/lib/iegp/tactic-expansions";

const scopeLabels = {name: "Name", evidence_question: "Evidence question", population: "Population", outcomes: "Endpoints", geography: "Geography", data_cut: "Data cut", analysis: "Analysis", instrument: "Instrument", study_design: "Study design", gap_coverage: "Gap coverage", cost_effort: "Incremental cost / effort", timing: "Timing", feasibility_risks: "Feasibility risks", start_date: "Start date", evidence_available: "Evidence available"} as const;
const requiredScope = new Set(["name", "evidence_question", "study_design", "gap_coverage", "cost_effort", "timing", "feasibility_risks"]);
/** Current versus proposed scope, edit controls, rationale decisions and immutable review history. */
export function TacticSourceReviews({suggestions, state, identity, canReview}: {suggestions: TacticSuggestion[]; state: IegpState; identity: ActionIdentity; canReview: boolean}) {
  if (!suggestions.length) return null;
  const gapOptions = [{value: "", label: "Select before accepting expansion"}, ...state.gaps.filter(g => !g.retired && g.status !== "excluded" && !g.parked_at).map(g => ({value: g.id, label: `${g.id} · ${g.name}`}))];
  return <section aria-label="Source tactic reviews" className="mt-8 space-y-4">
    <h2 className="text-base font-semibold">Source tactic reviews</h2>
    <p className="max-w-prose text-sm">These source activities overlap the tactic library. Review the added scope, then expand the existing tactic, record a separate linked tactic or reject the suggestion.</p>
    {suggestions.map(row => {
      const parent = state.tactics.find(t => t.id === row.target_tactic_id);
      const stale = !parent || tacticVersion(parent) !== row.expected_tactic_version;
      const source = state.sources.find(s => s.id === row.source_id);
      const fields: ActionField[] = [{name: "gap_id", label: "Gap to cover", type: "select", defaultValue: row.gap_id ?? "", options: gapOptions}, ...Object.entries(scopeLabels).map(([key, label]): ActionField => ({name: key, label, type: key === "start_date" || key === "evidence_available" ? "text" : "textarea", defaultValue: row.expansion[key as keyof typeof scopeLabels] ?? "", required: requiredScope.has(key)})), ...(["post_hoc", "prospective_enrolment", "protocol_amendment"] as const).map((key): ActionField => ({name: key, label: key === "post_hoc" ? "Post-hoc analysis" : key === "prospective_enrolment" ? "Prospective enrolment" : "Protocol amendment", type: "select", defaultValue: row.expansion[key] ? "yes" : "no", options: [{value: "no", label: "No"}, {value: "yes", label: "Yes"}]}))];
      const payload = {suggestion_id: row.id, expected_version: row.version};
      return <article key={row.id} className="rounded-lg border border-border bg-card p-4 text-sm space-y-3 break-words">
        <div className="flex flex-wrap justify-between gap-2"><h3 className="font-semibold">Expand: <Link href={`/tactics/${row.target_tactic_id}`}>{row.reviewed_parent.name}</Link></h3><span>{row.status}</span></div>
        <p className="text-xs text-muted-foreground">Review {row.id} · Source: {source?.title ?? row.source_id}</p>
        <blockquote>“{row.source_quote}”</blockquote>
        <div className="grid gap-4 md:grid-cols-2">
          <div><h4 className="font-semibold">Current scope at review</h4><p>{row.reviewed_parent.evidence_question}</p><p>{row.reviewed_parent.study_design || "Design not recorded"}</p><p>Population: {row.reviewed_parent.population || "Not recorded"}</p><p>Endpoints: {row.reviewed_parent.outcomes || "Not recorded"}</p><p>Geography: {row.reviewed_parent.geography || "Not recorded"}</p><p>Data source: {row.reviewed_parent.data_source || "Not recorded"}</p><p>Parent status: {row.reviewed_parent.status} · {row.reviewed_parent.lock.locked ? "Human locked" : "Unlocked"}</p><p>Shared scope: {row.shared_scope}</p></div>
          <div><h4 className="font-semibold">Proposed added scope</h4><p>{row.expansion.evidence_question}</p><p>{row.expansion.study_design}</p><p>Added scope: {row.new_scope}</p><p>Initially proposed · Does not count toward coverage</p></div>
        </div>
        <details><summary className="cursor-pointer">Added scope and feasibility details</summary><dl className="mt-2 grid gap-x-4 gap-y-2 sm:grid-cols-2">{Object.entries(scopeLabels).map(([key,label]) => <div key={key}><dt className="font-medium">{label}</dt><dd>{row.expansion[key as keyof typeof scopeLabels] || "Not specified"}</dd></div>)}<div><dt className="font-medium">Scope flags</dt><dd>Post-hoc: {row.expansion.post_hoc ? "Yes" : "No"}; prospective enrolment: {row.expansion.prospective_enrolment ? "Yes" : "No"}; protocol amendment: {row.expansion.protocol_amendment ? "Yes" : "No"}</dd></div></dl></details>
        <p>Gap: {state.gaps.find(g => g.id === row.gap_id)?.name ?? "Select a gap before accepting expansion"}</p>
        <div><h4 className="font-semibold">Separate linked tactic option</h4><p>{row.separate.name} · {row.separate.status}</p><p>{row.separate.evidence_question}</p></div>
        {row.status === "pending" && stale ? <p role="alert">The parent tactic changed after this review snapshot. Acceptance is blocked. Reject this obsolete suggestion or review a new source proposal.</p> : null}
        {row.status === "pending" && canReview ? <div className="flex flex-wrap gap-2">
          {!stale ? <>
            <ActionDialog endpoint="/api/plan" payload={{...payload, action: "edit_tactic_suggestion", option: "expansion"}} identity={identity} label="Edit expansion scope" confirmLabel="Save review edits" description="Save the added scope and select the gap it covers. The parent design and review snapshot stay intact." fields={fields} />
            <ActionDialog endpoint="/api/plan" payload={{...payload, action: "edit_tactic_suggestion", option: "separate"}} identity={identity} label="Edit separate option" confirmLabel="Save review edits" fields={[{name: "name", label: "Name", defaultValue: row.separate.name, required: true}, {name: "evidence_question", label: "Evidence question", type: "textarea", defaultValue: row.separate.evidence_question, required: true}]} />
            <ActionDialog endpoint="/api/plan" payload={{...payload, action: "decide_tactic_suggestion", decision: "expand"}} identity={identity} label="Accept expansion" confirmLabel="Accept expansion" description="Creates a proposed activity under the existing tactic. Added coverage remains noncounting until its independent lifecycle advances." />
            <ActionDialog endpoint="/api/plan" payload={{...payload, action: "decide_tactic_suggestion", decision: "separate"}} identity={identity} label="Accept separate tactic" confirmLabel="Accept separate tactic" description="Records the documented activity as a separate linked tactic with the source-supported status." />
          </> : null}
          <ActionDialog endpoint="/api/plan" payload={{...payload, action: "decide_tactic_suggestion", decision: "reject"}} identity={identity} label="Reject suggestion" confirmLabel="Reject suggestion" description="Preserves this source and rejection for later review and learning." />
        </div> : null}
        {row.result_expansion_id ? <Link href={`/tactics/${row.target_tactic_id}#${row.result_expansion_id}`} className="underline">Review accepted expansion</Link> : null}
        {row.result_tactic_id ? <Link href={`/tactics/${row.result_tactic_id}`} className="underline">Open separate tactic</Link> : null}
        {row.history.length ? <details><summary className="cursor-pointer">Review history ({row.history.length})</summary><ul className="mt-2 space-y-2">{row.history.map((entry,index) => <li key={index}>{entry.action} · {entry.actor.name} · {entry.at}: {entry.rationale}</li>)}</ul></details> : null}
      </article>;
    })}
  </section>;
}
