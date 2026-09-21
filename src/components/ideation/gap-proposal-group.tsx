import Link from "next/link";
import type { ActionIdentity } from "@/components/platform/action-dialog";
import { ProposalCard, type ProposalCardModel } from "@/components/ideation/proposal-card";

export type GapProposalGroup = {
  gap_id: string;
  gap_name: string;
  statement: string;
  domain_label: string;
  band: "high" | "medium" | "low" | null;
  band_validated: boolean;
  mapped_tactic_count: number;
  proposals: ProposalCardModel[];
};

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
    <section className="grid gap-3 rounded-md border border-border bg-card/40 p-3">
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
              {group.band === "high" ? "High" : group.band === "medium" ? "Medium" : "Low"}
              {group.band_validated ? " · validated" : " · suggested"}
            </span>
          ) : null}
          <span className="rounded-4xl border border-border px-1.5 py-px text-[10px] text-muted-foreground">
            {group.domain_label}
          </span>
          <span className="text-[10px] text-muted-foreground">
            {group.mapped_tactic_count} mapped tactic(s)
          </span>
        </div>
        <Link
          href={`/gaps/${group.gap_id}`}
          className="text-[13px] leading-5 text-foreground no-underline hover:underline"
        >
          {group.gap_name}
        </Link>
        <p className="max-w-3xl text-[12px] leading-4 text-muted-foreground">{group.statement}</p>
        <p className="text-[11px] text-muted-foreground">
          {group.proposals.length} proposal(s) · {open} awaiting a decision · {accepted} accepted
        </p>
      </header>
      <div className="grid gap-3 lg:grid-cols-2">
        {group.proposals.map((proposal) => (
          <ProposalCard
            key={proposal.id}
            proposal={proposal}
            identity={identity}
            mayIdeate={mayIdeate}
          />
        ))}
      </div>
    </section>
  );
}
