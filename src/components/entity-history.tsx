import type { HistoryEntry } from "@/lib/iegp/entity-history";
import { ROLE_LABELS } from "@/modules/auth/roles";

function label(value: string): string {
  return value.replace(/_/g, " ");
}

function when(at: string): string {
  return at.replace("T", " ").slice(0, 16);
}

/** Long values (a statement, a JSON snapshot) are cut for the list; the full text is in the title. */
function short(value: string | null): string {
  if (value === null || value === "") return "—";
  return value.length > 160 ? `${value.slice(0, 157)}…` : value;
}

/**
 * A gap's or tactic's History (KAN-90): who did what, in which role, when,
 * before → after and why, newest first.
 */
export function EntityHistory({ entries, empty = "No changes recorded yet." }: { entries: HistoryEntry[]; empty?: string }) {
  return (
    <section className="mb-8" data-testid="entity-history" aria-labelledby="entity-history-heading">
      <h2
        id="entity-history-heading"
        className="mb-2 text-[12px] font-semibold uppercase tracking-[0.08em] text-muted-foreground"
      >
        History
      </h2>
      {entries.length === 0 ? (
        <p className="rounded-lg border border-border bg-card p-3 text-[13px] text-muted-foreground">{empty}</p>
      ) : (
        <ol className="grid gap-2">
          {entries.map((entry) => (
            <li key={entry.id} className="rounded-lg border border-border bg-card p-3 text-[13px]" data-testid="history-entry">
              <p className="text-[12px] text-muted-foreground">
                <time dateTime={entry.at}>{when(entry.at)}</time>
                {" · "}
                <span className="font-medium text-foreground">{entry.actor_name}</span>
                {entry.actor_principal && entry.actor_principal !== entry.actor_name ? ` (${entry.actor_principal})` : ""}
                {entry.actor_role ? ` · ${(ROLE_LABELS as Record<string, string>)[entry.actor_role] ?? label(entry.actor_role)}` : ""}
              </p>
              <p className="mt-1">
                <span className="font-medium">{label(entry.action)}</span>
                {entry.field ? ` ${label(entry.field)}` : ""}
                {entry.entity_type !== "gap" && entry.entity_type !== "tactic" ? ` · ${label(entry.entity_type)} ${entry.entity_id}` : ""}
              </p>
              {entry.kind === "edit" && (entry.before !== null || entry.after !== null) ? (
                <p className="mt-1 break-words" data-testid="history-change">
                  <span className="text-muted-foreground line-through" title={entry.before ?? undefined}>
                    {short(entry.before)}
                  </span>
                  {" → "}
                  <span title={entry.after ?? undefined}>{short(entry.after)}</span>
                </p>
              ) : null}
              <p className="mt-1 text-muted-foreground">
                {entry.rationale ? `“${entry.rationale}”` : "No rationale given."}
              </p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
