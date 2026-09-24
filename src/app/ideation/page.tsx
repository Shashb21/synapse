import Link from "next/link";
import { AppShell, PageIntro } from "@/components/app-shell";
import { RunStageButton } from "@/components/platform/run-stage-button";
import {
  GapProposalGroupCard,
  type GapProposalGroup,
} from "@/components/ideation/gap-proposal-group";
import type { ProposalCardModel } from "@/components/ideation/proposal-card";
import { displayedGapStatus, isLiveGap, mappedTactics } from "@/lib/iegp/engine";
import { DOMAIN_LABELS } from "@/lib/iegp/enums";
import { loadState } from "@/lib/iegp/store";
import { can } from "@/modules/auth/roles";
import { sessionContext } from "@/modules/auth/session";
import { listPlacements } from "@/modules/stages/s8-prioritization/module";
import { listIdeationProposals } from "@/modules/stages/s9-ideation/module";

export const dynamic = "force-dynamic";

export default async function IdeationPage() {
  const [state, placements, proposals, session] = await Promise.all([
    loadState(),
    listPlacements(),
    listIdeationProposals(),
    sessionContext(),
  ]);

  const identity = {
    signed_in: session.signed_in,
    actor_name: session.actor.name,
    actor_function: session.actor.function,
  };
  const mayIdeate = can(session.role, "ideate");

  const openGaps = state.gaps.filter(
    (gap) => isLiveGap(gap) && displayedGapStatus(gap) === "validated_open",
  );

  const groups: GapProposalGroup[] = [];
  const highWithoutProposal: { gap_id: string; gap_name: string; domain_label: string }[] = [];

  for (const gap of openGaps) {
    const placement = placements.find((row) => row.gap_id === gap.id);
    const gapProposals = proposals.filter((proposal) => proposal.gap_id === gap.id);
    const isValidatedHigh = Boolean(placement?.validated && placement.band === "high");
    if (gapProposals.length === 0) {
      if (isValidatedHigh) {
        highWithoutProposal.push({
          gap_id: gap.id,
          gap_name: gap.name,
          domain_label: DOMAIN_LABELS[gap.domain],
        });
      }
      continue;
    }
    groups.push({
      gap_id: gap.id,
      gap_name: gap.name,
      statement: gap.statement,
      domain_label: DOMAIN_LABELS[gap.domain],
      band: placement ? (placement.validated && placement.band ? placement.band : placement.suggested_band) : null,
      band_validated: Boolean(placement?.validated),
      mapped_tactic_count: mappedTactics(state, gap.id).length,
      proposals: gapProposals.map((proposal): ProposalCardModel => ({ ...proposal })),
    });
  }

  // Proposals whose gap is no longer a live Open gap still need a home.
  const groupedIds = new Set(groups.map((group) => group.gap_id));
  const orphanGapIds = [
    ...new Set(proposals.map((proposal) => proposal.gap_id).filter((id) => !groupedIds.has(id))),
  ];
  for (const gapId of orphanGapIds) {
    const gap = state.gaps.find((row) => row.id === gapId);
    groups.push({
      gap_id: gapId,
      gap_name: gap?.name ?? gapId,
      statement: gap?.statement ?? "This gap is no longer a live Open gap.",
      domain_label: gap ? DOMAIN_LABELS[gap.domain] : "Unknown domain",
      band: null,
      band_validated: false,
      mapped_tactic_count: gap ? mappedTactics(state, gapId).length : 0,
      proposals: proposals
        .filter((proposal) => proposal.gap_id === gapId)
        .map((proposal): ProposalCardModel => ({ ...proposal })),
    });
  }

  groups.sort((a, b) => {
    const openA = a.proposals.filter((p) => p.status === "proposed").length;
    const openB = b.proposals.filter((p) => p.status === "proposed").length;
    return openB - openA || a.gap_name.localeCompare(b.gap_name);
  });

  const total = proposals.length;
  const awaiting = proposals.filter((proposal) => proposal.status === "proposed").length;
  const accepted = proposals.filter((proposal) => proposal.status === "accepted").length;
  const rejected = proposals.filter((proposal) => proposal.status === "rejected").length;
  const validatedHighCount = placements.filter(
    (placement) => placement.validated && placement.band === "high",
  ).length;

  return (
    <AppShell active="ideation">
      <PageIntro kicker="S9 · Tactics ideation" title="Tactics ideation review">
        S9 designs candidate tactics for open gaps whose band was validated as High, critiques them
        against the tactic library and keeps the best per gap. Accepting a proposal creates a
        proposed tactic mapped to the gap; both decisions need a rationale.
      </PageIntro>

      <div className="grid gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
            <li>
              <span className="text-foreground">{total}</span> proposal(s)
            </li>
            <li>
              <span className="text-foreground">{awaiting}</span> awaiting a decision
            </li>
            <li>
              <span className="text-foreground">{accepted}</span> accepted
            </li>
            <li>
              <span className="text-foreground">{rejected}</span> rejected
            </li>
            <li>
              <span className="text-foreground">{validatedHighCount}</span> gap(s) validated High
            </li>
          </ul>
          <RunStageButton
            stage="S9"
            input={{}}
            label={total === 0 ? "Run S9 ideation" : "Re-run S9"}
            identity={identity}
            variant={total === 0 ? "default" : "outline"}
          />
        </div>

        {highWithoutProposal.length > 0 ? (
          <section className="grid gap-2 rounded-md border border-[color:var(--unknown)]/40 bg-card/40 p-3">
            <h2 className="text-[13px] text-foreground">
              High priority with no proposal ({highWithoutProposal.length})
            </h2>
            <p className="max-w-3xl text-[12px] leading-4 text-muted-foreground">
              These open gaps have a validated High band but no ideated tactic yet. Run S9 to design
              candidates for them.
            </p>
            <ul className="flex flex-wrap gap-2">
              {highWithoutProposal.map((gap) => (
                <li key={gap.gap_id} className="rounded-md border border-border bg-background p-2">
                  <Link
                    href={`/gaps/${gap.gap_id}`}
                    className="text-[12px] text-foreground no-underline hover:underline"
                  >
                    {gap.gap_name}
                  </Link>
                  <p className="text-[10px] text-muted-foreground">{gap.domain_label}</p>
                </li>
              ))}
            </ul>
            <div>
              <RunStageButton
                stage="S9"
                input={{}}
                label="Run S9 for these gaps"
                identity={identity}
                variant="default"
              />
            </div>
          </section>
        ) : null}

        {groups.length === 0 ? (
          <section className="grid gap-3 rounded-md border border-border bg-card/40 p-4">
            <h2 className="text-[13px] text-foreground">No proposal to review yet</h2>
            <p className="max-w-2xl text-[12px] leading-5 text-muted-foreground">
              S9 only runs for open gaps whose priority band has been validated as High. Validate a
              band on the{" "}
              <Link href="/?place=plan" className="text-foreground no-underline hover:underline">
                prioritization matrix
              </Link>{" "}
              first, then run S9 here.
            </p>
            <div>
              <RunStageButton
                stage="S9"
                input={{}}
                label="Run S9 ideation"
                identity={identity}
                variant="default"
              />
            </div>
          </section>
        ) : (
          <div className="grid gap-4">
            {groups.map((group) => (
              <GapProposalGroupCard
                key={group.gap_id}
                group={group}
                identity={identity}
                mayIdeate={mayIdeate}
              />
            ))}
          </div>
        )}
      </div>
    </AppShell>
  );
}
