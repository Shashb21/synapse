"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { CoverageBadge, GapBadge, NeedsReviewFlag, TacticBadge } from "@/components/iegp-badges";
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
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

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

function ConstituentNeedsButton({ card }: { card: ReviewGapCard }) {
  const count = card.needs.length;
  return (
    <Dialog>
      <DialogTrigger render={<Button type="button" size="sm" variant="outline" />}>
        View constituent needs{count ? ` (${count})` : ""}
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Where this gap comes from</DialogTitle>
          <DialogDescription>
            Constituent needs are the sourced statements this gap stands for — the document or
            interview it was extracted from. If several sources identified the same gap, every
            source is listed. Many needs can join one gap.
          </DialogDescription>
        </DialogHeader>
        {card.needs.length === 0 ? (
          <p className="text-[12px] text-muted-foreground">
            No source yet. This gap was added on Gaps, not from ingest.
          </p>
        ) : (
          <ul className="grid gap-2">
            {card.needs.map((need) => (
              <li key={need.id} className="border border-border bg-card/40 p-3 text-[13px]">
                <p className="text-[11px] text-muted-foreground">
                  {need.source_title || "Unknown source"}
                  {need.role ? ` · ${need.role}` : ""}
                </p>
                <p className="mt-1">{need.statement}</p>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
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
      <NeedsReviewFlag needsReview={tactic.needs_review} />
    </li>
  );
}

/** Compact left-list row — summary only. Full detail lives in GapDetailPane. */
function GapListRow({
  card,
  selected,
  onSelect,
}: {
  card: ReviewGapCard;
  selected: boolean;
  onSelect: () => void;
}) {
  const unconfirmed = !card.human_validated || card.gap_status === "validated_partial";
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "w-full border-l-2 border-border bg-background px-3 py-2.5 text-left transition-colors",
        unconfirmed && "border-l-amber-400",
        selected ? "bg-sidebar-accent/60 ring-1 ring-inset ring-border" : "hover:bg-sidebar-accent/30",
      )}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <GapBadge status={card.gap_status} />
        <span className="text-[11px] text-muted-foreground">{DOMAIN_LABELS[card.domain]}</span>
      </div>
      <p className="mt-1 truncate text-[13px] leading-5 text-foreground">{card.gap_name}</p>
      <p className="mt-0.5 text-[11px] text-muted-foreground">
        {card.tactics.length} tactic{card.tactics.length === 1 ? "" : "s"}
        {card.needs_review ? " · review coverage" : ""}
      </p>
    </button>
  );
}

/** Full detail for the selected gap — the same actions the flat list used to render per row. */
function GapDetailPane({
  card,
  availableTactics,
}: {
  card: ReviewGapCard;
  availableTactics: TacticLibraryItem[];
}) {
  const isPartial = card.gap_status === "validated_partial";
  return (
    <article className="border border-border bg-background p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-mono text-[11px] text-muted-foreground">{card.gap_id}</p>
        <Link
          href={`/gaps/${card.gap_id}`}
          className="text-[11px] text-muted-foreground no-underline hover:underline"
        >
          Open full page ↗
        </Link>
      </div>
      <h2 className="mt-1 text-[16px] font-medium leading-6 text-foreground">{card.gap_name}</h2>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {isPartial ? (
          <GapBadge status={card.gap_status} />
        ) : (
          <GapStatusOverride
            gapId={card.gap_id}
            status={card.gap_status}
            computedStatus={card.computed_status}
            override={card.status_override}
          />
        )}
        <span className="text-[11px] text-muted-foreground">{DOMAIN_LABELS[card.domain]}</span>
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
      <GapStatusDisagreement computedStatus={card.computed_status} override={card.status_override} />
      <p className="mt-3 text-[13px] leading-5 text-muted-foreground">{card.statement}</p>
      <div className="mt-4">
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Tactics</p>
        <ul className="mt-1 grid gap-1.5">
          {card.tactics.length === 0 ? (
            <li className="text-[12px] text-muted-foreground">No tactics mapped</li>
          ) : (
            card.tactics.map((tactic) => <MappedTacticRow key={tactic.id} tactic={tactic} />)
          )}
        </ul>
      </div>
      {/* Hero action first: Resolve (Partial) or Confirm (everything else still unconfirmed) stand apart from the secondary actions below. */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {isPartial ? (
          <SplitGapDialog
            gapId={card.gap_id}
            gapName={card.gap_name}
            residualName={card.residual?.statement || card.gap_name}
            tactics={card.tactics}
          />
        ) : !card.human_validated ? (
          <LockForm
            label="Confirm status"
            action="validate_gap"
            extra={{ gap_id: card.gap_id }}
            confirmLabel={`Confirm ${GAP_STATUS_LABELS[card.gap_status]}`}
            variant="default"
          />
        ) : null}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <ConstituentNeedsButton card={card} />
        <MapExistingTactic
          gapId={card.gap_id}
          availableTactics={availableTactics}
          mappedTacticIds={card.tactics.map((tactic) => tactic.id)}
        />
        <RecordMissedTactic gapId={card.gap_id} />
      </div>
    </article>
  );
}

export function GapsWorkbench({
  cards,
  availableTactics,
  readyForPrioritize,
  initialFilter,
}: {
  cards: ReviewGapCard[];
  availableTactics: TacticLibraryItem[];
  readyForPrioritize: boolean;
  initialFilter?: ReviewGapFilter;
}) {
  const [filter, setFilter] = useState<ReviewGapFilter>(initialFilter ?? "all");
  const counts = reviewGapFilterCounts(cards);
  const visible = useMemo(
    () => sortReviewGapCards(filterReviewGapCards(cards, filter)),
    [cards, filter],
  );
  const [selectedId, setSelectedId] = useState<string | null>(visible[0]?.gap_id ?? null);
  // Keep a selection in view whenever the filter changes the visible set.
  useEffect(() => {
    if (!visible.some((card) => card.gap_id === selectedId)) {
      setSelectedId(visible[0]?.gap_id ?? null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);
  const selected = visible.find((card) => card.gap_id === selectedId) ?? null;
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
          {/* List | detail split — list stays full-width and detail replaces it below the fold on narrow screens. */}
          <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] lg:items-start">
            <div className={cn("grid gap-1.5", selected && "hidden lg:grid")}>
              {visible.map((card) => (
                <GapListRow
                  key={card.gap_id}
                  card={card}
                  selected={card.gap_id === selectedId}
                  onSelect={() => setSelectedId(card.gap_id)}
                />
              ))}
            </div>
            <div className={cn("lg:sticky lg:top-5", !selected && "hidden lg:block")}>
              {selected ? (
                <>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="mb-2 lg:hidden"
                    onClick={() => setSelectedId(null)}
                  >
                    ← Back to list
                  </Button>
                  <GapDetailPane card={selected} availableTactics={availableTactics} />
                </>
              ) : (
                <p className="text-[12px] text-muted-foreground">Select a gap from the list.</p>
              )}
            </div>
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
