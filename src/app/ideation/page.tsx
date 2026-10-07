import Link from "next/link";
import { AppShell, PageIntro } from "@/components/app-shell";
import { RunStageButton } from "@/components/platform/run-stage-button";
import {
  AddIdeaDialog,
  GapProposalGroupCard,
  type GapProposalGroup,
} from "@/components/ideation/gap-proposal-group";
import type { ProposalCardModel } from "@/components/ideation/proposal-card";
import { eligibilityGapStatus, isLiveGap, mappedTactics } from "@/lib/iegp/engine";
import { DOMAIN_LABELS } from "@/lib/iegp/enums";
import { loadState } from "@/lib/iegp/store";
import { can } from "@/modules/auth/roles";
import { sessionContext } from "@/modules/auth/session";
import { listPlacements } from "@/modules/stages/s8-prioritization/module";
import { BAND_RANK, ideationBandOrder, listIdeationProposals } from "@/modules/stages/s9-ideation/module";
import { aiSectionEnabled } from "@/modules/kernel/ai-switch";

export const dynamic = "force-dynamic";

export default async function IdeationPage() {
  const [state, placements, proposals, session, ai] = await Promise.all([
    loadState(),
    listPlacements(),
    listIdeationProposals(),
    sessionContext(),
    aiSectionEnabled("ideation").catch(() => false),
  ]);

  const identity = {
    signed_in: session.signed_in,
    actor_name: session.actor.name,
    actor_function: session.actor.function,
  };
  const mayIdeate = can(session.role, "ideate");

  const openGaps = state.gaps.filter(
    (gap) => isLiveGap(gap) && eligibilityGapStatus(gap, state) === "validated_open",
  );

  // Open gaps a human validated as High are eligible (KAN-8: the Figma design ideates High only).
  const bandOrder = ideationBandOrder(placements);
  const rankOf = (gapId: string) => bandOrder.get(gapId) ?? BAND_RANK.low + 1;
  const BAND_NAMES = ["High", "Medium", "Low"] as const;

  const groups: GapProposalGroup[] = [];
  const withoutProposal: { gap_id: string; gap_name: string; domain_label: string; band_label: string }[] = [];

  for (const gap of openGaps) {
    const placement = placements.find((row) => row.gap_id === gap.id);
    const gapProposals = proposals.filter((proposal) => proposal.gap_id === gap.id);
    if (gapProposals.length === 0) {
      const rank = bandOrder.get(gap.id);
      if (rank !== undefined) {
        withoutProposal.push({
          gap_id: gap.id,
          gap_name: gap.name,
          domain_label: DOMAIN_LABELS[gap.domain],
          band_label: BAND_NAMES[rank]!,
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

  withoutProposal.sort((a, b) => rankOf(a.gap_id) - rankOf(b.gap_id));
  groups.sort((a, b) => {
    const openA = a.proposals.filter((p) => p.status === "proposed").length;
    const openB = b.proposals.filter((p) => p.status === "proposed").length;
    return rankOf(a.gap_id) - rankOf(b.gap_id) || openB - openA || a.gap_name.localeCompare(b.gap_name);
  });

  const total = proposals.length;
  const awaiting = proposals.filter((proposal) => proposal.status === "proposed").length;
  const accepted = proposals.filter((proposal) => proposal.status === "accepted").length;
  const rejected = proposals.filter((proposal) => proposal.status === "rejected").length;
  const openIds = new Set(openGaps.map((gap) => gap.id));
  const eligibleCount = [...bandOrder.keys()].filter((id) => openIds.has(id)).length;

  return (
    <AppShell active="ideation">
      <PageIntro kicker="Tactics ideation" title="Tactics ideation review">
        {ai
          ? "The model designs candidate tactics for open gaps you validated as High priority only, critiques them against the tactic library and keeps the best per gap. Medium and Low gaps get their tactics from the tactic library or by hand on the gap. Accepting a proposal creates a proposed tactic mapped to the gap; both decisions need a rationale. You can edit any idea before deciding it, or write your own — generating again adds ideas and never rewrites yours."
          : "Write ideas for open gaps validated as High priority. Medium and Low gaps get their tactics from the tactic library or by hand on the gap. Accepting an idea creates a proposed tactic mapped to the gap; both decisions need a rationale."}
      </PageIntro>

      <div className="grid gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
            <li>
              <span className="text-foreground">{total}</span> {total === 1 ? "proposal" : "proposals"}
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
              <span className="text-foreground">{eligibleCount}</span> open {eligibleCount === 1 ? "gap" : "gaps"} validated as High
            </li>
          </ul>
          {ai ? (
            <RunStageButton
              stage="S9"
              input={{}}
              label={total === 0 ? "Generate ideas" : "Generate more ideas"}
              identity={identity}
              variant={total === 0 ? "default" : "outline"}
            />
          ) : (
            <p className="text-[11px] text-muted-foreground">Add ideas by hand.</p>
          )}
        </div>

        {withoutProposal.length > 0 ? (
          <section className="grid gap-2 rounded-md border border-[color:var(--unknown)]/40 bg-card p-3">
            <h2 className="text-[13px] text-foreground">
              Prioritized gaps with no proposal ({withoutProposal.length})
            </h2>
            <p className="max-w-3xl text-[12px] leading-4 text-muted-foreground">
              {ai
                ? "These open gaps are validated as High priority but have no ideated tactic yet. Generate ideas for them, or add an idea by hand. Medium and Low gaps are not listed: their tactics come from the tactic library or by hand on the gap."
                : "These open gaps are validated as High priority but have no ideated tactic yet. Add an idea by hand. Medium and Low gaps are not listed: their tactics come from the tactic library or by hand on the gap."}
            </p>
            <ul className="flex flex-wrap gap-2" data-testid="ideation-without-proposal">
              {withoutProposal.map((gap) => (
                <li key={gap.gap_id} className="rounded-md border border-border bg-card p-2">
                  <Link
                    href={`/gaps/${gap.gap_id}`}
                    className="text-[12px] text-foreground no-underline hover:underline"
                  >
                    {gap.gap_name}
                  </Link>
                  <p className="text-[10px] text-muted-foreground">
                    {gap.band_label} priority · {gap.domain_label}
                  </p>
                  {mayIdeate ? (
                    <div className="mt-1">
                      <AddIdeaDialog gapId={gap.gap_id} gapName={gap.gap_name} identity={identity} />
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
            {ai ? (
              <div>
                <RunStageButton
                  stage="S9"
                  input={{ gap_ids: withoutProposal.map((gap) => gap.gap_id) }}
                  label="Generate ideas for these gaps"
                  identity={identity}
                  variant="default"
                />
              </div>
            ) : null}
          </section>
        ) : null}

        {groups.length === 0 ? (
          <section className="grid gap-3 rounded-md border border-border bg-card p-4">
            <h2 className="text-[13px] text-foreground">No proposal to review yet</h2>
            <p className="max-w-2xl text-[12px] leading-5 text-muted-foreground">
              {ai ? "Ideas are generated" : "Ideas are added"} for open gaps validated as High priority only;
              Medium and Low gaps get their tactics from the tactic library or by hand on the gap. Validate a band on the{" "}
              <Link href="/?place=plan" className="text-foreground no-underline hover:underline">
                prioritization matrix
              </Link>{" "}
              first{ai ? " (by hand or with the model), then generate ideas here or add them by hand." : ", then add ideas by hand here."}
            </p>
            {ai ? (
              <div>
                <RunStageButton
                  stage="S9"
                  input={{}}
                  label="Generate ideas"
                  identity={identity}
                  variant="default"
                />
              </div>
            ) : null}
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
