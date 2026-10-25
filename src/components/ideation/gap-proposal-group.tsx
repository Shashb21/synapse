import { IdeationBrief, IdeationOutcome } from "./evidence-context";
import type { IdeationGapBrief } from "@/modules/stages/s9-ideation/context";
import type { IdeationGapOutcome } from "@/modules/stages/s9-ideation/recommendation-contract";
import type { TacticLibraryItem } from "@/lib/iegp/engine";
import { GapRecordLink } from "@/components/gap-panel";
import { ActionDialog, type ActionIdentity } from "@/components/platform/action-dialog";
import { proposalFields } from "@/components/ideation/proposal-fields";
import { ProposalCard, type ProposalCardModel } from "@/components/ideation/proposal-card";
import { plural } from "@/lib/plural";

export type GapProposalGroup = {
  gap_id: string;
  gap_name: string;
  statement: string;
  domain_label: string;
  band: "high" | "medium" | "low" | "defer" | null;
  band_validated: boolean;
  eligible?: boolean;
  needs_priority_review?: boolean;
  evidence_status?: string;
  record_available?: boolean;
  mapped_tactic_count: number;
  proposals: ProposalCardModel[];
  brief?: IdeationGapBrief;
  outcome?: IdeationGapOutcome;
  reuseTargets?: TacticLibraryItem[];
};

/** A person writes an idea for the gap with no model run; it is decided like any other. */
export function AddIdeaDialog({
  gapId,
  gapName,
  identity,
  variant = "outline",
}: {
  gapId: string;
  gapName: string;
  identity: ActionIdentity;
  variant?: "default" | "outline";
}) {
  return (
    <ActionDialog
      endpoint="/api/plan"
      payload={{ action: "add_proposal", gap_id: gapId }}
      fields={proposalFields()}
      label="Add idea by hand"
      title={`Add an idea for ${gapName}`}
      description="Write a new tactic for this human-validated High-priority gap. It joins the ideas awaiting a decision and is accepted or rejected the same way."
      confirmLabel="Add idea"
      requireRationale
      identity={identity}
      variant={variant}
      size="sm"
    />
  );
}

/** Select an existing tactic without copying its design or changing its lifecycle. */
export function ReuseIdeaDialog({gapId, gapName, identity, targets}: {gapId:string;gapName:string;identity:ActionIdentity;targets:TacticLibraryItem[]}) {
  if (!targets.length) return null;
  return <ActionDialog protectUnsavedChanges endpoint="/api/plan" payload={{action:"add_proposal",gap_id:gapId,proposal_kind:"reuse"}}
    label="Reuse existing tactic" title={`Reuse existing tactic for ${gapName}`} description="Select an unchanged existing output. This creates an option for coverage review with no additional work; acceptance preserves its lifecycle, dates and assessments. New analysis requires expansion or a new tactic."
    identity={identity} confirmLabel="Add reuse option" requireRationale fields={[
      {name:"target_tactic_id",label:"Existing tactic",type:"select",required:true,placeholder:"Choose a tactic",options:targets.map(target=>({value:target.id,label:`${target.name} · ${target.status}`}))},
      {name:"comparative_rationale",label:"Why reuse is useful (optional)",type:"textarea"},
      {name:"conditions",label:"Uncertainties and required checks (optional)",type:"textarea",serialize:"lines",hint:"One unresolved check per line."},
    ]} size="sm" />;
}

export function GapProposalGroupCard({
  group,
  identity,
  mayIdeate,
}: {
  group: GapProposalGroup;
  identity: ActionIdentity;
  mayIdeate: boolean;
}) {
  const accepted = group.proposals.filter((p) => p.status === "accepted").length;
  const open = group.proposals.filter((p) => p.status === "proposed").length;
  return (
    <section className="grid gap-3 rounded-md border border-border bg-card p-3">
      <header className="grid gap-1">
        <div className="flex flex-wrap items-center gap-1.5">
          {group.band ? (
            <span
              className="rounded-4xl border px-1.5 py-px text-[10px] font-medium"
              style={{
                borderColor: "var(--chart-5)",
                color: "var(--chart-5)",
                borderStyle: group.band_validated ? "solid" : "dashed",
              }}
            >
              {group.band === "high" ? "High" : group.band === "medium" ? "Medium" : group.band === "low" ? "Low" : "Defer"}
              {group.needs_priority_review ? " · needs priority review" : group.band_validated ? " · priority validated" : " · priority not validated"}
            </span>
          ) : null}
          <span className="rounded-4xl border border-border px-1.5 py-px text-[10px] text-muted-foreground">
            {group.domain_label}
          </span>
          <span className="text-[10px] text-muted-foreground">
            {plural(group.mapped_tactic_count, "mapped tactic")}
          </span>
        </div>
        {group.record_available === false ? <p className="text-[13px]">{group.gap_name} · Gap record unavailable</p> : <GapRecordLink
          gapId={group.gap_id}
          className="text-[13px] leading-5 text-foreground no-underline hover:underline"
        >
          {group.gap_name}
        </GapRecordLink>}
        <p className="text-[12px] text-muted-foreground">{group.eligible === false ? `Existing options and planned work${group.evidence_status ? ` · ${group.evidence_status}` : ""}. New AI ideation requires a validated High/Open priority. Medium and Low gaps use the manual or library route on the gap.` : "Current High/Open ideation"}</p>
        <p className="max-w-3xl text-[12px] leading-4 text-muted-foreground">{group.statement}</p>
        <p className="text-[11px] text-muted-foreground">
          {plural(group.proposals.length, "proposal")} · {open} awaiting a decision · {accepted} accepted
        </p>
        {mayIdeate && group.eligible !== false ? (
          <div>
            <AddIdeaDialog gapId={group.gap_id} gapName={group.gap_name} identity={identity} />
            <ReuseIdeaDialog gapId={group.gap_id} gapName={group.gap_name} identity={identity} targets={group.reuseTargets ?? []} />
          </div>
        ) : null}
      </header>
      {group.brief ? <IdeationBrief brief={group.brief} /> : null}
      <IdeationOutcome outcome={group.outcome} />
      <div className="grid gap-3 lg:grid-cols-2">
        {group.proposals.map((proposal) => (
          <ProposalCard
            key={proposal.id}
            proposal={proposal}
            identity={identity}
            mayIdeate={mayIdeate}
            readOnly={group.eligible === false}
          />
        ))}
      </div>
    </section>
  );
}
