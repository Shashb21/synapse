"use client";

import { LockForm } from "@/components/lock-form";
import { gapNumberLabel } from "@/lib/iegp/gap-number";
import type { GapSuggestionCard } from "@/lib/iegp/gap-suggestion-cards";

const INPUT = "h-8 w-full rounded-lg border border-input bg-card px-2.5 text-[12px] text-foreground";
const AREA = "w-full rounded-lg border border-input bg-card px-2.5 py-2 text-[12px] text-foreground";
const LABEL = "grid gap-1 text-[11px] font-medium text-muted-foreground";

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
    <li className="rounded-lg border border-border bg-card p-4" data-suggestion-id={suggestion.id}>
      <p className="text-[11px] text-muted-foreground">
        Overlaps <span className="font-mono">{label}</span> · {suggestion.gap_name}
      </p>
      <div className="mt-2 grid gap-3 md:grid-cols-2">
        <div>
          <p className="text-[11px] font-medium text-muted-foreground">The gap now</p>
          <p className="mt-1 text-[13px] leading-5 text-foreground">{suggestion.gap_statement}</p>
        </div>
        <div>
          <p className="text-[11px] font-medium text-muted-foreground">
            New source: {suggestion.source_title}
            {suggestion.extra_source_count > 0
              ? ` and ${suggestion.extra_source_count} more saying the same`
              : ""}
          </p>
          <blockquote className="mt-1 border-l-2 border-border pl-2 text-[13px] leading-5 text-foreground">
            “{suggestion.source_quote}”
          </blockquote>
        </div>
      </div>
      <dl className="mt-3 grid gap-1 text-[12px]">
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
        <section className="rounded-md border border-border bg-muted/30 p-3" aria-label="Merge into this gap">
          <p className="text-[12px] font-semibold text-foreground">Merge into this gap</p>
          <p className="mt-1 text-[12px] font-medium text-foreground">{suggestion.merged_name}</p>
          <p className="mt-0.5 text-[12px] leading-5 text-muted-foreground">{suggestion.merged_statement}</p>
          <div className="mt-2">
            <LockForm
              label="Accept merge"
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
        <section className="rounded-md border border-border bg-muted/30 p-3" aria-label="Keep as a separate gap">
          <p className="text-[12px] font-semibold text-foreground">Keep as a separate gap</p>
          <p className="mt-1 text-[12px] font-medium text-foreground">{suggestion.split_name}</p>
          <p className="mt-0.5 text-[12px] leading-5 text-muted-foreground">{suggestion.split_statement}</p>
          <div className="mt-2">
            <LockForm
              label="Accept split"
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
          label="Reject"
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
      className="rounded-lg border border-amber-200 bg-amber-50/60 p-4 dark:border-amber-500/30 dark:bg-amber-500/5"
      data-testid="gap-suggestions"
    >
      <h2 id="gap-suggestions-heading" className="text-[13px] font-semibold text-foreground">
        Suggested changes ({suggestions.length})
      </h2>
      <p className="mt-1 text-[12px] text-muted-foreground">
        A new source shares part of an existing gap&apos;s question and adds something of its own. Merge it into the
        gap, keep the new part as a separate gap, or reject it. Nothing changes until you decide.
      </p>
      <ul className="mt-3 grid gap-3">
        {suggestions.map((suggestion) => (
          <SuggestionItem key={suggestion.id} suggestion={suggestion} />
        ))}
      </ul>
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
    <div className="mt-3 rounded-md border border-amber-200 bg-amber-50/70 p-3 text-[12px] dark:border-amber-500/30 dark:bg-amber-500/5">
      <p className="font-medium text-amber-800 dark:text-amber-300">
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
    <span className="ml-1 inline-flex items-center rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10.5px] font-medium text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
      New source added
    </span>
  );
}
