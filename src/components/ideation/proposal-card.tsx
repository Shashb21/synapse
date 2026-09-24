import Link from "next/link";
import { ActionDialog, type ActionIdentity } from "@/components/platform/action-dialog";
import { proposalFields } from "@/components/ideation/proposal-fields";
import { TACTIC_TYPE_LABELS, type TacticType } from "@/lib/iegp/enums";
import type { IdeationProposalRecord } from "@/modules/stages/s9-ideation/module";

export type ProposalCardModel = IdeationProposalRecord;

function typeLabel(type: string): string {
  return TACTIC_TYPE_LABELS[type as TacticType] ?? type.replaceAll("_", " ");
}

function StatusChip({ status }: { status: string }) {
  const tone =
    status === "accepted"
      ? "border-[color:var(--known)] text-[color:var(--known)]"
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
}: {
  proposal: ProposalCardModel;
  identity: ActionIdentity;
  mayIdeate: boolean;
}) {
  const settled = proposal.status !== "proposed";
  return (
    <article
      className={`grid gap-2 rounded-md border p-3 ${
        proposal.status === "accepted"
          ? "border-[color:var(--known)]/40 bg-card/70"
          : proposal.status === "rejected"
            ? "border-border bg-card/20 opacity-70"
            : "border-border bg-card/40"
      }`}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <StatusChip status={proposal.status} />
        <span className="rounded-4xl border border-border px-1.5 py-px text-[10px] text-muted-foreground">
          {typeLabel(proposal.type)}
        </span>
        {proposal.origin === "human" ? (
          <span className="text-[10px] text-muted-foreground">Written by {proposal.edited_by ?? "a person"}</span>
        ) : (
          <span className="text-[10px] text-muted-foreground">
            Judge {proposal.judge_score}
            {proposal.rank ? ` · rank ${proposal.rank}` : ""}
          </span>
        )}
        {proposal.origin !== "human" && proposal.edited_by ? (
          <span className="text-[10px] text-muted-foreground">· edited by {proposal.edited_by}</span>
        ) : null}
      </div>

      <h4 className="text-[13px] leading-5 text-foreground">{proposal.name}</h4>

      <div className="grid gap-0.5">
        <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Evidence question</p>
        <p className="text-[12px] leading-4 text-foreground">{proposal.evidence_question}</p>
      </div>

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
              : `${proposal.design.duration_months} month(s) to run · readout +${proposal.design.readout_lag_months ?? "?"}`
          }
        />
      </dl>

      <details className="group">
        <summary className="cursor-pointer list-none text-[11px] text-muted-foreground hover:text-foreground">
          Rationale and critic note
        </summary>
        <div className="mt-1 grid gap-1 border-l border-border pl-2">
          <p className="text-[11px] leading-4 text-muted-foreground">{proposal.rationale}</p>
          <p className="text-[11px] leading-4 text-muted-foreground">
            Critic: {proposal.critic_note?.trim() ? proposal.critic_note : "no note recorded"}
          </p>
          <p className="text-[11px] text-muted-foreground">
            Proposed {proposal.created_at.slice(0, 10)}
          </p>
        </div>
      </details>

      {settled ? (
        <div className="grid gap-1 border-t border-border pt-2">
          <p className="text-[11px] text-muted-foreground">
            {proposal.status === "accepted" ? "Accepted" : "Rejected"} by{" "}
            {proposal.decided_by ?? "unknown"}
            {proposal.decision_rationale ? ` — ${proposal.decision_rationale}` : ""}
          </p>
          {proposal.tactic_id ? (
            <Link
              href={`/tactics/${proposal.tactic_id}`}
              className="text-[11px] text-[color:var(--known)] no-underline hover:underline"
            >
              Tactic {proposal.tactic_id}
            </Link>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-2">
          {mayIdeate ? (
            <>
              <ActionDialog
                endpoint="/api/plan"
                payload={{ action: "edit_proposal", id: proposal.id }}
                fields={proposalFields(proposal)}
                label="Edit"
                title={`Edit ${proposal.name}`}
                description="Change any field before deciding. Your edit is kept: a re-run of S9 adds new ideas and never rewrites this one."
                confirmLabel="Save edit"
                requireRationale
                identity={identity}
                variant="outline"
                size="sm"
              />
              <ActionDialog
                endpoint="/api/plan"
                payload={{ action: "decide_proposal", id: proposal.id, decision: "accept" }}
                label="Accept"
                title={`Accept ${proposal.name}`}
                description="Accepting creates a proposed tactic mapped to this gap. The rationale is stored on the edit record."
                confirmLabel="Accept proposal"
                requireRationale
                identity={identity}
                variant="default"
                size="sm"
              />
              <ActionDialog
                endpoint="/api/plan"
                payload={{ action: "decide_proposal", id: proposal.id, decision: "reject" }}
                label="Reject"
                title={`Reject ${proposal.name}`}
                description="Rejecting keeps the proposal on the record with your reason, and feeds S9 hillclimb."
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
