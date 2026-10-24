"use client";

import { RelationshipFit } from "@/components/relationship-fit";
import Link from "next/link";
import { GapRecordLink } from "@/components/gap-panel";
import { useMemo, useRef, useState } from "react";
import { AddIdeaDialog } from "@/components/ideation/gap-proposal-group";
import { ProposalCard, type ProposalCardModel } from "@/components/ideation/proposal-card";
import { AssignTacticButton, CustomTacticButton, CreateTacticButton } from "@/components/plan-cards";
import type { ActionIdentity } from "@/components/platform/action-dialog";
import { RunStageButton } from "@/components/platform/run-stage-button";
import { useAiEnabled } from "@/components/platform/ai-status";
import { GapMetadataView } from "@/components/gap-metadata";
import { gapNumberLabel } from "@/lib/iegp/gap-number";
import { TacticEditPanel, type TacticEditModel } from "@/components/tactic-ideation/tactic-panel";
import type { OpenGapCard, PlanTactic, TacticLibraryItem } from "@/lib/iegp/engine";
import type { RetainedTacticGap } from "@/components/tactic-ideation/data";
import { BAND_LABELS } from "@/components/matrix/bands";
import { DOMAIN_LABELS, GAP_STATUS_LABELS, OVERALL_COVERAGE_LABELS } from "@/lib/iegp/enums";
import { tacticColor, tacticTypeLabel } from "@/lib/iegp/tactic-type-colors";
import { customTypesInUse, type CustomTacticType } from "@/lib/iegp/custom-tactic-type";
import { filterPlanningGaps, planningLabel, summarizePlanning } from "@/components/tactic-ideation/planning";
import { cn } from "@/lib/utils";

type Coverage = "" | "unlinked" | "linked";

const FIELD =
  "h-7 rounded-md border border-input bg-background px-2 text-caption text-foreground focus-visible:outline-2 focus-visible:outline-ring";

type Typed = { type: string; custom_type?: CustomTacticType | null };

function TypeChip({ tactic }: { tactic: Typed }) {
  const color = tacticColor(tactic);
  return (
    <span
      className="inline-flex items-center rounded-sm border-l-[3px] px-1.5 py-px text-caption font-medium text-foreground"
      style={{ borderLeftColor: color, backgroundColor: `${color}1a` }}
    >
      {tacticTypeLabel(tactic)}
    </span>
  );
}

const STATUS_TONE: Record<string, string> = {
  ongoing: "bg-[color:var(--known)]/10 text-known-foreground ",
  planned: "bg-[color:var(--opportunity)]/10 text-primary ",
  completed: "bg-muted text-foreground",
  proposed: "bg-primary/10 text-primary ",
  cancelled: "bg-muted text-muted-foreground",
};

function StatusChip({ status }: { status: string }) {
  return (
    <span className={cn("rounded-sm px-1.5 py-px text-caption capitalize", STATUS_TONE[status] ?? "bg-muted text-foreground")}>
      {status}
    </span>
  );
}

function LinkedTacticRow({ tactic, onEdit }: { tactic: PlanTactic; onEdit?: () => void }) {
  const className =
    "flex w-full flex-wrap items-center gap-2 rounded-md border border-border px-3 py-1.5 text-left text-foreground no-underline hover:bg-muted/60";
  const body = (
    <>
        <span className="font-mono text-caption" style={{ color: tacticColor(tactic) }}>
          {tactic.id}
        </span>
        <span className="min-w-0 basis-full break-words text-sm font-semibold leading-snug sm:basis-0 sm:flex-1">{tactic.name}</span>
        <TypeChip tactic={tactic} />
        <StatusChip status={tactic.status} />
        <span className="text-caption text-muted-foreground" aria-hidden>
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
      <div className="mt-1 grid gap-1 px-3 text-caption leading-5 text-muted-foreground" data-testid="linked-planning-facts">
        <p>{planningLabel([tactic])} · Lifecycle: <span className="capitalize">{tactic.status}</span></p>
        <p>Coverage: {tactic.overall ? OVERALL_COVERAGE_LABELS[tactic.overall] : "Unassessed"}
          {tactic.overall && tactic.overall !== "unassessed" && !tactic.fit?.confirmation.locked ? " · Provisional" : ""}
          {" · "}Human confirmation: {tactic.fit?.confirmation.locked ? `Confirmed by ${tactic.fit.confirmation.actor_name || "an unrecorded reviewer"}` : "Not confirmed"}
          {tactic.stale || tactic.fit?.stale ? " · Outdated — explicit reassessment required" : ""}
          {tactic.needs_review || tactic.fit?.needs_review ? " · Review needed" : ""}
          {tactic.fit?.source_changed ? " · Requirement sources changed" : ""}
        </p>
        {tactic.fit ? <p>Remaining need: {tactic.fit.dimensions.filter(row => row.unanswered).length} unanswered requirement(s) for this tactic.
          {tactic.fit.dimensions.some(row => row.fit === "unknown") ? " Unknown information remains; inspect fit details below." : " Inspect fit details below."}
        </p> : null}
        <p>Evidence availability: {tactic.fit?.contribution.evidence_available ? `Recorded date ${tactic.fit.contribution.evidence_available}` : "Not documented"}. Delivery of evidence has not been verified by this view.</p>
      </div>
      {tactic.fit ? <RelationshipFit fit={tactic.fit} tacticName={tactic.name} /> : null}
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
    <article
      className="overflow-hidden rounded-lg border border-border bg-card"
      data-testid="ideation-gap"
      data-gap-id={card.gap_id}
    >
      <button
        type="button"
        data-testid="ideation-gap-toggle"
        aria-expanded={expanded}
        aria-controls={bodyId}
        onClick={onToggle}
        className="flex w-full flex-wrap items-start gap-2 px-4 py-3 text-left hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-ring"
      >
        <span className="text-caption text-muted-foreground" aria-hidden>
          {expanded ? "▾" : "▸"}
        </span>
        <span className="shrink-0 font-mono text-caption font-medium text-primary" title={card.gap_id}>
          {gapNumberLabel(card.number)}
        </span>
        <span className="min-w-0 basis-full break-words text-sm font-semibold leading-snug sm:basis-0 sm:flex-1 text-foreground">{card.gap_name}</span>
        <span className="flex max-w-full flex-wrap items-center gap-1.5">
          <span className="rounded-sm bg-muted px-2 py-px text-caption text-foreground">{planningLabel(linked)}</span>
          <span className="text-caption text-muted-foreground">Coverage status: {GAP_STATUS_LABELS[card.gap_status]}</span>
          {suggestions.length > 0 ? (
            <span className="rounded-full bg-muted px-2 py-px text-caption font-medium text-muted-foreground">
              {suggestions.length} option{suggestions.length === 1 ? "" : "s"}
            </span>
          ) : null}
          <span className="rounded-sm bg-destructive/10 px-1.5 py-px text-caption text-destructive">
            {DOMAIN_LABELS[card.domain]}
          </span>
        </span>
      </button>

      {expanded ? (
        <div id={bodyId} className="grid gap-3 border-t border-border px-4 pb-4 pt-3">
          <div className="flex flex-wrap items-start gap-2">
            <p className="min-w-0 flex-1 text-callout leading-5 text-muted-foreground">
              {card.statement}
              {card.settings.length > 0 ? (
                <span className="ml-1 text-caption">· {card.settings.join(" · ")}</span>
              ) : null}
              <GapMetadataView metadata={card.metadata} compact className="block" />
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <GapRecordLink gapId={card.gap_id} className="text-caption text-muted-foreground no-underline hover:underline">
                Open gap ↗
              </GapRecordLink>
              <AssignTacticButton gapId={card.gap_id} tactics={assignable} previews={card.fit_previews} expectedRelationships={JSON.stringify(card.relationship_versions ?? {})} />
              <CustomTacticButton gapId={card.gap_id} gapName={card.gap_name} inUse={customTypesInUse(library)} />
            </div>
          </div>

          <section aria-label={`Linked tactics for ${card.gap_name}`}>
            <h3 className="mb-1.5 text-caption font-semibold text-muted-foreground">
              Linked tactics
            </h3>
            {linked.length === 0 ? (
              <p className="rounded-md border border-dashed border-border px-3 py-2 text-caption text-muted-foreground">
                No tactic yet. Assign one from the library or add a custom tactic.
              </p>
            ) : (
              <ul className="grid gap-1.5">
                {linked.map((tactic) => (
                  <LinkedTacticRow
                    key={`${tactic.id}::${tactic.expansion_id ?? "parent"}`}
                    tactic={tactic}
                    onEdit={!tactic.expansion_id && onEditTactic ? () => void onEditTactic(tactic.id) : undefined}
                  />
                ))}
              </ul>
            )}
          </section>

          {ai || suggestions.length > 0 ? (
            <section aria-label={`Tactic options for ${card.gap_name}`}>
              <div className="mb-1.5 flex flex-wrap items-center gap-2">
                <h3 className="text-caption font-semibold text-muted-foreground">Current and prior options</h3>
                {ai ? <span className="rounded-sm bg-primary/10 px-1.5 py-px text-caption text-primary">AI-assisted</span> : null}
                {ai && mayIdeate ? <div className="ml-auto">
                  <RunStageButton
                    stage="S9"
                    input={{ gap_ids: [card.gap_id] }}
                    label={suggestions.length === 0 ? "Suggest tactics" : "Suggest more"}
                    identity={identity}
                  />
                </div> : null}
              </div>
              {suggestions.length === 0 ? (
                <p className="rounded-md border border-dashed border-border px-3 py-2 text-caption text-muted-foreground">
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
          <span className="text-caption text-muted-foreground" aria-hidden>
            {open ? "▾" : "▸"}
          </span>
          <span id="tactic-library" className="text-callout font-semibold text-foreground">
            Tactic Library
          </span>
        </button>
        <span className="rounded-full bg-primary/10 px-2 py-px text-caption text-primary">
          {items.length} tactic{items.length === 1 ? "" : "s"}
        </span>
        {unassigned > 0 ? (
          <span className="rounded-full bg-unknown/10 px-2 py-px text-caption text-unknown-foreground">
            {unassigned} unassigned
          </span>
        ) : null}
        <div className="ml-auto">
          <CreateTacticButton inUse={customTypesInUse(items)} />
        </div>
      </div>
      {open ? (
        <div id="tactic-library-body" className="grid gap-2 border-t border-border px-4 pb-4 pt-3">
          <p className="text-caption text-muted-foreground">
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
            <p className="rounded-md border border-dashed border-border px-3 py-2 text-center text-caption text-muted-foreground">
              {items.length === 0 ? "The library is empty. Add a tactic with Create tactic." : "No tactics match."}
            </p>
          ) : (
            <ul className="grid gap-1.5">
              {shown.map((item) => (
                <li
                  key={item.id}
                  className={cn(
                    "flex flex-wrap items-center gap-2 rounded-md border border-border px-3 py-1.5",
                    item.gaps.length === 0 ? "bg-unknown/15 " : "bg-background",
                  )}
                >
                  <span className="font-mono text-caption" style={{ color: tacticColor(item) }}>
                    {item.id}
                  </span>
                  <span className="min-w-0 basis-full break-words text-sm font-semibold leading-snug sm:basis-0 sm:flex-1 text-foreground">{item.name}</span>
                  <TypeChip tactic={item} />
                  {item.gaps.length === 0 ? (
                    <span className="rounded-sm bg-unknown/10 px-1.5 py-px text-caption text-unknown-foreground">
                      Unassigned
                    </span>
                  ) : (
                    <span className="flex flex-wrap items-center gap-1">
                      {item.gaps.map((gap) => (
                        <GapRecordLink
                          key={gap.id}
                          gapId={gap.id}
                          title={gap.name}
                          className="rounded-sm bg-primary/10 px-1.5 py-px font-mono text-caption text-primary no-underline hover:underline"
                        >
                          {gap.id}
                        </GapRecordLink>
                      ))}
                    </span>
                  )}
                  <StatusChip status={item.status} />
                  {onEdit ? (
                    <button
                      type="button"
                      onClick={() => onEdit(item.id)}
                      className="text-caption text-muted-foreground hover:text-foreground hover:underline"
                    >
                      ✎ Edit<span className="sr-only"> {item.name}</span>
                    </button>
                  ) : (
                    <Link href={`/tactics/${item.id}`} className="text-caption text-muted-foreground no-underline hover:underline">
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
 * Tactic Ideation: current High-priority Open gaps and retained work, each with its
 * linked tactics, AI suggestions (AI on only) and a hand-written custom tactic, then the
 * tactic library.
 */
export function IdeationBoard({
  gaps,
  retainedGaps = [],
  proposals,
  library,
  identity,
  mayIdeate,
  tactics = {},
}: {
  gaps: OpenGapCard[];
  retainedGaps?: RetainedTacticGap[];
  proposals: ProposalCardModel[];
  library: TacticLibraryItem[];
  identity: ActionIdentity;
  mayIdeate: boolean;
  /** Editable tactic records for the side panel (KAN-50); a tactic without one opens its page. */
  tactics?: Record<string, TacticEditModel>;
}) {
  const ai = useAiEnabled("ideation");
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const openEditor = (tacticId: string) => {
    if (!tactics[tacticId]) return false;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setEditingId(tacticId);
    return true;
  };
  const inUse = useMemo(() => customTypesInUse(Object.values(tactics)), [tactics]);
  const canEdit = identity.signed_in && Object.keys(tactics).length > 0;
  const [query, setQuery] = useState("");
  const [domain, setDomain] = useState("");
  const [coverage, setCoverage] = useState<Coverage>("");
  // Every card starts collapsed (owner feedback, KAN-56).
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const domains = useMemo(() => [...new Set([...gaps, ...retainedGaps].map(gap => gap.domain))].sort(), [gaps, retainedGaps]);
  const filtered = useMemo(() => filterPlanningGaps(gaps, { query, domain, links: coverage }), [gaps, query, domain, coverage]);
  const existing = useMemo(() => filterPlanningGaps(retainedGaps, { query, domain, links: coverage }), [retainedGaps, query, domain, coverage]);
  const currentSummary = summarizePlanning(filtered);
  const retainedSummary = summarizePlanning(existing);
  const options = (gapId: string) => proposals.filter(proposal => proposal.gap_id === gapId);
  const toggle = (gapId: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(gapId)) next.delete(gapId);
      else next.add(gapId);
      return next;
    });
  const filtering = Boolean(query || domain || coverage);

  return (
    <div className="grid gap-2" data-testid="tactic-ideation">
      {/* What this section is for, and how far along it is (owner feedback, KAN-56). */}
      <section aria-label="How Tactic Ideation works" className="grid gap-2 rounded-lg border border-border bg-card p-3" data-testid="ideation-guide">
        <p className="text-callout font-semibold text-foreground" data-testid="current-planning-summary">
          Current eligible gaps: {currentSummary.total} shown · No candidate linked: {currentSummary.unlinked} · Candidate linked: {currentSummary.linked} · Tactic planned: {currentSummary.planned}
        </p>
        <ol className="grid gap-1 text-caption leading-4 text-muted-foreground sm:grid-cols-3">
          <li>
            <span className="font-semibold text-foreground">1. Open a gap.</span> These are the gaps you validated as High
            priority on the Prioritization Matrix.
          </li>
          <li>
            <span className="font-semibold text-foreground">2. Give it a tactic.</span> Assign one from the library
            {ai ? ", write a custom tactic, or accept a suggestion." : " or write a custom tactic."}
          </li>
          <li>
            <span className="font-semibold text-foreground">3. Plan and assess.</span> Planning alone does not make a gap Addressed. Supported,
            human-confirmed Full coverage can count while planned; unassessed planned work leaves the gap Partially Addressed.
            Publication tactics with evidence already available can count even when proposed. Schedule work on the Gantt Timeline.
          </li>
        </ol>
        <p className="text-caption leading-4 text-muted-foreground">Planning counts describe saved links and lifecycle, separately from coverage assessment. Planned, ongoing and completed work is labelled Tactic planned; a cancelled link remains Candidate linked. A link or lifecycle does not verify delivery of evidence. Counts follow the search and filters below.</p>
      </section>
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5">
        <input
          type="search"
          aria-label="Search high-priority gaps and existing work"
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
          <option value="unlinked">No candidate linked</option>
          <option value="linked">Has linked candidates or planned tactics</option>
        </select>
        {filtering ? (
          <button
            type="button"
            onClick={() => {
              setQuery("");
              setDomain("");
              setCoverage("");
            }}
            className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-0.5 text-caption text-destructive"
          >
            Clear
          </button>
        ) : null}
        <span className="ml-auto text-caption text-muted-foreground">
          {filtered.length} of {gaps.length} currently eligible gaps
        </span>
      </div>

      <div className="grid gap-2">
        <h2 className="text-body font-semibold">Current eligible ideation</h2>
        {filtered.map((card) => (
          <GapIdeationCard
            key={card.gap_id}
            card={card}
            expanded={expanded.has(card.gap_id)}
            onToggle={() => toggle(card.gap_id)}
            suggestions={options(card.gap_id)}
            library={library}
            identity={identity}
            mayIdeate={mayIdeate}
            onEditTactic={canEdit ? openEditor : undefined}
          />
        ))}
        {gaps.length === 0 ? (
          <div className="rounded-lg border border-border bg-card p-8 text-center text-callout text-muted-foreground">
            No confirmed High/Open gaps eligible for new ideation. Use the{" "}
            <Link href="/?place=plan" className="text-foreground">
              Prioritization Matrix
            </Link>{" "}
            to validate a gap as High.
          </div>
        ) : filtered.length === 0 ? (
          <div className="rounded-lg border border-border bg-card p-8 text-center text-callout text-muted-foreground">
            No gaps match the current filters.
          </div>
        ) : null}
      </div>

      <section aria-label="Existing options and planned work" className="grid gap-2 rounded-lg border border-border bg-card p-3">
        <h2 className="text-body font-semibold">Existing options and planned work</h2>
        <p className="text-callout text-muted-foreground">Prior work remains here when a gap leaves current High/Open eligibility. Open a gap to inspect its options, linked tactics and decision history. Search and filters above also apply here.</p>
        <p className="text-callout font-medium" data-testid="retained-planning-summary">Retained work: {retainedSummary.total} shown · No candidate linked: {retainedSummary.unlinked} · Candidate linked: {retainedSummary.linked} · Tactic planned: {retainedSummary.planned}</p>
        {existing.length ? <ul className="grid gap-2">{existing.map(gap => <li key={gap.gap_id} className="rounded-md border border-border p-3 text-callout">
          <GapRecordLink gapId={gap.gap_id} className="font-medium underline">{gapNumberLabel(gap.number)} · {gap.gap_name}</GapRecordLink>
          <p className="mt-1 text-muted-foreground">{GAP_STATUS_LABELS[gap.gap_status]} · {gap.band ? BAND_LABELS[gap.band] : "Priority unset"} · {gap.needs_review ? "Needs priority review" : gap.priority_confirmed ? "Priority validated" : "Priority not validated"}</p>
          <p className="mt-1">{planningLabel(gap.tactics)}</p>
          <p className="text-muted-foreground">{gap.option_count} option{gap.option_count === 1 ? "" : "s"} · {gap.tactic_count} linked tactic{gap.tactic_count === 1 ? "" : "s"}</p>
          {gap.tactics.length ? <ul className="mt-2 grid gap-2" aria-label={`Linked tactics for ${gap.gap_name}`}>
            {gap.tactics.map(tactic => <LinkedTacticRow key={`${tactic.id}::${tactic.expansion_id ?? "parent"}`} tactic={tactic} onEdit={!tactic.expansion_id && canEdit ? () => void openEditor(tactic.id) : undefined} />)}
          </ul> : null}
        </li>)}</ul> : <p className="text-callout text-muted-foreground">{retainedGaps.length ? "No existing work matches the current filters." : "No prior work outside current eligible ideation yet. Existing options are shown with their eligible gap above."}</p>}
      </section>
      <LibraryPanel items={library} onEdit={canEdit ? (id) => void openEditor(id) : undefined} />
      <TacticEditPanel
        tactic={editingId ? (tactics[editingId] ?? null) : null}
        identity={identity}
        inUse={inUse}
        onClose={() => setEditingId(null)}
        returnFocusRef={returnFocusRef}
      />
    </div>
  );
}
