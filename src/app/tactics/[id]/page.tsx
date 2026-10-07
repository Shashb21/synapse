import { notFound } from "next/navigation";
import Link from "next/link";
import { AppShell, PageIntro } from "@/components/app-shell";
import { CoverageBadge, LockMeta, TacticBadge } from "@/components/iegp-badges";
import { LockForm } from "@/components/lock-form";
import { ActionDialog, type ActionIdentity } from "@/components/platform/action-dialog";
import { isLiveGap } from "@/lib/iegp/engine";
import { ASSESSED_COVERAGE, COVERAGE_DIMENSIONS, DIMENSION_LABELS, DIMENSION_VALUES, OVERALL_COVERAGE_LABELS, TACTIC_STATUSES, TACTIC_TYPE_LABELS, TACTIC_TYPES } from "@/lib/iegp/enums";
import { loadState } from "@/lib/iegp/store";
import { sessionContext } from "@/modules/auth/session";

export const dynamic = "force-dynamic";

export default async function TacticDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [state, session] = await Promise.all([loadState(), sessionContext()]);
  const tactic = state.tactics.find((x) => x.id === id);
  if (!tactic) notFound();
  // Only live gaps: a split or rewritten parent is retired into version history.
  const maps = state.coverages.filter((c) => {
    const gap = state.gaps.find((g) => g.id === c.gap_id);
    return c.tactic_id === tactic.id && gap !== undefined && isLiveGap(gap);
  });
  const expansions = state.expansions.filter((e) => e.tactic_id === tactic.id);
  const identity: ActionIdentity = {
    signed_in: session.signed_in,
    actor_name: session.actor.name,
    actor_function: session.actor.function,
  };

  return (
    <AppShell active="tactics">
      <PageIntro
        kicker={tactic.custom_type ? `${tactic.custom_type.label} · counts as ${TACTIC_TYPE_LABELS[tactic.type]}` : TACTIC_TYPE_LABELS[tactic.type]}
        title={tactic.name}
      >
        {tactic.description}
      </PageIntro>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <TacticBadge status={tactic.status} />
        <span className="text-[11px] capitalize text-muted-foreground">
          Review: {tactic.review_status}
        </span>
        <LockMeta lock={tactic.lock} />
      </div>
      <div className="mb-6 flex flex-wrap items-center gap-2">
        <ActionDialog
          endpoint="/api/iegp"
          payload={{ action: "modify_tactic", tactic_id: tactic.id }}
          identity={identity}
          label="Edit tactic"
          title={`Edit ${tactic.id}`}
          description="Your values replace the current ones and are locked to you. AI re-runs never rewrite an existing tactic; the Timeline uses the dates you enter here."
          confirmLabel="Save edit"
          fields={[
            { name: "name", label: "Name", defaultValue: tactic.name, required: true },
            {
              name: "type",
              label: "Type",
              type: "select",
              defaultValue: tactic.type,
              options: TACTIC_TYPES.map((type) => ({ value: type, label: TACTIC_TYPE_LABELS[type] })),
            },
            { name: "evidence_question", label: "Evidence question", type: "textarea", defaultValue: tactic.evidence_question, required: true },
            { name: "population", label: "Population", defaultValue: tactic.population },
            { name: "intervention", label: "Intervention", defaultValue: tactic.intervention },
            { name: "comparator", label: "Comparator", defaultValue: tactic.comparator },
            { name: "outcomes", label: "Outcomes", defaultValue: tactic.outcomes },
            { name: "study_design", label: "Study design", defaultValue: tactic.study_design },
            { name: "data_source", label: "Data source", defaultValue: tactic.data_source },
            { name: "geography", label: "Geography", defaultValue: tactic.geography },
            { name: "start_date", label: "Start date (YYYY-MM-DD, blank for none)", placeholder: "2026-01-15", defaultValue: tactic.start_date ?? "" },
            {
              name: "evidence_available",
              label: "Evidence available (YYYY-MM-DD, blank for none)",
              placeholder: "2027-06-30",
              defaultValue: tactic.evidence_available ?? "",
            },
          ]}
        />
        {tactic.review_status !== "accepted" ? (
          <ActionDialog
            endpoint="/api/iegp"
            payload={{ action: "lock_tactic_review", tactic_id: tactic.id, review_status: "accepted" }}
            identity={identity}
            label="Accept tactic"
            description="Accepts this tactic into the library. The decision is locked to you."
            confirmLabel="Accept"
          />
        ) : null}
        {tactic.review_status !== "rejected" ? (
          <ActionDialog
            endpoint="/api/iegp"
            payload={{ action: "lock_tactic_review", tactic_id: tactic.id, review_status: "rejected" }}
            identity={identity}
            label="Reject tactic"
            description="Marks this tactic rejected: it stays on record but is not a real study for this plan."
            confirmLabel="Reject"
          />
        ) : null}
      </div>
      <dl className="mb-6 grid gap-2 text-[13px] sm:grid-cols-2">
        <Item k="Question" v={tactic.evidence_question} />
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
      <h2 className="mb-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Gaps this tactic is mapped to</h2>
      <div className="mb-6 grid gap-2">
        {maps.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">No mappings yet.</p>
        ) : (
          maps.map((c) => {
            const gap = state.gaps.find((g) => g.id === c.gap_id);
            return (
              <Link key={c.id} href={`/gaps/${c.gap_id}`} className="flex justify-between border border-border bg-card p-3 no-underline rounded-lg">
                <span>{gap?.name}{c.expansion_id ? ` · ${expansions.find(e => e.id === c.expansion_id)?.scope.name ?? "Expansion"}` : ""}</span>
                <CoverageBadge overall={c.overall} />
              </Link>
            );
          })
        )}
      </div>
      {expansions.length > 0 ? <section className="mb-6" aria-label="Tactic expansions">
        <h2 className="mb-2 text-sm font-semibold">Expansions</h2>
        {expansions.map((child) => <div key={child.id} className="mb-4 border-t border-border pt-3">
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
          {state.coverages.filter(c => c.expansion_id === child.id && c.tactic_id === child.tactic_id && child.gap_ids.includes(c.gap_id)).map(coverage => <div key={coverage.id} className="mb-3 text-[13px]">
            <p className="mb-2">Coverage for {state.gaps.find(g => g.id === coverage.gap_id)?.name ?? coverage.gap_id}</p>
            <div className="mb-2 flex flex-wrap items-center gap-2"><CoverageBadge overall={coverage.overall} /><LockMeta lock={coverage.overall_lock} /></div>
            <ActionDialog endpoint="/api/iegp" payload={{action: "lock_overall", coverage_id: coverage.id}}
              identity={identity} label="Review expansion coverage" title={`Review expansion coverage: ${child.scope.name}`}
              description="Validate the added scope's coverage for this gap. Proposed and cancelled expansions still do not count."
              confirmLabel="Validate coverage" fields={[{name: "overall", label: "Overall", type: "select", required: true,
                defaultValue: coverage.overall === "unassessed" ? "" : coverage.overall,
                options: [{value: "", label: "Choose coverage"}, ...ASSESSED_COVERAGE.map(value => ({value, label: OVERALL_COVERAGE_LABELS[value]}))]}]} />
            <details className="mt-2"><summary>Coverage dimensions</summary>
              <dl className="mt-2 grid gap-2 sm:grid-cols-2">{COVERAGE_DIMENSIONS.map(dimension => <div key={dimension}>
                <dt>{DIMENSION_LABELS[dimension]}</dt><dd className="mb-1">{coverage.dimensions[dimension].value}</dd>
                <ActionDialog endpoint="/api/iegp" payload={{action: "lock_dimension", coverage_id: coverage.id, dimension}}
                  identity={identity} label={`Review ${DIMENSION_LABELS[dimension]}`} title={`Review ${DIMENSION_LABELS[dimension]}: ${child.scope.name}`}
                  confirmLabel="Validate dimension" fields={[{name: "value", label: "Assessment", type: "select", defaultValue: coverage.dimensions[dimension].value,
                    options: DIMENSION_VALUES.map(value => ({value, label: value}))}]} />
              </div>)}</dl>
            </details>
          </div>)}
          <ActionDialog endpoint="/api/plan" payload={{action: "set_expansion_status", expansion_id: child.id, expected_version: child.version}}
            identity={identity} label="Change expansion status" title={`Status: ${child.scope.name}`}
            description="Planned, ongoing and completed scope is eligible for coverage review. Full coverage still requires human validation."
            confirmLabel="Save status" fields={[{name: "status", label: "Status", type: "select", defaultValue: child.status,
              options: TACTIC_STATUSES.map(status => ({value: status, label: status}))}]} />
          <details className="mt-3 text-[13px]"><summary>Scope history</summary>
            <p>Origin: {child.proposal_id}</p>
            <ul className="mt-2 grid gap-1">{child.history.map(event => <li key={event.version}>
              {event.at} · {event.actor.name} · {event.status}: {event.rationale}
            </li>)}</ul>
          </details>
        </div>)}
      </section> : null}
      <LockForm label="Lock tactic status" action="lock_tactic" extra={{ tactic_id: tactic.id }}>
        <p className="text-[12px] text-muted-foreground">
          Changing status recomputes related gap status. Residuals stay open for a human to
          reassess. Nothing auto-closes.
        </p>
        <label className="grid gap-1 text-[12px] text-muted-foreground">
          Status
          <select name="status" defaultValue={tactic.status} className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm">
            {TACTIC_STATUSES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </label>
      </LockForm>
    </AppShell>
  );
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
