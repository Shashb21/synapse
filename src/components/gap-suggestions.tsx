"use client";

import { LockForm } from "@/components/lock-form";
import { gapNumberLabel } from "@/lib/iegp/gap-number";
import type { GapSuggestionCard } from "@/lib/iegp/gap-suggestion-cards";

const INPUT = "h-8 w-full rounded-lg border border-input bg-card px-2.5 text-callout text-foreground";
const AREA = "w-full rounded-lg border border-input bg-card px-2.5 py-2 text-callout text-foreground";
const LABEL = "grid gap-1 text-caption font-medium text-muted-foreground";

/** The proposed wording, editable before it is accepted. */
function WordingFields({ name, statement }: { name: string; statement: string }) {
  return (
    <>
      <label className={LABEL}>
        Name
        <input name="name" required defaultValue={name} className={INPUT} />
      </label>
      <label className={LABEL}>
        Statement
        <textarea name="statement" required rows={3} defaultValue={statement} className={AREA} />
      </label>
    </>
  );
}

function SuggestionItem({ suggestion }: { suggestion: GapSuggestionCard }) {
  const label = gapNumberLabel(suggestion.gap_number);
  return (
    <li tabIndex={-1} id={`source-suggestion-${suggestion.id}`} className="min-w-0 break-words rounded-lg border border-border bg-card p-4 focus-visible:outline-2 focus-visible:outline-ring" data-suggestion-id={suggestion.id}>
      <p className="text-caption text-muted-foreground">
        Overlaps <span className="font-mono">{label}</span> · {suggestion.gap_name}
      </p>
      <div className="mt-2 grid gap-3 md:grid-cols-2">
        <div>
          <p className="text-caption font-medium text-muted-foreground">The gap now</p>
          <p className="mt-1 text-body leading-5 text-foreground">{suggestion.gap_statement}</p>
        </div>
        <div>
          <p className="text-caption font-medium text-muted-foreground">
            New source: {suggestion.source_title}
            {suggestion.extra_source_count > 0
              ? ` and ${suggestion.extra_source_count} more saying the same`
              : ""}
          </p>
          <blockquote className="mt-1 border-l-2 border-border pl-2 text-body leading-5 text-foreground">
            “{suggestion.source_quote}”
          </blockquote>
        </div>
      </div>
      <dl className="mt-3 grid gap-1 text-callout">
        <div className="flex gap-2">
          <dt className="w-24 shrink-0 text-muted-foreground">In common</dt>
          <dd className="text-foreground">{suggestion.shared_part}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-24 shrink-0 text-muted-foreground">New</dt>
          <dd className="text-foreground">{suggestion.new_part}</dd>
        </div>
      </dl>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <section className="rounded-md border border-border bg-muted/30 p-3" aria-label="Merge into existing gap">
          <p className="text-callout font-semibold text-foreground">Merge into existing gap</p>
          <p className="mt-1 text-callout font-medium text-foreground">{suggestion.merged_name}</p>
          <p className="mt-0.5 text-callout leading-5 text-muted-foreground">{suggestion.merged_statement}</p>
          <div className="mt-2">
            <LockForm
              label="Merge into existing gap"
              triggerName={`Merge into existing gap ${label}`}
              action="accept_gap_merge"
              extra={{ suggestion_id: suggestion.id }}
              confirmLabel="Merge"
              variant="default"
              description={`${label} takes this wording, locked as yours, and the new source joins it. Its tactic mappings are flagged for review and its validated priority goes back to draft, because both were set for the old wording.`}
              note={{ label: "Why merge? (required)", required: true }}
            >
              <WordingFields name={suggestion.merged_name} statement={suggestion.merged_statement} />
            </LockForm>
          </div>
        </section>
        <section className="rounded-md border border-border bg-muted/30 p-3" aria-label="Create separate gap">
          <p className="text-callout font-semibold text-foreground">Create separate gap</p>
          <p className="mt-1 text-callout font-medium text-foreground">{suggestion.split_name}</p>
          <p className="mt-0.5 text-callout leading-5 text-muted-foreground">{suggestion.split_statement}</p>
          <div className="mt-2">
            <LockForm
              label="Create separate gap"
              triggerName={`Create separate gap from ${label}`}
              action="accept_gap_split"
              extra={{ suggestion_id: suggestion.id }}
              confirmLabel="Add separate gap"
              description={`A new gap holds only the new part, with this source. The part in common joins ${label} as a supporting need, and the two gaps are linked as related.`}
              note={{ label: "Why keep it separate? (required)", required: true }}
            >
              <WordingFields name={suggestion.split_name} statement={suggestion.split_statement} />
            </LockForm>
          </div>
        </section>
      </div>
      <div className="mt-3">
        <LockForm
          label="Reject suggestion"
          triggerName={`Reject suggestion for gap ${label}`}
          action="reject_gap_suggestion"
          extra={{ suggestion_id: suggestion.id }}
          confirmLabel="Reject suggestion"
          description="Nothing changes in the plan. The candidate stays on record with the other rejected candidates, where you can still add it as a gap later."
          note={{ label: "Why reject? (required)", required: true }}
        />
      </div>
    </li>
  );
}

/**
 * Overlaps waiting on a person (KAN-75): a new source asks part of an existing
 * gap's question and adds something of its own. Each one is merged into the gap,
 * kept as a separate related gap, or rejected.
 */
export function GapSuggestions({ suggestions }: { suggestions: GapSuggestionCard[] }) {
  if (suggestions.length === 0) return null;
  return (
    <section
      aria-labelledby="gap-suggestions-heading"
      className="rounded-lg border border-unknown/40 bg-unknown/15 p-4"
      data-testid="gap-suggestions"
    >
      <details id="source-suggestions">
        <summary id="gap-suggestions-heading" className="cursor-pointer text-body font-semibold text-foreground focus-visible:outline-2 focus-visible:outline-ring">
          Pending source suggestions: {suggestions.length}
        </summary>
        <p className="mt-1 text-callout text-muted-foreground">
          A new source shares part of an existing gap&apos;s question and adds something of its own. Merge it into the
          gap, keep the new part as a separate gap, or reject it. Nothing changes until you decide.
        </p>
        <ul className="mt-3 grid gap-3">
          {suggestions.map((suggestion) => (
            <SuggestionItem key={suggestion.id} suggestion={suggestion} />
          ))}
        </ul>
      </details>
    </section>
  );
}

/** "New source added" on a gap a person already validated (KAN-74), with its review action. */
export function NewSourceNote({
  gapId,
  newSource,
}: {
  gapId: string;
  newSource: { at: string; statement: string | null; source_title: string | null };
}) {
  return (
    <div className="mt-3 rounded-md border border-unknown/40 bg-unknown/15 p-3 text-callout">
      <p className="font-medium text-unknown-foreground">
        New source added{newSource.source_title ? `: ${newSource.source_title}` : ""}
      </p>
      {newSource.statement ? <p className="mt-1 text-foreground">{newSource.statement}</p> : null}
      <p className="mt-1 text-muted-foreground">
        This gap was already confirmed or prioritized. Check the new source still fits its wording and priority.
      </p>
      <div className="mt-2">
        <LockForm
          label="Mark reviewed"
          action="clear_new_source_flag"
          extra={{ gap_id: gapId }}
          confirmLabel="Mark reviewed"
          note={{ label: "What did you check? (required)", required: true }}
        />
      </div>
    </div>
  );
}

/** A small pill for a gap row: a new source joined after it was validated. */
export function NewSourcePill() {
  return (
    <span className="ml-1 inline-flex items-center rounded border border-unknown/40 bg-unknown/10 px-1.5 py-0.5 text-caption font-medium text-unknown-foreground">
      New source added
    </span>
  );
}
