import Link from "next/link";
import type { HistoryEntry } from "@/lib/iegp/entity-history";
import { ROLE_LABELS } from "@/modules/auth/roles";

function label(value: string): string {
  return value.replace(/_/g, " ");
}

function when(at: string): string {
  return at.replace("T", " ").slice(0, 16);
}

/** Long values (a statement, a JSON snapshot) are cut for the list; long changes can be expanded. */
function short(value: string | null): string {
  if (value === null || value === "") return "—";
  return value.length > 160 ? `${value.slice(0, 157)}…` : value;
}

/** S8 stores the full judgement, separately from the change reason on the entry. */
function changeText(value: string | null, field: string | null): string | null {
  if (!value) return value;
  if (field === "relationship" || field === "model_relationship") {
    try {
      const snapshot = JSON.parse(value);
      const coverages = snapshot.coverages as { id: string; expansion_id?: string; overall: string; overall_lock: { locked: boolean }; needs_review: boolean; dimensions: Record<string, { value: string; lock: { locked: boolean } }> }[];
      const coverage = coverages.map(row => {
        const dimensions = Object.entries(row.dimensions).filter(([, cell]) => cell.value !== "unknown" || cell.lock.locked).map(([name, cell]) => `${label(name)}: ${cell.value}${cell.lock.locked ? " (human confirmed)" : ""}`).join(", ");
        return `${row.expansion_id ? `Expansion ${row.expansion_id}: ` : ""}Coverage: ${label(row.overall)}${row.overall_lock.locked ? " (human confirmed)" : ""}${row.needs_review ? "; coverage review required" : ""}${dimensions ? `. Dimensions: ${dimensions}` : ""}`;
      }).join("; ") || "Not linked";
      return `${coverage}. Relationship decision: ${snapshot.decision?.status ?? "not recorded"}.`;
    } catch { return value; }
  }
  if (field !== "placement") return value;
  try {
    const snapshot = JSON.parse(value);
    if (!snapshot || typeof snapshot !== "object" || !("confirmed" in snapshot)) return value;
    const scores = Object.entries(snapshot.axis_scores ?? {}).map(([axis, score]) => `${label(axis)}: ${score}`).join(", ") || "Unscored";
    return `Band: ${label(String(snapshot.band ?? "Unset"))}. Scores: ${scores}. Priority rationale: ${snapshot.rationale || "Not recorded"}. ${snapshot.confirmed ? "Priority confirmed" : "Priority not confirmed"}.${snapshot.actor_name ? ` Recorded by: ${snapshot.actor_name}.` : ""}${snapshot.at ? ` Recorded at: ${when(snapshot.at)}.` : ""}${snapshot.decision_origin ? ` Decision: ${label(snapshot.decision_origin)}.` : ""}${snapshot.suggested_rationale ? ` Suggested band: ${snapshot.suggested_band}. Suggested rationale: ${snapshot.suggested_rationale}` : ""}`;
  } catch {
    // Older placement history used plain text; retain it verbatim.
    return value;
  }
}

function hasSuggestion(entry: HistoryEntry): boolean {
  if (entry.field === "model_suggestion" || entry.field === "supported_model_status" || entry.field === "model_relationship") return true;
  if (/suggest|model|(?:^|[._])ai(?:[._]|$)/.test(entry.action)) return true;
  if (entry.field !== "placement" || !entry.after) return false;
  try {
    const saved = JSON.parse(entry.after);
    return Boolean(saved.suggested_rationale || saved.decision_origin === "supported_ai");
  } catch { return false; }
}

/**
 * A gap's or tactic's History (KAN-90): who did what, in which role, when,
 * before → after and why, newest first.
 */
export function EntityHistory({ entries, empty = "No changes recorded yet." }: { entries: HistoryEntry[]; empty?: string }) {
  return (
    <section className="mb-8" data-testid="entity-history" aria-label="Recorded changes">
      <h2
        className="mb-2 text-callout font-semibold text-muted-foreground"
      >
        History
      </h2>
      <p className="mb-2 text-callout text-muted-foreground">Read-only, newest first. Up to 200 recorded changes are shown; older changes may be omitted. Corrections use the authorised editors and append history.</p>
      {entries.length === 0 ? (
        <p className="rounded-lg border border-border bg-card p-3 text-body text-muted-foreground">{empty}</p>
      ) : (
        <ol className="grid gap-2">
          {entries.map((entry) => {
            const before = changeText(entry.before, entry.field);
            const after = changeText(entry.after, entry.field);
            return (
              <li key={entry.id} className="rounded-lg border border-border bg-card p-3 text-body" data-testid="history-entry">
                <p className="text-callout text-muted-foreground">
                  <time dateTime={entry.at}>{when(entry.at)}</time>
                  {" · "}
                  <span className="font-medium text-foreground">{entry.actor_name}</span>
                  {entry.actor_principal && entry.actor_principal !== entry.actor_name ? ` (${entry.actor_principal})` : ""}
                  {entry.actor_role ? ` · ${(ROLE_LABELS as Record<string, string>)[entry.actor_role] ?? label(entry.actor_role)}` : ""}
                </p>
                <p className="mt-1">
                  {entry.shared_context ? <span className="font-medium">Shared context · </span> : null}
                  <span className="font-medium">{label(entry.action)}</span>
                  {entry.field ? ` ${label(entry.field)}` : ""}
                  {` · ${label(entry.entity_type)} ${entry.entity_id}`}
                </p>
                {entry.counterpart_gaps?.length ? <p className="mt-1">Gap: {entry.counterpart_gaps.map((gap, index) => <span key={gap.id}>
                  {index ? ", " : ""}<Link href={`/gaps/${encodeURIComponent(gap.id)}`}>{gap.name} ({gap.id})</Link>
                </span>)}</p> : null}
                {entry.counterpart_tactics?.length ? <p className="mt-1">Tactic: {entry.counterpart_tactics.map((tactic, index) => <span key={tactic.id}>
                  {index ? ", " : ""}<Link href={`/tactics/${encodeURIComponent(tactic.id)}`}>{tactic.name} ({tactic.id})</Link>
                </span>)}</p> : null}
                {entry.kind === "edit" && (entry.before !== null || entry.after !== null) ? (
                  <p className="mt-1 break-words" data-testid="history-change">
                    <span className="text-muted-foreground line-through" title={before ?? undefined}>
                      {short(before)}
                    </span>
                    {" → "}
                    <span title={after ?? undefined}>{short(after)}</span>
                  </p>
                ) : null}
                {(before?.length ?? 0) > 160 || (after?.length ?? 0) > 160 ? (
                  <details className="mt-1 break-words">
                    <summary className="cursor-pointer">Show full change</summary>
                    <p className="mt-1 whitespace-pre-wrap">Before: {before || "—"}</p>
                    <p className="mt-1 whitespace-pre-wrap">After: {after || "—"}</p>
                  </details>
                ) : null}
                {entry.supporting_references?.length ? <ul aria-label="Decision supporting references" className="mt-2 grid gap-1">
                  {entry.supporting_references.map((reference, index) => <li key={index}>
                    {reference.target ? <Link href={reference.target.href}>{reference.target.title} ({label(reference.entity_type)} {reference.entity_id})</Link> : <span>Reference unavailable ({label(reference.entity_type)} {reference.entity_id})</span>}: {reference.reason}
                  </li>)}
                </ul> : null}
                {!entry.supporting_references?.length && hasSuggestion(entry) ? <p className="mt-1 text-muted-foreground">Supporting references not recorded for this suggestion</p> : null}
                <p className="mt-1 text-muted-foreground">
                  {entry.rationale ? `“${entry.rationale}”` : "Reason not recorded"}
                </p>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
