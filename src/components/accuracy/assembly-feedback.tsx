"use client";

/** Record and inspect operational feedback on an exact consumed assembly. */
import { useState } from "react";
import Link from "next/link";
import type { AssemblyFeedback, AssemblyFeedbackCategory, AssemblyFeedbackRun } from "@/accuracy/domain/assembly-feedback";
import { ASSEMBLY_FEEDBACK_CATEGORIES } from "@/accuracy/domain/assembly-feedback";
import { Button } from "@/components/ui/button";

export type FeedbackForm = {
  consumerRunId: string;
  selectedItemVersionIds: string[];
  category: AssemblyFeedbackCategory;
  rationale: string;
};

const categoryLabels: Record<AssemblyFeedbackCategory, string> = {
  accepted_unchanged: "Accepted unchanged", edited: "Edited", rejected: "Rejected",
  missing_item: "Missing item", split_merge: "Split or merged", override: "Overridden",
};

function runLink(workspaceId: string, runId: string): string {
  return `/accuracy/runs/${encodeURIComponent(runId)}?workspace_id=${encodeURIComponent(workspaceId)}`;
}

/** Display exact assembly feedback history and contributor controls. */
export function AssemblyFeedbackSection({ workspaceId, runs, entries, canFeedback, fresh, busy, refreshRequired, error, onSubmit, onRefresh }: {
  workspaceId: string;
  runs: AssemblyFeedbackRun[];
  entries: AssemblyFeedback[];
  canFeedback: boolean;
  fresh: boolean;
  busy: boolean;
  refreshRequired: boolean;
  error: string | null;
  onSubmit: (form: FeedbackForm) => void;
  onRefresh: () => void;
}) {
  const [runId, setRunId] = useState(runs[0]?.run_id ?? "");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [category, setCategory] = useState<AssemblyFeedbackCategory>("accepted_unchanged");
  const [rationale, setRationale] = useState("");
  const run = runs.find(candidate => candidate.run_id === runId);
  const selectableIds = run?.consumed_item_version_ids ?? [];
  const validSelectedIds = selectedIds.filter(id => selectableIds.includes(id));
  const disabled = busy || !fresh || refreshRequired;

  return (
    <section className="grid gap-3 border-t border-border pt-3" aria-label="Production feedback">
      <h3 className="font-medium">Production feedback</h3>
      <p className="text-muted-foreground">These observations do not establish gold accuracy or clinical correctness.</p>
      {runs.length === 0 ? <p className="text-muted-foreground">No eligible production consumer runs recorded for this proposal.</p> : (
        <div className="grid gap-1">
          <p className="font-medium">Eligible consumer runs</p>
          <ul className="grid gap-1">
            {runs.map(candidate => <li key={candidate.run_id}>
              <Link className="underline underline-offset-2" href={runLink(workspaceId, candidate.run_id)}>{candidate.run_id}</Link>
              <span className="text-muted-foreground"> · {candidate.created_at} · Approval {candidate.approval_review_id} · Consumed {candidate.consumed_item_version_ids.join(", ") || "no items"}</span>
            </li>)}
          </ul>
        </div>
      )}
      {canFeedback && runs.length > 0 ? <form className="grid gap-3" aria-label="Record production feedback" onSubmit={event => {
        event.preventDefault();
        if (disabled || !run || !rationale.trim()) return;
        onSubmit({ consumerRunId: run.run_id, selectedItemVersionIds: validSelectedIds, category, rationale: rationale.trim() });
      }}>
        <label className="grid gap-1">
          <span>Consumer run</span>
          <select className="border border-border bg-background p-2 text-foreground" value={run?.run_id ?? ""} disabled={disabled} onChange={event => { setRunId(event.currentTarget.value); setSelectedIds([]); }}>
            {runs.map(candidate => <option key={candidate.run_id} value={candidate.run_id}>{candidate.run_id} · {candidate.created_at}</option>)}
          </select>
        </label>
        <fieldset className="grid gap-1" disabled={disabled}>
          <legend className="font-medium">Consumed items</legend>
          <p className="text-muted-foreground">Leave all unchecked to include every item this proposal contributed to the selected run.</p>
          {selectableIds.map(id => <label className="flex items-center gap-2" key={id}>
            <input type="checkbox" checked={validSelectedIds.includes(id)} onChange={event => setSelectedIds(current => event.currentTarget.checked ? [...current, id] : current.filter(value => value !== id))} />
            <span>Select {id}</span>
          </label>)}
        </fieldset>
        <label className="grid gap-1">
          <span>Feedback category</span>
          <select className="border border-border bg-background p-2 text-foreground" value={category} disabled={disabled} onChange={event => setCategory(event.currentTarget.value as AssemblyFeedbackCategory)}>
            {ASSEMBLY_FEEDBACK_CATEGORIES.map(value => <option key={value} value={value}>{categoryLabels[value]}</option>)}
          </select>
        </label>
        <label className="grid gap-1">
          <span>Feedback rationale</span>
          <textarea aria-label="Feedback rationale" className="min-h-20 border border-border bg-background p-2 text-foreground" value={rationale} disabled={disabled} required onInput={event => setRationale(event.currentTarget.value)} onChange={event => setRationale(event.currentTarget.value)} />
        </label>
        {error ? <p role="alert" className="text-destructive">{error}</p> : null}
        {refreshRequired || !fresh ? <div className="grid gap-1">
          <p className="text-muted-foreground">Refresh this proposal before recording more feedback.</p>
          <div><Button size="sm" type="button" variant="outline" disabled={busy} onClick={onRefresh}>Retry feedback refresh</Button></div>
        </div> : null}
        <div><Button size="sm" type="submit" aria-label="Record feedback" disabled={disabled || !run || !rationale.trim()}>{busy ? "Recording feedback…" : "Record feedback"}</Button></div>
      </form> : canFeedback ? <p className="text-muted-foreground">A production consumer run is required before feedback can be recorded.</p> : <p className="text-muted-foreground">Your current role can read feedback but cannot record it.</p>}
      <div className="grid gap-2" aria-label="Feedback history">
        <p className="font-medium">Feedback history</p>
        {entries.length === 0 ? <p className="text-muted-foreground">No feedback recorded for this proposal.</p> : <ol className="grid gap-3">
          {entries.map(entry => <li key={entry.id} className="border-b border-border pb-3">
            <p className="font-medium">{categoryLabels[entry.category]} · {entry.actor_name} ({entry.actor_function}) · {entry.created_at}</p>
            <p>{entry.rationale}</p>
            <p className="text-muted-foreground">Run <Link className="underline underline-offset-2" href={runLink(workspaceId, entry.consumer_run_id)}>{entry.consumer_run_id}</Link> · Approval {entry.approval_review_id}</p>
            <ul className="grid gap-1">
              {entry.items.map(item => <li key={item.item_version_id}>
                <p>{item.claim_type} {item.item_version_id} · Source {item.source_file_id}</p>
                {item.evidence.length ? <ul className="pl-3 text-muted-foreground">{item.evidence.map((evidence, index) => <li key={`${evidence.source_file_id}:${evidence.block_id}:${index}`}>Source {evidence.source_file_id} · Block {evidence.block_id}: “{evidence.quote}”</li>)}</ul> : <p className="text-muted-foreground">No item evidence recorded.</p>}
              </li>)}
            </ul>
          </li>)}
        </ol>}
      </div>
    </section>
  );
}
