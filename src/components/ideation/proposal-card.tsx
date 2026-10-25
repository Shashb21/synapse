import Link from "next/link";
import { IdeationBrief, RecommendationReasoning } from "./evidence-context";
import { TacticRecordLink } from "@/components/tactic-ideation/tactic-panel";
import { ActionDialog, type ActionIdentity } from "@/components/platform/action-dialog";
import { proposalFields } from "@/components/ideation/proposal-fields";
import { TACTIC_TYPE_LABELS, type TacticType } from "@/lib/iegp/enums";
import type { IdeationProposalRecord } from "@/modules/stages/s9-ideation/module";
import { plural } from "@/lib/plural";

export type ProposalCardModel = IdeationProposalRecord;

function typeLabel(type: string): string {
  return TACTIC_TYPE_LABELS[type as TacticType] ?? type.replaceAll("_", " ");
}

function StatusChip({ status }: { status: string }) {
  const tone =
    status === "accepted"
      ? "border-[color:var(--known)] text-[color:var(--known-foreground)]"
      : status === "rejected"
        ? "border-border text-muted-foreground"
        : "border-[color:var(--opportunity)] text-[color:var(--opportunity)]";
  const label = status === "accepted" ? "Accepted" : status === "rejected" ? "Rejected" : "Proposed";
  return (
    <span className={`rounded-4xl border px-1.5 py-px text-[10px] font-medium ${tone}`}>{label}</span>
  );
}

function DesignField({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="text-[12px] leading-4 text-foreground">{value}</dd>
    </div>
  );
}

export function ProposalCard({
  proposal,
  identity,
  mayIdeate,
  readOnly = false,
}: {
  proposal: ProposalCardModel;
  identity: ActionIdentity;
  mayIdeate: boolean;
  /** Record inspection keeps decisions in their existing review surface. */
  readOnly?: boolean;
}) {
  const settled = proposal.status !== "proposed";
  return (
    <article
      className={`grid gap-2 rounded-md border p-3 ${
        proposal.status === "accepted"
          ? "border-[color:var(--known)]/40 bg-card"
          : proposal.status === "rejected"
            ? "border-border bg-card opacity-70"
            : "border-border bg-card"
      }`}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <StatusChip status={proposal.status} />
        <span className="rounded-4xl border border-border px-1.5 py-px text-[10px] text-muted-foreground">
          {typeLabel(proposal.type)}
        </span>
        {proposal.origin === "human" ? <span className="text-[10px] text-muted-foreground">Written by {proposal.edited_by ?? "a person"}</span> : null}
        {proposal.origin !== "human" && proposal.edited_by ? (
          <span className="text-[10px] text-muted-foreground">· edited by {proposal.edited_by}</span>
        ) : null}
      </div>

      <p className="text-[12px] font-medium">{proposal.proposal_kind === "reuse" ? `Reuse existing tactic: ${proposal.reviewed_parent?.name ?? proposal.target_tactic_id}` : proposal.proposal_kind === "expansion" ? `Expand: ${proposal.reviewed_parent?.name ?? proposal.target_tactic_id}` : "New tactic"}</p>
      <h4 className="text-[13px] leading-5 text-foreground">{proposal.name}</h4>

      <RecommendationReasoning
        recommendation={proposal.recommendation}
        conditions={proposal.conditions}
        contribution={proposal.rationale}
        comparison={proposal.comparative_rationale}
      />
      {proposal.origin !== "human" ? <p className="text-[11px] text-muted-foreground">Judge rating {proposal.judge_score}{proposal.rank ? ` · rank ${proposal.rank}` : ""} · model review rating, not a probability of closing the gap.</p> : null}
      {proposal.context_stale ? <div className="grid gap-2 border-t border-border pt-2 text-[12px]">
        <p>Supporting context changed. Review the current evidence brief before a renewed manual decision. Original reasoning and previous decisions remain in history.</p>
        {proposal.current_context ? <IdeationBrief brief={proposal.current_context} /> : <p>Current gap context is unavailable. Acceptance is unavailable.</p>}
      </div> : null}
      {proposal.renewed_review ? <p className="text-[12px]">Renewed review by {proposal.renewed_review.actor} on {proposal.renewed_review.at.slice(0, 10)}: {proposal.renewed_review.rationale}</p> : null}

      <div className="grid gap-0.5">
        <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Evidence question</p>
        <p className="text-[12px] leading-4 text-foreground">{proposal.evidence_question}</p>
      </div>

      {proposal.proposal_kind === "expansion" && proposal.expansion_scope ? (
        <div className="grid gap-2 border-t border-border pt-2">
          <p className="text-[12px]">Reviewed current scope ({proposal.reviewed_parent?.status}): {proposal.reviewed_parent?.population}; {proposal.reviewed_parent?.outcomes}; {proposal.reviewed_parent?.study_design}</p>
          <dl className="grid gap-2 sm:grid-cols-2">
            {Object.entries(proposal.expansion_scope).filter(([,value]) => value !== null && value !== "").map(([key,value]) => <DesignField key={key} label={`Added scope: ${key.replaceAll("_", " ")}`} value={typeof value === "boolean" ? value ? "Yes" : "No" : value ?? ""} />)}
          </dl>
        </div>
      ) : null}
      <dl className="grid gap-2 border-t border-border pt-2 sm:grid-cols-2">
        <DesignField label="Population" value={proposal.design.population} />
        <DesignField label="Comparator" value={proposal.design.comparator} />
        <DesignField label="Outcomes" value={proposal.design.outcomes} />
        <DesignField label="Data source" value={proposal.design.data_source} />
        <DesignField label="Design" value={proposal.design.study_design} />
        <DesignField
          label="Timing"
          value={
            proposal.design.duration_months === null
              ? "Not set — the timeline estimates it"
              : `${plural(proposal.design.duration_months, "month")} to run · readout +${proposal.design.readout_lag_months ?? "?"}`
          }
        />
      </dl>

      <details className="group">
        <summary className="cursor-pointer list-none text-[11px] text-muted-foreground hover:text-foreground">
          Rationale and critic note
        </summary>
        <div className="mt-1 grid gap-1 border-l border-border pl-2">
          <p className="text-[11px] leading-4 text-muted-foreground">{proposal.rationale || "Reason not recorded"}</p>
          <p className="text-[11px] leading-4 text-muted-foreground">
            Critic: {proposal.critic_note?.trim() ? proposal.critic_note : "no note recorded"}
          </p>
          <p className="text-[11px] text-muted-foreground">
            Proposed {proposal.created_at.slice(0, 10)}
          </p>
        </div>
      </details>

      {proposal.origin !== "human" ? <div className="grid gap-1 text-[12px]" aria-label="Model suggestion support">
        <p>Model suggestion; acceptance or rejection is a human decision.</p>
        {proposal.supporting_references?.length ? <ul aria-label="Option supporting references">
          {proposal.supporting_references.map((reference, index) => <li key={index}>
            {reference.target ? <Link href={reference.target.href}>{reference.target.title}</Link> : <span>Reference unavailable</span>}: {reference.reason}
          </li>)}
        </ul> : <p>Supporting references not recorded for this suggestion</p>}
      </div> : null}
      {settled ? (
        <div className="grid gap-1 border-t border-border pt-2">
          <p className="text-[11px] text-muted-foreground">
            {proposal.status === "accepted" ? "Accepted" : "Rejected"} by{" "}
            {proposal.decided_by ?? "unknown"}
            {proposal.decision_rationale ? ` — ${proposal.decision_rationale}` : " — Reason not recorded"}
          </p>
          {proposal.tactic_id ? (
            <TacticRecordLink
              tacticId={proposal.tactic_id}
              className="text-[11px] text-[color:var(--known-foreground)] no-underline hover:underline"
            >
              {proposal.proposal_kind === "reuse" ? `Review coverage for existing tactic ${proposal.tactic_id} (no new work)` : proposal.expansion_id ? `Expansion ${proposal.expansion_id} on tactic ${proposal.tactic_id}` : `Tactic ${proposal.tactic_id}`}
            </TacticRecordLink>
          ) : null}
          {proposal.status === "rejected" && mayIdeate && !readOnly ? (
            <div>
              <ActionDialog
                protectUnsavedChanges
                endpoint="/api/plan"
                payload={{ action: "restore_proposal", id: proposal.id, expected_version: proposal.version }}
                label="Restore"
                title={`Restore ${proposal.name}`}
                description="Puts the idea back to Proposed so you can edit, accept or reject it again. The earlier rejection stays on the record."
                confirmLabel="Restore proposal"
                rationaleLabel="Why restore it? (required)"
                requireRationale
                identity={identity}
                variant="outline"
                size="sm"
              />
            </div>
          ) : null}
        </div>
      ) : readOnly ? null : (
        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-2">
          {mayIdeate ? (
            <>
              <ActionDialog
                protectUnsavedChanges
                endpoint="/api/plan"
                payload={{ action: "edit_proposal", id: proposal.id, expected_version: proposal.version }}
                fields={proposalFields(proposal)}
                label="Edit"
                title={`Edit ${proposal.name}`}
                description="Change any field before deciding. Your edit is kept: generating ideas again adds new ones and never rewrites this one."
                confirmLabel="Save edit"
                requireRationale
                identity={identity}
                variant="outline"
                size="sm"
              />
              {(!proposal.context_stale || proposal.current_context_basis) ? <ActionDialog
                protectUnsavedChanges
                endpoint="/api/plan"
                payload={{ action: "decide_proposal", id: proposal.id, expected_version: proposal.version, decision: "accept", ...(proposal.context_stale ? {reviewed_context_basis:proposal.current_context_basis,judgement_origin:"manual"} : {}) }}
                fields={!proposal.context_stale && proposal.origin !== "human" ? [{ name: "judgement_origin", label: "Decision basis", type: "select", defaultValue: "model", options: [{ value: "model", label: "Accept supported model suggestion" }, { value: "manual", label: "Manual judgement with my reason" }] }] : []}
                label={proposal.context_stale ? "Review current context and accept" : "Accept"}
                title={`Accept ${proposal.name}`}
                description={proposal.proposal_kind === "reuse" ? "Accepting adds no new work and preserves the tactic lifecycle, dates and recorded assessments. It requests coverage review on the existing tactic. Ideation does not confirm coverage or deliver evidence. Review the current brief and record your reason." : proposal.proposal_kind === "expansion" ? "Accepting creates a proposed expansion on the existing tactic. Its coverage starts unassessed; acceptance does not deliver evidence or automatically make the gap Addressed. Review its own lifecycle and coverage separately." : "Accepting creates a proposed tactic mapped to this gap. Its coverage starts unassessed; acceptance does not deliver evidence or automatically make the gap Addressed. Your reason is stored in history."}
                confirmLabel={proposal.context_stale ? "I reviewed current context — accept" : "Accept proposal"}
                requireRationale
                identity={identity}
                variant="default"
                size="sm"
              /> : null}
              <ActionDialog
                protectUnsavedChanges
                endpoint="/api/plan"
                payload={{ action: "decide_proposal", id: proposal.id, expected_version: proposal.version, decision: "reject" }}
                label="Reject"
                title={`Reject ${proposal.name}`}
                description="Rejecting keeps the proposal on the record with your reason."
                confirmLabel="Reject proposal"
                requireRationale
                identity={identity}
                variant="outline"
                size="sm"
              />
            </>
          ) : (
            <p className="text-[11px] text-muted-foreground">
              Your role may not decide ideation proposals.
            </p>
          )}
        </div>
      )}
    </article>
  );
}
