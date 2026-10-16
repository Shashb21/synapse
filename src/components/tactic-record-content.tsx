"use client";

import { useImperativeHandle, useState, type RefObject } from "react";
import Link from "next/link";
import { CoverageBadge, LockMeta, TacticBadge } from "@/components/iegp-badges";
import { ActionDialog, type ActionIdentity } from "@/components/platform/action-dialog";
import { EntityHistory } from "@/components/entity-history";
import { useTacticDraftGuard, type TacticDraftGuard } from "@/components/tactic-ideation/use-tactic-draft-guard";
import { TacticEditor } from "@/components/tactic-ideation/tactic-editor";
import { ASSESSED_COVERAGE, COVERAGE_DIMENSIONS, DIMENSION_LABELS, DIMENSION_VALUES, OVERALL_COVERAGE_LABELS, TACTIC_STATUSES } from "@/lib/iegp/enums";
import { isLiveGap } from "@/lib/iegp/engine";
import type { TacticRecord } from "@/lib/iegp/tactic-record";

/** Current information and responsible editors shared by the panel and full record. */
export function TacticRecordContent({ record, identity = { signed_in: true, actor_name: "", actor_function: "medical_affairs" }, panel = true,
  onDirtyChange, onPendingChange, onClose, onSaved, onRefresh, draftGuardRef }: {
  draftGuardRef?: RefObject<TacticDraftGuard | null>;
  record: TacticRecord; identity?: ActionIdentity; panel?: boolean;
  onDirtyChange?: (dirty: boolean) => void; onPendingChange?: (pending: boolean) => void;
  onClose?: () => void; onSaved?: () => void; onRefresh?: () => void;
}) {
  const [editing, setEditing] = useState(panel);
  const guard = useTacticDraftGuard();
  useImperativeHandle(draftGuardRef, () => ({ allowDiscard: guard.allowDiscard, reset: guard.reset }), [guard.allowDiscard, guard.reset]);
  const tactic = record.tactic;
  const expansions = record.expansions;
  const maps = record.coverages.filter(row => row.gap && isLiveGap(row.gap));
  return <div className="grid min-w-0 gap-4" data-testid="tactic-record-content">
    <h2 className="font-medium">{tactic.name}</h2>
    <p>{tactic.description}</p>
    <div className="flex flex-wrap items-center gap-2"><TacticBadge status={tactic.status} /><span>Review: {tactic.review_status}</span><LockMeta lock={tactic.lock} /></div>
      <dl className="mb-6 grid gap-2 text-[13px] sm:grid-cols-2">
        <Item k="Tactic evidence question" v={tactic.evidence_question} />
        <Item k="Population" v={tactic.population} />
        <Item k="Intervention" v={tactic.intervention} />
        <Item k="Comparator" v={tactic.comparator} />
        <Item k="Outcomes" v={tactic.outcomes} />
        <Item k="Geography" v={tactic.geography} />
        <Item k="Design" v={tactic.study_design} />
        <Item k="Data source" v={tactic.data_source} />
        <Item k="Start date" v={tactic.start_date ?? "—"} />
        <Item k="Evidence available" v={tactic.evidence_available ?? "—"} />
        {tactic.source_quote ? <Item k="Source quote" v={`“${tactic.source_quote}”`} /> : null}
        <Item k="Owner" v={`${tactic.owner} · ${tactic.function.replaceAll("_", " ")}`} />
        <Item k="Budget" v={tactic.budget ?? "—"} />
      </dl>
      {record.source_references.length ? <section aria-label="Tactic source references" className="my-6 space-y-2"><h2 className="text-base font-semibold">Source references</h2>{record.source_references.map(ref => <blockquote key={ref.id} className="text-sm break-words">“{ref.quote}” · <Link href={`/sources/${encodeURIComponent(ref.source_id)}`}>{ref.title}</Link></blockquote>)}</section> : null}
      <section aria-label="Gaps this tactic is mapped to"><h2 className="mb-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Gaps this tactic is mapped to</h2>
      <div className="mb-6 grid gap-2">
        {maps.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">No mappings yet.</p>
        ) : (
          maps.map((c) => {
            const gap = c.gap;
            return (
              <Link key={c.id} href={`/gaps/${c.gap_id}`} className="flex justify-between border border-border bg-card p-3 no-underline rounded-lg">
                <span>{gap?.name}{c.expansion_id ? ` · ${expansions.find(e => e.id === c.expansion_id)?.scope.name ?? "Expansion"}` : ""}</span>
                <CoverageBadge overall={c.overall} />
              </Link>
            );
          })
        )}
      </div>
      </section>
      {expansions.length > 0 ? <section className="mb-6" aria-label="Tactic expansions">
        <h2 className="mb-2 text-sm font-semibold">Expansions</h2>
        {expansions.map((child) => <div id={child.id} key={child.id} className="mb-4 border-t border-border pt-3">
          <h3 className="text-sm font-medium">{child.scope.name}</h3>
          <p className="mb-2 text-[13px]">{child.status} · {["planned", "ongoing", "completed"].includes(child.status) ? "Eligible for coverage review" : "Does not count toward coverage"}</p>
          <dl className="mb-3 grid gap-2 text-[13px] sm:grid-cols-2">
            <Item k="Added question" v={child.scope.evidence_question} />
            <Item k="Gap coverage" v={child.scope.gap_coverage} />
            <Item k="Population" v={child.scope.population} />
            <Item k="Outcomes" v={child.scope.outcomes} />
            <Item k="Geography" v={child.scope.geography} />
            <Item k="Data cut" v={child.scope.data_cut} />
            <Item k="Analysis" v={child.scope.analysis} />
            <Item k="Instrument" v={child.scope.instrument} />
            <Item k="Design" v={child.scope.study_design} />
            <Item k="Cost / effort" v={child.scope.cost_effort} />
            <Item k="Timing" v={child.scope.timing} />
            <Item k="Feasibility risks" v={child.scope.feasibility_risks} />
            <Item k="Start date" v={child.scope.start_date} />
            <Item k="Evidence available" v={child.scope.evidence_available} />
            <Item k="Post-hoc analysis" v={child.scope.post_hoc ? "Yes" : "No"} />
            <Item k="Protocol amendment" v={child.scope.protocol_amendment ? "Required" : "Not required"} />
          </dl>
          {record.coverages.filter(c => c.expansion_id === child.id && c.tactic_id === child.tactic_id && child.gap_ids.includes(c.gap_id)).map(coverage => <div key={coverage.id} className="mb-3 text-[13px]">
            <p className="mb-2">Coverage for {coverage.gap?.name ?? coverage.gap_id}</p>
            <div className="mb-2 flex flex-wrap items-center gap-2"><CoverageBadge overall={coverage.overall} /><LockMeta lock={coverage.overall_lock} /></div>
            {record.permissions.coverage ? <ActionDialog onSuccess={onRefresh} protectUnsavedChanges endpoint="/api/iegp" payload={{action: "lock_overall", coverage_id: coverage.id, expected_relationship: coverage.relationship_version}}
              identity={identity} label="Review expansion coverage" title={`Review expansion coverage: ${child.scope.name}`}
              description="Validate the added scope's coverage for this gap. Proposed and cancelled expansions still do not count."
              confirmLabel="Validate coverage" fields={[{name: "overall", label: "Overall", type: "select", required: true,
                defaultValue: coverage.overall === "unassessed" ? "" : coverage.overall,
                options: [{value: "", label: "Choose coverage"}, ...ASSESSED_COVERAGE.map(value => ({value, label: OVERALL_COVERAGE_LABELS[value]}))]}]} /> : null}
            <details className="mt-2"><summary>Coverage dimensions</summary>
              <dl className="mt-2 grid gap-2 sm:grid-cols-2">{COVERAGE_DIMENSIONS.map(dimension => <div key={dimension}>
                <dt>{DIMENSION_LABELS[dimension]}</dt><dd className="mb-1">{coverage.dimensions[dimension].value}</dd>
                {record.permissions.coverage ? <ActionDialog onSuccess={onRefresh} protectUnsavedChanges endpoint="/api/iegp" payload={{action: "lock_dimension", coverage_id: coverage.id, expected_relationship: coverage.relationship_version, dimension}}
                  identity={identity} label={`Review ${DIMENSION_LABELS[dimension]}`} title={`Review ${DIMENSION_LABELS[dimension]}: ${child.scope.name}`}
                  confirmLabel="Validate dimension" fields={[{name: "value", label: "Assessment", type: "select", defaultValue: coverage.dimensions[dimension].value,
                    options: DIMENSION_VALUES.map(value => ({value, label: value}))}]} /> : null}
              </div>)}</dl>
            </details>
          </div>)}
          {record.permissions.edit ? <ActionDialog onSuccess={onRefresh} protectUnsavedChanges endpoint="/api/plan" payload={{action: "set_expansion_status", expansion_id: child.id, expected_version: child.version}}
            identity={identity} label="Change expansion status" title={`Status: ${child.scope.name}`}
            description="Planned, ongoing and completed scope is eligible for coverage review. Full coverage still requires human validation."
            confirmLabel="Save status" fields={[{name: "status", label: "Status", type: "select", defaultValue: child.status,
              options: TACTIC_STATUSES.map(status => ({value: status, label: status}))}]} /> : null}
          <details className="mt-3 text-[13px]"><summary>Scope history</summary>
            <p>Origin: {child.proposal_id}</p>
            <ul className="mt-2 grid gap-1">{child.history.map(event => <li key={event.version}>
              {event.at} · {event.actor.name} · {event.status}: {event.rationale}
            </li>)}</ul>
          </details>
        </div>)}
      </section> : null}
    {record.permissions.edit ? <div className="flex flex-wrap gap-2">
      {!editing ? <button type="button" className="underline" onClick={() => setEditing(true)}>Edit tactic</button> : null}
      {(["accepted", "rejected"] as const).filter(status => status !== tactic.review_status).map(status => <ActionDialog key={status} onSuccess={onRefresh} protectUnsavedChanges
        endpoint="/api/iegp" payload={{ action: "lock_tactic_review", tactic_id: tactic.id, expected_tactic: record.version, review_status: status }}
        identity={identity} label={status === "accepted" ? "Accept tactic" : "Reject tactic"}
        description={status === "accepted" ? "Accepts this tactic into the library. The decision is locked to you." : "Marks this tactic rejected: it stays on record but is not a real study for this plan."}
        confirmLabel={status === "accepted" ? "Accept" : "Reject"} />)}
    </div> : <p>Read-only. Your role cannot edit this tactic.</p>}
    {record.permissions.edit && editing ? <TacticEditor tactic={tactic} version={record.version} identity={identity} inUse={record.custom_types}
      onDirtyChange={dirty => { guard.setDirty(dirty); onDirtyChange?.(dirty); }}
      onPendingChange={pending => { guard.setPending(pending); onPendingChange?.(pending); }}
      onClose={onClose ?? (() => { if (guard.allowDiscard()) { guard.reset(); setEditing(false); } })}
      onSaved={() => { guard.reset(); if (onSaved) onSaved(); else setEditing(false); }} /> : null}
    <details aria-label="History" className="border-t border-border pt-3">
      <summary className="cursor-pointer font-medium">History</summary>
      <EntityHistory entries={record.history} />
    </details>
  </div>;
}

function Item({ k, v }: { k: string; v: string | null | undefined }) {
  return (
    <div>
      <dt className="text-[11px] text-muted-foreground">{k}</dt>
      {/* An empty field reads "—", like the dates and budget, not a blank line. */}
      <dd className="text-foreground">{v?.trim() ? v : "—"}</dd>
    </div>
  );
}
