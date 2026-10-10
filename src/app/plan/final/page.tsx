import "@/modules";
import Link from "next/link";
import { AppShell, PageIntro } from "@/components/app-shell";
import { planHistory, planVersion } from "@/modules/stages/s10-timeline/module";
import { finalPlanView, type FinalPlanView } from "@/modules/stages/s10-timeline/final-view";
import type { FinalPackage, TacticEvidenceState } from "@/modules/stages/s10-timeline/final-package";

export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<string, string> = {
  validated_open: "Open",
  validated_addressed: "Addressed",
  validated_partial: "Partially addressed",
};

/** Planned work is never read as evidence already in hand. */
const EVIDENCE_LABEL: Record<TacticEvidenceState, string> = {
  completed_evidence: "Completed — evidence generated",
  ongoing_work: "Ongoing — evidence not yet generated",
  planned_work: "Planned — evidence not yet generated",
  proposed_not_committed: "Proposed — not yet in the plan",
  cancelled: "Cancelled",
};

const ORIGIN_LABEL: Record<FinalPackage["evidence_tactics"][0]["origin"], string> = {
  source_document: "From a source document",
  recorded_missed: "Recorded by hand (missed in sources)",
  ideation: "Accepted from Tactic Ideation",
  added_by_hand: "Added by hand",
};

function Section({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  return (
    <section className="grid gap-3 rounded-md border border-border bg-card p-4">
      <h2 className="text-[15px] font-medium text-foreground">
        {title}
        {count !== undefined ? <span className="ml-2 text-[12px] text-muted-foreground">({count})</span> : null}
      </h2>
      {children}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-[13px] text-muted-foreground">{children}</p>;
}

function CompletePlan({ view }: { view: Extract<FinalPlanView, { kind: "complete" }> }) {
  const pkg = view.package;
  const gapName = new Map(pkg.evidence_gap_inventory.map((g) => [g.id, g.name]));
  const axisLabel = new Map(pkg.prioritisation.axes.map((a) => [a.id, a.label]));
  const open = pkg.open_items;
  return (
    <div className="grid gap-4">
      <Section title="Plan">
        <p className="text-[13px] text-foreground">
          {pkg.plan_context.asset.name} ({pkg.plan_context.asset.inn}) · {pkg.plan_context.asset.indication} ·{" "}
          {pkg.plan_context.asset.geography}
        </p>
        {pkg.plan_context.objectives.length > 0 ? (
          <ul className="list-disc pl-5 text-[13px] text-muted-foreground">
            {pkg.plan_context.objectives.map((o) => (
              <li key={o.id}>{o.title}</li>
            ))}
          </ul>
        ) : (
          <Empty>No strategic objectives were recorded.</Empty>
        )}
        <p className="text-[12px] text-muted-foreground">{pkg.workshop_outcomes.note}</p>
      </Section>

      <Section title="1. Evidence Gap Inventory" count={pkg.evidence_gap_inventory.length}>
        <ul className="grid gap-3">
          {pkg.evidence_gap_inventory.map((gap) => (
            <li key={gap.id} className="rounded-md border border-border p-3" data-testid="final-gap">
              <p className="text-[13px] font-medium text-foreground">
                {gap.id} · {gap.name}{" "}
                <span className="text-[12px] font-normal text-muted-foreground">
                  {STATUS_LABEL[gap.effective_status] ?? gap.effective_status}
                  {gap.override ? " (override)" : ""} · {gap.domain}
                </span>
              </p>
              <p className="mt-1 text-[13px] text-muted-foreground">{gap.statement}</p>
              <p className="mt-1 text-[12px] text-muted-foreground">
                Objective: {gap.objective?.title ?? "Not recorded"} · Confirmed{" "}
                {gap.confirmation.by ? `by ${gap.confirmation.by.name}` : "(before who confirmed was recorded)"}
                {gap.confirmation.at ? ` on ${gap.confirmation.at.slice(0, 10)}` : ""}
              </p>
              {gap.needs.length > 0 ? (
                <ul className="mt-2 grid gap-1 text-[12px] text-muted-foreground">
                  {gap.needs.map((need) => (
                    <li key={need.id}>
                      {need.role === "primary" ? "Source" : "Also raised in"}: {need.source?.title ?? "Added by hand"}
                      {need.quote ? ` — “${need.quote.length > 240 ? `${need.quote.slice(0, 240)}…` : need.quote}”` : ""}
                    </li>
                  ))}
                </ul>
              ) : null}
              {gap.coverages.length > 0 ? (
                <p className="mt-1 text-[12px] text-muted-foreground">
                  Mapped: {gap.coverages.map((c) => `${c.tactic_id} (${c.overall})`).join(", ")}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      </Section>

      <Section title="2. Evidence Tactics" count={pkg.evidence_tactics.length}>
        <ul className="grid gap-2">
          {pkg.evidence_tactics.map((tactic) => (
            <li key={tactic.id} className="rounded-md border border-border p-3 text-[13px]" data-testid="final-tactic">
              <p className="font-medium text-foreground">
                {tactic.id} · {tactic.name}{" "}
                <span className="text-[12px] font-normal text-muted-foreground">{EVIDENCE_LABEL[tactic.evidence_state]}</span>
              </p>
              <p className="text-[12px] text-muted-foreground">
                {ORIGIN_LABEL[tactic.origin]} · Owner: {tactic.owner || "Not recorded"} · Objective: {tactic.objective || "Not recorded"} ·
                Outputs: {tactic.outputs || "Not recorded"} · Timing: {tactic.timing.start_date ?? "—"} →{" "}
                {tactic.timing.evidence_available ?? "—"}
              </p>
              {tactic.gap_ids.length > 0 ? (
                <p className="text-[12px] text-muted-foreground">
                  Answers: {tactic.gap_ids.map((id) => gapName.get(id) ?? id).join("; ")}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      </Section>

      <Section title="3. Prioritisation" count={pkg.prioritisation.placements.length}>
        <p className="text-[12px] text-muted-foreground">
          Matrix axes: {axisLabel.get(pkg.prioritisation.x_axis) ?? pkg.prioritisation.x_axis} ×{" "}
          {axisLabel.get(pkg.prioritisation.y_axis) ?? pkg.prioritisation.y_axis}
        </p>
        <ul className="grid gap-1 text-[13px]">
          {pkg.prioritisation.placements.map((p) => (
            <li key={p.gap_id}>
              <span className="text-foreground">{gapName.get(p.gap_id) ?? p.gap_id}</span>
              <span className="text-muted-foreground">
                {" "}
                · {p.band ?? "no band"}
                {p.validated ? ` · validated${p.validated_by ? ` by ${p.validated_by}` : ""}` : " · not validated"}
                {p.rationale ? ` · ${p.rationale}` : ""}
              </span>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="4. Roadmap" count={pkg.roadmap.activities.length}>
        <p className="text-[12px] text-muted-foreground">
          {pkg.roadmap.window.start} → {pkg.roadmap.window.end} · roadmap fingerprint {pkg.roadmap.fingerprint_code}
        </p>
        <ul className="grid gap-1 text-[13px]">
          {pkg.roadmap.activities.map((a) => (
            <li key={a.id}>
              <span className="text-foreground">{a.tactic_name}</span>
              <span className="text-muted-foreground">
                {" "}
                · {a.start_date} → {a.end_date}
                {a.readout_date ? ` · readout ${a.readout_date}` : ""} · {a.lane}
                {a.depends_on.length > 0 ? ` · after ${a.depends_on.join(", ")}` : ""}
              </span>
            </li>
          ))}
        </ul>
        <p className="text-[12px] text-muted-foreground">
          <Link href={`/timeline?version=${view.version}`}>Open this version on the timeline</Link> to see the chart or export it as an
          image.
        </p>
      </Section>

      <Section title="5. Open items and limitations">
        <ul className="grid gap-1 text-[13px] text-muted-foreground" data-testid="final-limitations">
          {open.limitations.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        {(
          [
            ["Unscheduled", open.unscheduled.map((g) => `${g.gap_name}: ${g.reason}`)],
            ["No tactic yet", open.unaddressed.map((g) => g.gap_name)],
            ["Deferred", open.deferred.map((g) => g.gap_name)],
            ["Parked", open.parked.map((g) => `${g.gap_name}${g.reason ? `: ${g.reason}` : ""}`)],
            ["Excluded", open.excluded.map((g) => `${g.gap_name}${g.reason ? `: ${g.reason}` : ""}`)],
          ] as const
        ).map(([title, rows]) => (
          <div key={title}>
            <p className="text-[12px] font-medium text-foreground">
              {title} ({rows.length})
            </p>
            {rows.length > 0 ? (
              <ul className="list-disc pl-5 text-[12px] text-muted-foreground">
                {rows.map((row) => (
                  <li key={row}>{row}</li>
                ))}
              </ul>
            ) : (
              <Empty>None.</Empty>
            )}
          </div>
        ))}
      </Section>
    </div>
  );
}

function LegacyPlan({ view }: { view: Extract<FinalPlanView, { kind: "legacy" }> }) {
  return (
    <Section title="Roadmap only" count={view.timeline.activities.length}>
      <p className="text-[13px] text-foreground" data-testid="legacy-note">
        {view.legacy_note}.
      </p>
      <ul className="grid gap-1 text-[13px] text-muted-foreground">
        {view.timeline.activities.map((a) => (
          <li key={a.id}>
            {a.tactic_name} · {a.start_date} → {a.end_date}
          </li>
        ))}
      </ul>
      <p className="text-[12px] text-muted-foreground">
        <Link href={`/timeline?version=${view.version}`}>Open this version on the timeline</Link>.
      </p>
    </Section>
  );
}

export default async function FinalPlanPage({ searchParams }: { searchParams: Promise<{ version?: string }> }) {
  const { version } = await searchParams;
  const history = await planHistory(50);
  const finals = history.filter((entry) => entry.status === "final");
  const record = version ? await planVersion(Number(version)) : finals[0] ?? null;
  const view = record ? finalPlanView(record) : null;

  return (
    <AppShell active="timeline">
      <div className="mb-6 grid gap-2">
        <PageIntro kicker="Final plan" title="Integrated Evidence Generation Plan">
          The plan as it was saved as final: the evidence gap inventory, the tactics, the prioritisation, the roadmap, and what is
          still open. Nothing here changes when the live plan is edited; a new final is a new version.
        </PageIntro>
        {finals.length > 0 ? (
          <nav className="flex flex-wrap gap-2 text-[12px]" aria-label="Saved final versions">
            {finals.map((entry) => (
              <Link
                key={entry.id}
                href={`/plan/final?version=${entry.version}`}
                className={entry.version === record?.version ? "font-medium text-foreground" : "text-muted-foreground"}
              >
                v{entry.version} · {entry.saved_at.slice(0, 10)}
              </Link>
            ))}
          </nav>
        ) : null}
      </div>
      {!view ? (
        <Section title="No final plan yet">
          <Empty>
            {version
              ? `There is no saved plan v${version} in this workspace.`
              : "Nothing has been saved as final yet. Save the plan as final from the Gantt Timeline."}
          </Empty>
        </Section>
      ) : (
        <div className="grid gap-4">
          <p className="text-[12px] text-muted-foreground" data-testid="final-meta">
            v{view.version} · {view.status === "final" ? "Final" : "Draft"} · saved by {view.saved_by} on {view.saved_at.slice(0, 10)}
            {view.note ? ` · “${view.note}”` : ""}
            {view.kind === "complete" ? ` · package ${view.schema_version} · fingerprint ${view.package_fingerprint.slice(0, 12)}` : ""}
            {view.kind === "complete" && !view.intact ? " · warning: the stored package no longer matches its fingerprint" : ""}
            {" · "}
            <a href={`/api/plan/final/${view.version}`}>Download as JSON</a>
          </p>
          {view.kind === "complete" ? <CompletePlan view={view} /> : <LegacyPlan view={view} />}
        </div>
      )}
    </AppShell>
  );
}
