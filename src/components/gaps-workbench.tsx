"use client";

import { useMemo, useState } from "react";
import { GapBadge } from "@/components/iegp-badges";
import { LockForm } from "@/components/lock-form";
import { GapFormFields } from "@/components/gap-form-fields";
import { SettingChips } from "@/components/gap-settings-editor";
import { gapNumberLabel } from "@/lib/iegp/gap-number";
import { GapSuggestions, NewSourcePill } from "@/components/gap-suggestions";
import type { GapSuggestionCard } from "@/lib/iegp/gap-suggestion-cards";

const STATUS_BAND: Record<string, string> = {
  validated_open: "border-l-rose-500",
  validated_partial: "border-l-amber-500",
  validated_addressed: "border-l-emerald-500",
};
import { customTypesInUse } from "@/lib/iegp/custom-tactic-type";
import {
  GAPS_TACTIC_HELPER,
  RecordMissedFields,
} from "@/components/gap-tactic-actions";
import {
  DOMAIN_LABELS,
  GAP_STATUS_LABELS,
} from "@/lib/iegp/enums";
import {
  filterReviewGapCards,
  reviewGapFilterCounts,
  sortReviewGapCards,
  type ReviewGapCard,
  type ReviewGapFilter,
  type TacticLibraryItem,
} from "@/lib/iegp/engine";
import { Button } from "@/components/ui/button";
import { AddTacticsButton } from "@/components/plan-cards";
import { cn } from "@/lib/utils";
import { useAiEnabled } from "@/components/platform/ai-status";
import { GapRecordLink } from "@/components/gap-panel";

const FILTER_CHIPS: { id: ReviewGapFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "partial", label: "Partial" },
  { id: "open", label: "Open" },
  { id: "addressed", label: "Addressed" },
  { id: "needs_validation", label: "Unconfirmed" },
];

function CreateOpenGap() {
  return (
    <LockForm
      label="Add open gap"
      action="create_gap"
      confirmLabel="Add open gap"
      size="lg"
      description="A gap no tactic answers yet. Everything here can be changed later on the gap."
    >
      <GapFormFields />
    </LockForm>
  );
}

function CreateAddressedGap({ tactics }: { tactics: TacticLibraryItem[] }) {
  return (
    <LockForm
      label="Add addressed gap"
      action="create_addressed_gap"
      confirmLabel="Add addressed gap"
      size="lg"
      description="A gap an existing study already answers. Name the study below."
    >
      <GapFormFields />
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

export type GapPriority = { band: "high" | "medium" | "low" | "defer"; validated: boolean };

type SortKey = "id" | "name" | "domain" | "status" | "priority" | "tactics";

const PRIORITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2, defer: 3 };
const PRIORITY_LABELS: Record<GapPriority["band"], string> = { high: "High", medium: "Medium", low: "Low", defer: "Defer" };

function PriorityChip({ priority }: { priority?: GapPriority }) {
  if (!priority) return <span className="text-[11px] text-muted-foreground">—</span>;
  const tone =
    priority.band === "high"
      ? "border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300"
      : priority.band === "medium"
        ? "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300"
        : priority.band === "low"
          ? "border-blue-200 bg-blue-50 text-blue-800 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-300"
          : "border-stone-200 bg-stone-100 text-stone-600 dark:border-stone-500/30 dark:bg-stone-500/10 dark:text-stone-300";
  return (
    <span
      className={cn("inline-flex items-center rounded border px-1.5 py-0.5 text-[10.5px] font-medium", tone)}
      title={priority.validated ? "Validated on the Prioritization Matrix" : "Draft — not validated yet"}
    >
      {PRIORITY_LABELS[priority.band]}
      {priority.validated ? null : <span className="ml-1 font-normal opacity-70">draft</span>}
    </span>
  );
}

function SortHeader({
  label,
  column,
  sort,
  onSort,
  className,
}: {
  label: string;
  column: SortKey;
  sort: { key: SortKey; dir: "asc" | "desc" } | null;
  onSort: (key: SortKey) => void;
  className?: string;
}) {
  const active = sort?.key === column;
  return (
    <th
      scope="col"
      aria-sort={active ? (sort!.dir === "asc" ? "ascending" : "descending") : "none"}
      className={cn("px-3 py-2 text-left font-semibold", className)}
    >
      <button
        type="button"
        onClick={() => onSort(column)}
        aria-label={`Sort by ${label}`}
        className="inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.08em] text-muted-foreground hover:text-foreground"
      >
        {label}
        <span aria-hidden className={cn("text-[9px]", active ? "text-foreground" : "opacity-40")}>
          {active && sort!.dir === "desc" ? "▼" : "▲"}
        </span>
      </button>
    </th>
  );
}

const selectClass =
  "h-8 rounded-md border border-input bg-card px-2 text-[11.5px] text-foreground focus-visible:outline-2 focus-visible:outline-ring";

/**
 * Evidence Inventory (KAN-8, the owner's Figma design): a Jira-style list of every
 * gap. Search and filters narrow it, column headers sort it, and each gap opens in the shared detail panel.
 */
export function GapsWorkbench({
  cards,
  availableTactics,
  readyForPrioritize,
  initialFilter,
  settingOptions = [],
  priorities = {},
  suggestions = [],
}: {
  cards: ReviewGapCard[];
  availableTactics: TacticLibraryItem[];
  readyForPrioritize: boolean;
  initialFilter?: ReviewGapFilter;
  settingOptions?: string[];
  /** Each gap's band on the Prioritization Matrix, when it has one. */
  priorities?: Record<string, GapPriority>;
  /** Overlaps waiting on a person: merge, split or reject (KAN-75). */
  suggestions?: GapSuggestionCard[];
}) {
  const [filter, setFilterState] = useState<ReviewGapFilter>(initialFilter ?? "all");
  // A link to another `gap_filter` (the readiness strip) keeps this component mounted:
  // follow the URL when it changes (KAN-18).
  const [seenFilter, setSeenFilter] = useState(initialFilter);
  if (seenFilter !== initialFilter) {
    setSeenFilter(initialFilter);
    setFilterState(initialFilter ?? "all");
  }
  // A chip writes its filter into the URL, so a reload or a shared link keeps it.
  const setFilter = (next: ReviewGapFilter) => {
    setFilterState(next);
    try {
      const url = new URL(window.location.href);
      if (next === "all") url.searchParams.delete("gap_filter");
      else url.searchParams.set("gap_filter", next);
      window.history.replaceState(window.history.state, "", url);
    } catch {
      // No URL to update (tests, sandboxed frames): the chip still filters.
    }
  };
  const [query, setQuery] = useState("");
  const [domain, setDomain] = useState("");
  const [setting, setSetting] = useState("");
  const [priority, setPriority] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" } | null>(null);
  const ai = useAiEnabled("ingestion");
  const counts = reviewGapFilterCounts(cards);
  const domains = useMemo(() => [...new Set(cards.map((card) => card.domain))].sort(), [cards]);
  const settings = useMemo(
    () => [...new Set([...settingOptions, ...cards.flatMap((card) => card.settings)])].sort(),
    [cards, settingOptions],
  );
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = sortReviewGapCards(filterReviewGapCards(cards, filter)).filter((card) => {
      if (q && ![card.gap_id, gapNumberLabel(card.number), card.gap_name, card.statement, DOMAIN_LABELS[card.domain]].some((v) => v.toLowerCase().includes(q))) {
        return false;
      }
      if (domain && card.domain !== domain) return false;
      if (setting && !card.settings.includes(setting)) return false;
      const band: string = priorities[card.gap_id]?.band ?? "";
      if (priority === "none" ? band !== "" : priority && band !== priority) return false;
      return true;
    });
    if (!sort) return rows;
    const value = (card: ReviewGapCard): string | number => {
      switch (sort.key) {
        case "id":
          return card.gap_id;
        case "name":
          return card.gap_name.toLowerCase();
        case "domain":
          return DOMAIN_LABELS[card.domain];
        case "status":
          return GAP_STATUS_LABELS[card.gap_status];
        case "priority":
          return PRIORITY_ORDER[priorities[card.gap_id]?.band ?? ""] ?? 9;
        case "tactics":
          return card.tactics.length;
      }
    };
    const dir = sort.dir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const va = value(a);
      const vb = value(b);
      return (va < vb ? -1 : va > vb ? 1 : 0) * dir;
    });
  }, [cards, filter, query, domain, setting, priority, sort, priorities]);
  const partials = counts.partial;
  const unvalidated = counts.needs_validation;
  const extraFilters = [query, domain, setting, priority].filter(Boolean).length;

  function onSort(key: SortKey) {
    setSort((current) => (current?.key === key ? { key, dir: current.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }));
  }

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <CreateOpenGap />
        <CreateAddressedGap tactics={availableTactics} />
        <AddTacticsButton variant="outline" inUse={customTypesInUse(availableTactics)} />
      </div>
      <p className="-mt-2 text-[11px] text-muted-foreground">{GAPS_TACTIC_HELPER}</p>
      <GapSuggestions suggestions={suggestions} />
      {cards.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border bg-card px-4 py-6 text-center text-[12px] text-muted-foreground">
          {ai
            ? "No gaps yet. Ingest a source on Upload, or add an Open or Addressed gap here."
            : "No gaps yet. Add an Open or Addressed gap here."}
        </p>
      ) : (
        <>
          <div className="grid gap-2 rounded-lg border border-border bg-card p-2">
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search gaps…"
                aria-label="Search gaps"
                className="h-8 w-56 rounded-md border border-input bg-muted/50 px-2.5 text-[11.5px] text-foreground placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring"
              />
              <select aria-label="Filter by domain" value={domain} onChange={(e) => setDomain(e.target.value)} className={selectClass}>
                <option value="">Domain</option>
                {domains.map((d) => (
                  <option key={d} value={d}>
                    {DOMAIN_LABELS[d]}
                  </option>
                ))}
              </select>
              <select aria-label="Filter by priority" value={priority} onChange={(e) => setPriority(e.target.value)} className={selectClass}>
                <option value="">Priority</option>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
                <option value="defer">Defer</option>
                <option value="none">Not prioritized</option>
              </select>
              <select aria-label="Filter by setting" value={setting} onChange={(e) => setSetting(e.target.value)} className={selectClass}>
                <option value="">Setting</option>
                {settings.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
              {extraFilters > 0 ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setQuery("");
                    setDomain("");
                    setSetting("");
                    setPriority("");
                  }}
                >
                  Clear ({extraFilters})
                </Button>
              ) : null}
              <span className="ml-auto text-[11px] text-muted-foreground" aria-live="polite">
                {visible.length} of {cards.length}
              </span>
            </div>
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
          </div>
          <div className="overflow-x-auto rounded-lg border border-border bg-card">
            <table className="w-full min-w-[820px] border-collapse text-[12px]" data-testid="evidence-inventory">
              <thead className="border-b border-border bg-muted/60">
                <tr>
                  <SortHeader label="ID" column="id" sort={sort} onSort={onSort} className="w-[132px]" />
                  <SortHeader label="Gap" column="name" sort={sort} onSort={onSort} />
                  <SortHeader label="Domain" column="domain" sort={sort} onSort={onSort} className="w-[150px]" />
                  <SortHeader label="Status" column="status" sort={sort} onSort={onSort} className="w-[160px]" />
                  <SortHeader label="Priority" column="priority" sort={sort} onSort={onSort} className="w-[110px]" />
                  <th scope="col" className="w-[130px] px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                    Setting
                  </th>
                  <SortHeader label="Tactics" column="tactics" sort={sort} onSort={onSort} className="w-[84px]" />
                </tr>
              </thead>
              <tbody>
                {visible.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-[12px] text-muted-foreground">
                      No gaps match these filters.
                    </td>
                  </tr>
                ) : null}
                {visible.map((card) => {
                  const unconfirmed = !card.human_validated || card.gap_status === "validated_partial";
                  return (
                    <tr key={card.gap_id}
                        data-gap-id={card.gap_id}
                        className={cn(
                          "border-b border-border/70 transition-colors",
                          "hover:bg-muted/50",
                        )}
                      >
                        {/* Every row carries its status colour (KAN-56): open, partial or addressed. */}
                        <td
                          className={cn("border-l-[3px] px-3 py-2 align-top font-mono text-[11px] text-primary", STATUS_BAND[card.gap_status] ?? "border-l-border")}
                          title={card.gap_id}
                        >
                          {gapNumberLabel(card.number)}
                        </td>
                        <td className="px-3 py-2 align-top">
                          <GapRecordLink
                            gapId={card.gap_id}
                            data-testid="gap-row-toggle"
                            className="flex w-full items-start gap-1.5 text-left"
                          >
                            <span aria-hidden className="mt-0.5 text-[10px] text-muted-foreground">▸</span>
                            <span className="min-w-0">
                              <span className="block font-medium leading-snug text-foreground">{card.gap_name}</span>
                              {unconfirmed ? (
                                <span className="text-[10.5px] text-amber-700 dark:text-amber-300">
                                  {card.gap_status === "validated_partial" ? "Split or rewrite" : "Unconfirmed"}
                                </span>
                              ) : null}
                              {card.new_source ? <NewSourcePill /> : null}
                            </span>
                          </GapRecordLink>
                        </td>
                        <td className="px-3 py-2 align-top text-[11px] text-muted-foreground">{DOMAIN_LABELS[card.domain]}</td>
                        <td className="px-3 py-2 align-top">
                          <GapBadge status={card.gap_status} />
                        </td>
                        <td className="px-3 py-2 align-top">
                          <PriorityChip priority={priorities[card.gap_id]} />
                        </td>
                        <td className="px-3 py-2 align-top">
                          {card.settings.length ? <SettingChips settings={card.settings} /> : <span className="text-[11px] text-muted-foreground">—</span>}
                        </td>
                        <td className="px-3 py-2 align-top text-[11px] text-muted-foreground">
                          {card.tactics.length}
                          {card.needs_review ? <span className="ml-1 text-amber-700 dark:text-amber-300">· review</span> : null}
                        </td>
                      </tr>

                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
      <div className="rounded-lg border border-border bg-card p-4">
        {readyForPrioritize ? (
          <>
            <h2 className="text-[13px] font-semibold">Continue to prioritize</h2>
            <p className="mt-1 mb-3 text-[12px] text-muted-foreground">
              Every live gap is confirmed. Open gaps go to the Prioritization Matrix, then Tactic Ideation.
            </p>
            <LockForm
              label="Continue to prioritize"
              action="complete_wizard"
              confirmLabel="Go to prioritize"
              href="/?place=plan"
            />
          </>
        ) : cards.length === 0 ? (
          // No gaps: there is nothing to confirm yet, so name the first step, not "0 unconfirmed" (KAN-68).
          <>
            <h2 className="text-[13px] font-semibold">Add gaps first</h2>
            <p className="mt-1 text-[12px] text-muted-foreground">
              There are no gaps yet. Add them{ai ? " from an uploaded source or" : ""} by hand, confirm each one here,
              then continue to prioritize.
            </p>
          </>
        ) : (
          <>
            <h2 className="text-[13px] font-semibold">Not ready for Prioritize yet</h2>
            <p className="mt-1 text-[12px] text-muted-foreground">
              {unvalidated} gap{unvalidated === 1 ? "" : "s"} still unconfirmed
              {partials ? ` · ${partials} partial must be split or rewritten` : ""}. You can open the
              Prioritization Matrix now, but it only has the gaps already validated as Open.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
