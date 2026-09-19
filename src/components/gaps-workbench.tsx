"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { CoverageBadge, GapBadge, NeedsReviewFlag, StaleFlag, TacticBadge } from "@/components/iegp-badges";
import { LockForm } from "@/components/lock-form";
import { GapStatusDisagreement, GapStatusOverride } from "@/components/gap-status-override";
import { SplitGapDialog } from "@/components/split-gap-dialog";
import {
  GAPS_TACTIC_HELPER,
  MapExistingTactic,
  RecordMissedFields,
  RecordMissedTactic,
} from "@/components/gap-tactic-actions";
import {
  DOMAIN_LABELS,
  EVIDENCE_DOMAINS,
  GAP_STATUS_LABELS,
} from "@/lib/iegp/enums";
import {
  filterReviewGapCards,
  reviewGapFilterCounts,
  sortReviewGapCards,
  type PlanTactic,
  type ReviewGapCard,
  type ReviewGapFilter,
  type TacticLibraryItem,
} from "@/lib/iegp/engine";
import { Button } from "@/components/ui/button";

const FILTER_CHIPS: { id: ReviewGapFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "partial", label: "Partial" },
  { id: "open", label: "Open" },
  { id: "addressed", label: "Addressed" },
  { id: "needs_validation", label: "Unconfirmed" },
];

function CreateOpenGap() {
  return (
    <LockForm label="Add open gap" action="create_gap" confirmLabel="Add open gap">
      <label className="grid gap-1 text-[12px] text-muted-foreground">
        Title
        <input
          name="name"
          placeholder="Comparative effectiveness in elderly patients, including SoC outcomes"
          className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm"
        />
      </label>
      <label className="grid gap-1 text-[12px] text-muted-foreground">
        Statement
        <textarea
          name="statement"
          required
          className="min-h-16 rounded-lg border border-input bg-transparent px-2.5 text-sm"
        />
      </label>
      <label className="grid gap-1 text-[12px] text-muted-foreground">
        Domain
        <select name="domain" defaultValue="unmet_need" className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm">
          {EVIDENCE_DOMAINS.map((domain) => (
            <option key={domain} value={domain}>
              {DOMAIN_LABELS[domain]}
            </option>
          ))}
        </select>
      </label>
    </LockForm>
  );
}

function CreateAddressedGap({ tactics }: { tactics: TacticLibraryItem[] }) {
  return (
    <LockForm label="Add addressed gap" action="create_addressed_gap" confirmLabel="Add addressed gap">
      <label className="grid gap-1 text-[12px] text-muted-foreground">
        Title
        <input name="name" className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm" />
      </label>
      <label className="grid gap-1 text-[12px] text-muted-foreground">
        Statement
        <textarea
          name="statement"
          required
          className="min-h-16 rounded-lg border border-input bg-transparent px-2.5 text-sm"
        />
      </label>
      <label className="grid gap-1 text-[12px] text-muted-foreground">
        Accompanying library tactic
        <select name="tactic_id" className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm">
          <option value="">Record a missed tactic below</option>
          {tactics.map((tactic) => (
            <option key={tactic.id} value={tactic.id}>
              {tactic.name}
            </option>
          ))}
        </select>
      </label>
      <p className="text-[11px] text-muted-foreground">
        Pick a library tactic, or record a missed real study (completed, ongoing, or planned). At least
        one is required. Do not invent proposed tactics here.
      </p>
      <RecordMissedFields prefix />
    </LockForm>
  );
}

function MappedTacticRow({ tactic }: { tactic: PlanTactic }) {
  return (
    <li className="flex flex-wrap items-center gap-1.5">
      <Link
        href={`/tactics/${tactic.id}`}
        className="text-[12px] text-foreground no-underline hover:underline"
      >
        {tactic.name}
      </Link>
      <TacticBadge status={tactic.status} />
      {tactic.overall ? <CoverageBadge overall={tactic.overall} /> : null}
      {tactic.stale ? <StaleFlag stale /> : null}
      <NeedsReviewFlag needsReview={tactic.needs_review} />
    </li>
  );
}

export function GapsWorkbench({
  cards,
  availableTactics,
  readyForPrioritize,
}: {
  cards: ReviewGapCard[];
  availableTactics: TacticLibraryItem[];
  readyForPrioritize: boolean;
}) {
  const [filter, setFilter] = useState<ReviewGapFilter>("all");
  const counts = reviewGapFilterCounts(cards);
  const visible = useMemo(
    () => sortReviewGapCards(filterReviewGapCards(cards, filter)),
    [cards, filter],
  );
  const partials = counts.partial;
  const unvalidated = counts.needs_validation;

  return (
    <div className="grid gap-6">
        <p className="text-[12px] leading-5 text-muted-foreground">
          Engine computes Open, Partially Addressed, or Addressed. Confirm each gap before Prioritize.
          Partial must be split or rewritten.
        </p>
        <p className="text-[12px] leading-5 text-muted-foreground">{GAPS_TACTIC_HELPER}</p>
        <div className="flex flex-wrap items-center gap-2">
          <CreateOpenGap />
          <CreateAddressedGap tactics={availableTactics} />
        </div>
        {cards.length === 0 ? (
          <p className="text-[12px] text-muted-foreground">
            No mapped gaps yet. Ingest a source on Upload, or add an Open or Addressed gap here.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter gaps">
              {FILTER_CHIPS.map((chip) => (
                <Button
                  key={chip.id}
                  type="button"
                  size="sm"
                  variant={filter === chip.id ? "default" : "outline"}
                  aria-pressed={filter === chip.id}
                  onClick={() => setFilter(chip.id)}
                >
                  {chip.label} ({counts[chip.id]})
                </Button>
              ))}
            </div>
            <div className="grid gap-3">
              {visible.map((card) => {
                const unconfirmed = !card.human_validated || card.gap_status === "validated_partial";
                return (
                <article
                  key={card.gap_id}
                  className={
                    unconfirmed
                      ? "border border-border border-l-2 border-l-amber-400 bg-background p-4"
                      : "border border-border bg-background p-4"
                  }
                >
                  <p className="font-mono text-[11px] text-muted-foreground">{card.gap_id}</p>
                  <h2 className="mt-1 text-[15px] font-medium leading-6 text-foreground">
                    <Link
                      href={`/gaps/${card.gap_id}`}
                      className="whitespace-normal no-underline hover:underline"
                    >
                      {card.gap_name}
                    </Link>
                  </h2>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {card.gap_status === "validated_partial" ? (
                      <GapBadge status={card.gap_status} />
                    ) : (
                      <GapStatusOverride
                        gapId={card.gap_id}
                        status={card.gap_status}
                        computedStatus={card.computed_status}
                        override={card.status_override}
                      />
                    )}
                    <NeedsReviewFlag needsReview={card.needs_review} />
                    {card.parent_gap_id ? (
                      <span className="text-[11px] text-muted-foreground">From split / rewrite</span>
                    ) : null}
                    {card.history_count > 0 ? (
                      <span className="text-[11px] text-muted-foreground">
                        {card.history_count} version{card.history_count === 1 ? "" : "s"}
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-2 text-[12px] leading-5 text-muted-foreground">{card.statement}</p>
                  <GapStatusDisagreement
                    computedStatus={card.computed_status}
                    override={card.status_override}
                  />
                  <div className="mt-3">
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Tactics</p>
                    <ul className="mt-1 grid gap-1.5">
                      {card.tactics.length === 0 ? (
                        <li className="text-[12px] text-muted-foreground">No tactics mapped</li>
                      ) : (
                        card.tactics.map((tactic) => (
                          <MappedTacticRow key={tactic.id} tactic={tactic} />
                        ))
                      )}
                    </ul>
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    {card.gap_status === "validated_partial" ? (
                      <SplitGapDialog
                        gapId={card.gap_id}
                        gapName={card.gap_name}
                        gapStatement={card.statement}
                        residualName={card.residual?.statement || card.gap_name}
                        residualStatement={card.residual?.statement || card.statement}
                        tactics={card.tactics}
                      />
                    ) : null}
                    <MapExistingTactic
                      gapId={card.gap_id}
                      availableTactics={availableTactics}
                      mappedTacticIds={card.tactics.map((tactic) => tactic.id)}
                    />
                    <RecordMissedTactic gapId={card.gap_id} />
                    {card.gap_status === "validated_partial" ? null : !card.human_validated ? (
                      <LockForm
                        label="Confirm status"
                        action="validate_gap"
                        extra={{ gap_id: card.gap_id }}
                        confirmLabel={`Confirm ${GAP_STATUS_LABELS[card.gap_status]}`}
                      />
                    ) : null}
                  </div>
                </article>
                );
              })}
            </div>
          </>
        )}
        <div className="border border-border bg-card/40 p-4">
          {readyForPrioritize ? (
            <>
              <h2 className="text-[15px] font-medium">Continue to prioritize</h2>
              <p className="mt-1 mb-3 text-[12px] text-muted-foreground">
                Every live gap is confirmed. Open gaps go to Prioritize, then Tactics.
              </p>
              <LockForm
                label="Continue to prioritize"
                action="complete_wizard"
                confirmLabel="Go to prioritize"
              />
            </>
          ) : (
            <>
              <h2 className="text-[15px] font-medium">Prioritize is locked</h2>
              <p className="mt-1 text-[12px] text-muted-foreground">
                {unvalidated} gap{unvalidated === 1 ? "" : "s"} still unconfirmed
                {partials ? ` · ${partials} partial must be split or rewritten` : ""}.
              </p>
            </>
          )}
        </div>
    </div>
  );
}
