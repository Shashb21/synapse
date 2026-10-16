/** Manual cited support and discrepancy controls shared by source, gap and tactic contexts. */
import Link from "next/link";
import { ActionDialog, type ActionField, type ActionIdentity } from "@/components/platform/action-dialog";
import { SOURCE_CORRECTION_FIELDS, sourceReviewCitationCurrent, sourceReviewTargetVersion } from "@/lib/iegp/source-review";
import type { IegpState } from "@/lib/iegp/types";

/** Display retained citations, pending challenges, and explicit human resolution workflows. */
export function SourceClaimReview({ state, identity, canReview, sourceId, gapId, tacticId }: {
  state: IegpState; identity: ActionIdentity; canReview: boolean; sourceId?: string; gapId?: string; tacticId?: string;
}) {
  const rows = (state.source_reviews ?? []).filter(r => (!sourceId || r.source_id === sourceId) && (!gapId || r.gap_id === gapId) && (!tacticId || r.tactic_id === tacticId));
  const relationships = state.coverages.filter(c => (!gapId || c.gap_id === gapId) && (!tacticId || c.tactic_id === tacticId));
  const blocks = state.blocks.filter(b => !sourceId || b.source_id === sourceId);
  const payload = { source_id: sourceId, gap_id: gapId, tactic_id: tacticId };
  const fields: ActionField[] = [
    { name: "block_id", label: "Retained source block", type: "select", required: true, options: [{ value: "", label: "Choose a retained source block" }, ...blocks.map(b => ({ value: b.id, label: `${state.sources.find(s => s.id === b.source_id)?.title ?? b.source_id} · ${b.heading} · ${b.id}` }))] },
    { name: "passage", label: "Exact supporting passage", type: "textarea", required: true, hint: "Copy the relevant text from the retained block." },
    { name: "coverage_id", label: "Affected relationship", type: "select", required: !gapId && !tacticId, options: [{ value: "", label: gapId ? "This gap and its relationships" : tacticId ? "This tactic and its relationships" : "Choose the affected relationship" }, ...relationships.map(c => ({ value: c.id, label: `${c.gap_id} · ${state.gaps.find(g => g.id === c.gap_id)?.name} ↔ ${state.tactics.find(t => t.id === c.tactic_id)?.name}${c.expansion_id ? ` · ${c.expansion_id}` : ""}` }))] },
  ];
  return <section aria-label="Cited source review" className="my-6 space-y-3 break-words">
    <h2 className="text-base font-semibold">Cited source review</h2>
    <p className="text-sm text-muted-foreground">Attach support or flag a possible discrepancy by hand. A pending discrepancy challenges current confirmation while retaining the recorded judgement and gap status.</p>
    {canReview && blocks.length ? <div className="flex flex-wrap gap-2">
      <ActionDialog endpoint="/api/iegp" payload={{ ...payload, action: "link_source_support" }} fields={fields} identity={identity} label="Attach supporting source" confirmLabel="Attach support" />
      <ActionDialog endpoint="/api/iegp" payload={{ ...payload, action: "create_source_discrepancy" }} fields={fields} identity={identity} label="Raise source discrepancy" confirmLabel="Raise discrepancy" />
    </div> : null}
    {rows.map(row => {
      const current = sourceReviewCitationCurrent(state, row);
      const resolution = { action: "resolve_source_discrepancy", review_id: row.id, expected_version: row.version };
      return <article key={row.id} className="space-y-2 rounded-md border border-border p-3 text-sm" data-testid="source-review">
        <p className="font-semibold">{row.status === "pending" ? "Pending source discrepancy — current confirmation challenged" : row.status === "linked" ? "Supporting source linked" : row.status === "accepted" ? "Source discrepancy accepted — correction recorded" : "Source discrepancy dismissed"}</p>
        <p><Link className="underline" href={`/sources/${row.source_id}`}>{row.source_title}</Link> · {row.source_location} · {row.block_id}</p>
        <blockquote className="border-l-2 border-border pl-3">“{row.passage}”</blockquote>
        {!current ? <p role="status" className="font-medium">The current source no longer matches this saved citation. Acceptance is blocked; the original passage remains on record.</p> : null}
        <p>{row.rationale}</p>
        <p className="text-xs text-muted-foreground">{row.origin === "ai" ? "AI proposal" : "Human submission"} · {row.created_by.name} · {row.created_at}</p>
        <p>{row.gap_id ? <Link className="underline" href={`/gaps/${row.gap_id}`}>{row.gap_id}</Link> : null}{row.tactic_id ? <> · <Link className="underline" href={`/tactics/${row.tactic_id}`}>{row.tactic_id}</Link></> : null}{row.coverage_id ? ` · Relationship ${row.coverage_id}` : " · All affected relationships"}</p>
        {row.status === "pending" && canReview ? <div className="flex flex-wrap gap-2">
          <ActionDialog endpoint="/api/iegp" payload={{ ...resolution, decision: "dismiss" }} identity={identity} label="Dismiss discrepancy" confirmLabel="Dismiss discrepancy" description="Explain why the cited passage does not require a correction. The recorded coverage remains unchanged." />
          {current ? (["gap", "tactic"] as const).map(target => {
            const record = target === "gap" ? state.gaps.find(g => g.id === row.gap_id) : state.tactics.find(t => t.id === row.tactic_id);
            if (!record) return null;
            return <ActionDialog key={target} endpoint="/api/iegp" payload={{ ...resolution, decision: "accept", correction_target: target, expected_target_version: sourceReviewTargetVersion(state, row, target) }} identity={identity} label={`Review ${target} correction`} confirmLabel="Accept reviewed correction"
              description="Review the current value, enter the source-backed correction and explain your decision. A substantive change makes affected coverage outdated until reassessed."
              fields={[
                { name: "correction_field", label: "Field to correct", type: "select", options: SOURCE_CORRECTION_FIELDS[target].map(field => ({ value: field, label: `${field.replaceAll("_", " ")} · Current: ${String((record as unknown as Record<string, unknown>)[field] ?? "Not recorded")}` })) },
                { name: "correction_value", label: "Reviewed correction", type: "textarea", required: true },
                { name: "reviewed_change", label: "I reviewed the underlying change against the cited source", type: "select", required: true, options: [{ value: "", label: "Review before accepting" }, { value: "true", label: "Yes, I explicitly reviewed this correction" }] },
              ]} />;
          }) : null}
        </div> : null}
        {row.history.length ? <details><summary className="cursor-pointer">Human decision history</summary><ol className="mt-2 space-y-2">{row.history.map((event, index) => <li key={index}>
          <p>{event.decision === "accept" ? "Accepted" : "Dismissed"} by {event.actor.name} · {event.at}</p><p>{event.rationale}</p>
          {event.correction ? <p>{event.correction.target} {event.correction.field}: {event.correction.before || "Not recorded"} → {event.correction.value}</p> : null}
        </li>)}</ol></details> : null}
      </article>;
    })}
  </section>;
}
