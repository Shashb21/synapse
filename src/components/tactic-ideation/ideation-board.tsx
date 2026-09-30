"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { AddIdeaDialog } from "@/components/ideation/gap-proposal-group";
import { ProposalCard, type ProposalCardModel } from "@/components/ideation/proposal-card";
import { AssignTacticButton, CustomTacticButton, CreateTacticButton } from "@/components/plan-cards";
import type { ActionIdentity } from "@/components/platform/action-dialog";
import { RunStageButton } from "@/components/platform/run-stage-button";
import { useAiEnabled } from "@/components/platform/ai-status";
import { GapMetadataView } from "@/components/gap-metadata";
import { TacticEditPanel, type TacticEditModel } from "@/components/tactic-ideation/tactic-panel";
import type { OpenGapCard, PlanTactic, TacticLibraryItem } from "@/lib/iegp/engine";
import { DOMAIN_LABELS } from "@/lib/iegp/enums";
import { tacticColor, tacticTypeLabel } from "@/lib/iegp/tactic-type-colors";
import { customTypesInUse, type CustomTacticType } from "@/lib/iegp/custom-tactic-type";
import { cn } from "@/lib/utils";

type Coverage = "" | "unlinked" | "linked";

const FIELD =
  "h-7 rounded-md border border-input bg-background px-2 text-[11px] text-foreground focus-visible:outline-2 focus-visible:outline-ring";

type Typed = { type: string; custom_type?: CustomTacticType | null };

function TypeChip({ tactic }: { tactic: Typed }) {
  const color = tacticColor(tactic);
  return (
    <span
      className="inline-flex items-center rounded-sm border-l-[3px] px-1.5 py-px text-[10px] font-medium text-foreground"
      style={{ borderLeftColor: color, backgroundColor: `${color}1a` }}
    >
      {tacticTypeLabel(tactic)}
    </span>
  );
}

const STATUS_TONE: Record<string, string> = {
  ongoing: "bg-[color:var(--known)]/10 text-emerald-800 dark:text-emerald-300",
  planned: "bg-[color:var(--opportunity)]/10 text-blue-800 dark:text-blue-300",
  completed: "bg-muted text-foreground",
  proposed: "bg-primary/10 text-indigo-800 dark:text-indigo-300",
  cancelled: "bg-muted text-muted-foreground",
};

function StatusChip({ status }: { status: string }) {
  return (
    <span className={cn("rounded-sm px-1.5 py-px text-[10px] capitalize", STATUS_TONE[status] ?? "bg-muted text-foreground")}>
      {status}
    </span>
  );
}

function LinkedTacticRow({ tactic, onEdit }: { tactic: PlanTactic; onEdit?: () => void }) {
  const className =
    "flex w-full flex-wrap items-center gap-2 rounded-md border border-border px-3 py-1.5 text-left text-foreground no-underline hover:bg-muted/60";
  const body = (
    <>
        <span className="font-mono text-[10px]" style={{ color: tacticColor(tactic) }}>
          {tactic.id}
        </span>
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium">{tactic.name}</span>
        <TypeChip tactic={tactic} />
        <StatusChip status={tactic.status} />
        <span className="text-[10px] text-muted-foreground" aria-hidden>
          ✎
        </span>
        <span className="sr-only">Edit {tactic.name}</span>
    </>
  );
  return (
    <li>
      {onEdit ? (
        <button type="button" onClick={onEdit} className={className}>
          {body}
        </button>
      ) : (
        <Link href={`/tactics/${tactic.id}`} className={className}>
          {body}
        </Link>
      )}
    </li>
  );
}

function GapIdeationCard({
  card,
  expanded,
  onToggle,
  suggestions,
  library,
  identity,
  mayIdeate,
  onEditTactic,
}: {
  card: OpenGapCard;
  expanded: boolean;
  onToggle: () => void;
  suggestions: ProposalCardModel[];
  library: TacticLibraryItem[];
  identity: ActionIdentity;
  mayIdeate: boolean;
  /** Opens the side panel for a tactic; returns false when it has no editable record. */
  onEditTactic?: (tacticId: string) => boolean;
}) {
  const ai = useAiEnabled("ideation");
  const linked = card.tactics;
  const assignable = library.filter((item) => !linked.some((row) => row.id === item.id));
  const bodyId = `ideation-${card.gap_id}`;
  return (
    <article className="overflow-hidden rounded-lg border border-border bg-card" data-testid="ideation-gap">
      <button
        type="button"
        data-testid="ideation-gap-toggle"
        aria-expanded={expanded}
        aria-controls={bodyId}
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-4 py-3 text-left hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-ring"
      >
        <span className="text-[11px] text-muted-foreground" aria-hidden>
          {expanded ? "▾" : "▸"}
        </span>
        <span className="shrink-0 font-mono text-[11px] font-medium text-primary">{card.gap_id}</span>
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground">{card.gap_name}</span>
        <span className="flex shrink-0 flex-wrap items-center gap-1.5">
          {linked.length > 0 ? (
            <span className="rounded-full bg-primary/10 px-2 py-px text-[10px] font-medium text-indigo-800 dark:text-indigo-300">
              {linked.length} tactic{linked.length === 1 ? "" : "s"}
            </span>
          ) : null}
          {ai && suggestions.length > 0 ? (
            <span className="rounded-full bg-muted px-2 py-px text-[10px] font-medium text-muted-foreground">
              {suggestions.length} suggestion{suggestions.length === 1 ? "" : "s"}
            </span>
          ) : null}
          <span className="rounded-sm bg-rose-50 px-1.5 py-px text-[10px] text-rose-800 dark:bg-rose-950/40 dark:text-rose-300">
            {DOMAIN_LABELS[card.domain]}
          </span>
        </span>
      </button>

      {expanded ? (
        <div id={bodyId} className="grid gap-3 border-t border-border px-4 pb-4 pt-3">
          <div className="flex flex-wrap items-start gap-2">
            <p className="min-w-0 flex-1 text-[12px] leading-5 text-muted-foreground">
              {card.statement}
              {card.settings.length > 0 ? (
                <span className="ml-1 text-[11px]">· {card.settings.join(" · ")}</span>
              ) : null}
              <GapMetadataView metadata={card.metadata} compact className="block" />
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Link href={`/gaps/${card.gap_id}`} className="text-[11px] text-muted-foreground no-underline hover:underline">
                Open gap ↗
              </Link>
              <AssignTacticButton gapId={card.gap_id} tactics={assignable} />
              <CustomTacticButton gapId={card.gap_id} gapName={card.gap_name} inUse={customTypesInUse(library)} />
            </div>
          </div>

          <section aria-label={`Linked tactics for ${card.gap_name}`}>
            <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              Linked tactics
            </h3>
            {linked.length === 0 ? (
              <p className="rounded-md border border-dashed border-border px-3 py-2 text-[11px] text-muted-foreground">
                No tactic yet. Assign one from the library or add a custom tactic.
              </p>
            ) : (
              <ul className="grid gap-1.5">
                {linked.map((tactic) => (
                  <LinkedTacticRow
                    key={tactic.id}
                    tactic={tactic}
                    onEdit={onEditTactic ? () => void onEditTactic(tactic.id) : undefined}
                  />
                ))}
              </ul>
            )}
          </section>

          {ai ? (
            <section aria-label={`Suggested tactics for ${card.gap_name}`}>
              <div className="mb-1.5 flex flex-wrap items-center gap-2">
                <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Suggested</h3>
                <span className="rounded-sm bg-primary/10 px-1.5 py-px text-[10px] text-indigo-800 dark:text-indigo-300">
                  AI-assisted
                </span>
                <div className="ml-auto">
                  <RunStageButton
                    stage="S9"
                    input={{ gap_ids: [card.gap_id] }}
                    label={suggestions.length === 0 ? "Suggest tactics" : "Suggest more"}
                    identity={identity}
                  />
                </div>
              </div>
              {suggestions.length === 0 ? (
                <p className="rounded-md border border-dashed border-border px-3 py-2 text-[11px] text-muted-foreground">
                  No suggestion waiting. The model designs candidates against the tactic library; you accept or reject each
                  one with a reason.
                </p>
              ) : (
                <div className="grid gap-2 lg:grid-cols-2">
                  {suggestions.map((proposal) => (
                    <ProposalCard key={proposal.id} proposal={proposal} identity={identity} mayIdeate={mayIdeate} />
                  ))}
                </div>
              )}
              {mayIdeate ? (
                <div className="mt-2">
                  <AddIdeaDialog gapId={card.gap_id} gapName={card.gap_name} identity={identity} />
                </div>
              ) : null}
            </section>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function LibraryPanel({ items, onEdit }: { items: TacticLibraryItem[]; onEdit?: (tacticId: string) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (item) =>
        item.name.toLowerCase().includes(q) ||
        item.id.toLowerCase().includes(q) ||
        tacticTypeLabel(item).toLowerCase().includes(q),
    );
  }, [items, query]);
  const unassigned = items.filter((item) => item.gaps.length === 0).length;
  return (
    <section aria-labelledby="tactic-library" className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex flex-wrap items-center gap-2 px-4 py-2">
        <button
          type="button"
          aria-expanded={open}
          aria-controls="tactic-library-body"
          onClick={() => setOpen((value) => !value)}
          className="flex items-center gap-2 rounded-md py-1 text-left focus-visible:outline-2 focus-visible:outline-ring"
        >
          <span className="text-[11px] text-muted-foreground" aria-hidden>
            {open ? "▾" : "▸"}
          </span>
          <span id="tactic-library" className="text-[12px] font-semibold text-foreground">
            Tactic Library
          </span>
        </button>
        <span className="rounded-full bg-primary/10 px-2 py-px text-[10px] text-indigo-800 dark:text-indigo-300">
          {items.length} tactic{items.length === 1 ? "" : "s"}
        </span>
        {unassigned > 0 ? (
          <span className="rounded-full bg-orange-50 px-2 py-px text-[10px] text-orange-800 dark:bg-orange-950/40 dark:text-orange-300">
            {unassigned} unassigned
          </span>
        ) : null}
        <div className="ml-auto">
          <CreateTacticButton inUse={customTypesInUse(items)} />
        </div>
      </div>
      {open ? (
        <div id="tactic-library-body" className="grid gap-2 border-t border-border px-4 pb-4 pt-3">
          <p className="text-[11px] text-muted-foreground">
            Tag the same tactic onto as many gaps as you need — it is not copied.
          </p>
          <input
            type="search"
            aria-label="Search library"
            placeholder="Search library…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className={cn(FIELD, "w-full")}
          />
          {shown.length === 0 ? (
            <p className="rounded-md border border-dashed border-border px-3 py-2 text-center text-[11px] text-muted-foreground">
              {items.length === 0 ? "The library is empty. Add a tactic with Create tactic." : "No tactics match."}
            </p>
          ) : (
            <ul className="grid gap-1.5">
              {shown.map((item) => (
                <li
                  key={item.id}
                  className={cn(
                    "flex flex-wrap items-center gap-2 rounded-md border border-border px-3 py-1.5",
                    item.gaps.length === 0 ? "bg-amber-50/60 dark:bg-amber-950/20" : "bg-background",
                  )}
                >
                  <span className="font-mono text-[10px]" style={{ color: tacticColor(item) }}>
                    {item.id}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground">{item.name}</span>
                  <TypeChip tactic={item} />
                  {item.gaps.length === 0 ? (
                    <span className="rounded-sm bg-orange-50 px-1.5 py-px text-[10px] text-orange-800 dark:bg-orange-950/40 dark:text-orange-300">
                      Unassigned
                    </span>
                  ) : (
                    <span className="flex flex-wrap items-center gap-1">
                      {item.gaps.map((gap) => (
                        <Link
                          key={gap.id}
                          href={`/gaps/${gap.id}`}
                          title={gap.name}
                          className="rounded-sm bg-primary/10 px-1.5 py-px font-mono text-[10px] text-indigo-800 no-underline hover:underline dark:text-indigo-300"
                        >
                          {gap.id}
                        </Link>
                      ))}
                    </span>
                  )}
                  <StatusChip status={item.status} />
                  {onEdit ? (
                    <button
                      type="button"
                      onClick={() => onEdit(item.id)}
                      className="text-[11px] text-muted-foreground hover:text-foreground hover:underline"
                    >
                      ✎ Edit<span className="sr-only"> {item.name}</span>
                    </button>
                  ) : (
                    <Link href={`/tactics/${item.id}`} className="text-[11px] text-muted-foreground no-underline hover:underline">
                      ✎ Edit<span className="sr-only"> {item.name}</span>
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  );
}

/**
 * Tactic Ideation (KAN-8): the High-priority Open gaps as collapsible cards, each with its
 * linked tactics, AI suggestions (AI on only) and a hand-written custom tactic, then the
 * tactic library.
 */
export function IdeationBoard({
  gaps,
  proposals,
  library,
  identity,
  mayIdeate,
  tactics = {},
}: {
  gaps: OpenGapCard[];
  proposals: ProposalCardModel[];
  library: TacticLibraryItem[];
  identity: ActionIdentity;
  mayIdeate: boolean;
  /** Editable tactic records for the side panel (KAN-50); a tactic without one opens its page. */
  tactics?: Record<string, TacticEditModel>;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const openEditor = (tacticId: string) => {
    if (!tactics[tacticId]) return false;
    setEditingId(tacticId);
    return true;
  };
  const inUse = useMemo(() => customTypesInUse(Object.values(tactics)), [tactics]);
  const canEdit = identity.signed_in && Object.keys(tactics).length > 0;
  const [query, setQuery] = useState("");
  const [domain, setDomain] = useState("");
  const [coverage, setCoverage] = useState<Coverage>("");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(gaps[0] ? [gaps[0].gap_id] : []));

  const domains = useMemo(() => [...new Set(gaps.map((gap) => gap.domain))].sort(), [gaps]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return gaps.filter((gap) => {
      if (q && !gap.gap_name.toLowerCase().includes(q) && !gap.gap_id.toLowerCase().includes(q)) return false;
      if (domain && gap.domain !== domain) return false;
      if (coverage === "linked" && gap.tactics.length === 0) return false;
      if (coverage === "unlinked" && gap.tactics.length > 0) return false;
      return true;
    });
  }, [gaps, query, domain, coverage]);
  const waiting = (gapId: string) =>
    proposals.filter((proposal) => proposal.gap_id === gapId && proposal.status === "proposed");
  const toggle = (gapId: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(gapId)) next.delete(gapId);
      else next.add(gapId);
      return next;
    });
  const filtering = Boolean(query || domain || coverage);
  const withoutTactics = gaps.filter((gap) => gap.tactics.length === 0).length;

  return (
    <div className="grid gap-2" data-testid="tactic-ideation">
      <p className="text-[11px] text-muted-foreground">
        {gaps.length} high-priority gap{gaps.length === 1 ? "" : "s"} · {withoutTactics} without linked tactics
      </p>
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5">
        <input
          type="search"
          aria-label="Search high-priority gaps"
          placeholder="Search gaps…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className={cn(FIELD, "w-48")}
        />
        <span className="h-5 w-px bg-border" aria-hidden />
        <select aria-label="Filter by domain" value={domain} onChange={(event) => setDomain(event.target.value)} className={FIELD}>
          <option value="">Domain</option>
          {domains.map((value) => (
            <option key={value} value={value}>
              {DOMAIN_LABELS[value]}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter by tactics"
          value={coverage}
          onChange={(event) => setCoverage(event.target.value as Coverage)}
          className={FIELD}
        >
          <option value="">All gaps</option>
          <option value="unlinked">No tactics yet</option>
          <option value="linked">Has tactics</option>
        </select>
        {filtering ? (
          <button
            type="button"
            onClick={() => {
              setQuery("");
              setDomain("");
              setCoverage("");
            }}
            className="rounded-md border border-rose-200 bg-rose-50 px-2 py-0.5 text-[11px] text-rose-800 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300"
          >
            Clear
          </button>
        ) : null}
        <span className="ml-auto text-[11px] text-muted-foreground">
          {filtered.length} of {gaps.length}
        </span>
      </div>

      <div className="grid gap-2">
        {filtered.map((card) => (
          <GapIdeationCard
            key={card.gap_id}
            card={card}
            expanded={expanded.has(card.gap_id)}
            onToggle={() => toggle(card.gap_id)}
            suggestions={waiting(card.gap_id)}
            library={library}
            identity={identity}
            mayIdeate={mayIdeate}
            onEditTactic={canEdit ? openEditor : undefined}
          />
        ))}
        {gaps.length === 0 ? (
          <div className="rounded-lg border border-border bg-card p-8 text-center text-[12px] text-muted-foreground">
            No high-priority gaps. Use the{" "}
            <Link href="/?place=plan" className="text-foreground">
              Prioritization Matrix
            </Link>{" "}
            to validate a gap as High.
          </div>
        ) : filtered.length === 0 ? (
          <div className="rounded-lg border border-border bg-card p-8 text-center text-[12px] text-muted-foreground">
            No gaps match the current filters.
          </div>
        ) : null}
      </div>

      <LibraryPanel items={library} onEdit={canEdit ? (id) => void openEditor(id) : undefined} />
      <TacticEditPanel
        tactic={editingId ? (tactics[editingId] ?? null) : null}
        identity={identity}
        inUse={inUse}
        onClose={() => setEditingId(null)}
      />
    </div>
  );
}
