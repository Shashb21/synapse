import Link from "next/link";
import { LockForm } from "@/components/lock-form";
import { EXCLUSION_LABELS, type ExclusionReason } from "@/lib/iegp/enums";
import type { IegpState } from "@/lib/iegp/types";

/**
 * Undo buttons for decisions that set something aside (KAN-16). Every restore
 * asks for a rationale; the server audits it and files an edit record.
 */

const RATIONALE = { label: "Why restore it? (required)", required: true } as const;

export function RestoreGapButton({ gapId }: { gapId: string }) {
  return (
    <LockForm
      label="Restore gap"
      action="restore_gap"
      extra={{ gap_id: gapId }}
      confirmLabel="Restore"
      description="Brings the gap back. Its status is recomputed from its tactics and it is unconfirmed again, so validate it on Gaps."
      note={RATIONALE}
    />
  );
}

export function UnparkGapButton({ gapId }: { gapId: string }) {
  return (
    <LockForm
      label="Unpark gap"
      action="unpark_gap"
      extra={{ gap_id: gapId }}
      confirmLabel="Unpark"
      description="This brings the gap back into Prioritize and Tactics mapping."
      note={{ label: "Why bring it back? (required)", required: true }}
    />
  );
}

export function RestoreNeedButton({ needId }: { needId: string }) {
  return (
    <LockForm
      label="Restore"
      action="restore_need"
      extra={{ need_id: needId }}
      confirmLabel="Restore need"
      description="Returns the need to candidate, so it can be accepted or rejected again."
      note={RATIONALE}
    />
  );
}

export function RestoreTacticButton({ tacticId }: { tacticId: string }) {
  return (
    <LockForm
      label="Restore tactic"
      action="restore_tactic"
      extra={{ tactic_id: tacticId }}
      confirmLabel="Restore"
      description="Puts the tactic back in the library, ready to map onto gaps."
      note={RATIONALE}
    />
  );
}

export function RestoreMappingButton({ gapId, tacticId }: { gapId: string; tacticId: string }) {
  return (
    <LockForm
      label="Restore"
      action="restore_mapping"
      extra={{ gap_id: gapId, tactic_id: tacticId }}
      confirmLabel="Lift rejection"
      description="Lifts the rejection. The pair is not mapped: map it by hand, or a later mapping run may propose it again for you to decide."
      note={RATIONALE}
    />
  );
}

/**
 * Excluded and parked gaps, listed where gaps are worked on so none of them
 * disappears. Each has its way back.
 */
export function SetAsideGaps({ gaps }: { gaps: IegpState["gaps"] }) {
  const excluded = gaps.filter((gap) => !gap.retired && gap.status === "excluded");
  const parked = gaps.filter((gap) => !gap.retired && gap.status !== "excluded" && gap.parked_at);
  if (excluded.length === 0 && parked.length === 0) return null;
  return (
    <section
      aria-labelledby="set-aside-gaps"
      data-testid="set-aside-gaps"
      className="mt-8 border border-border bg-card/40 p-4"
    >
      <h2 id="set-aside-gaps" className="text-[13px] font-medium text-foreground">
        Set aside ({excluded.length + parked.length})
      </h2>
      <p className="mt-0.5 mb-3 text-[12px] text-muted-foreground">
        Excluded and parked gaps stay out of Prioritize and Tactics. Restore or unpark one to bring it back.
      </p>
      <ul className="grid gap-2">
        {excluded.map((gap) => (
          <li key={gap.id} className="flex flex-wrap items-center gap-3 border border-border bg-background p-3">
            <div className="min-w-0 flex-1">
              <Link href={`/gaps/${gap.id}`} className="text-[13px] text-foreground no-underline hover:underline">
                {gap.name}
              </Link>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                Excluded
                {gap.exclusion_reason ? `: ${EXCLUSION_LABELS[gap.exclusion_reason as ExclusionReason] ?? gap.exclusion_reason}` : ""}
                {gap.status_lock.actor_name ? ` · by ${gap.status_lock.actor_name}` : ""}
                {gap.status_lock.note ? ` · “${gap.status_lock.note}”` : ""}
              </p>
            </div>
            <RestoreGapButton gapId={gap.id} />
          </li>
        ))}
        {parked.map((gap) => (
          <li key={gap.id} className="flex flex-wrap items-center gap-3 border border-border bg-background p-3">
            <div className="min-w-0 flex-1">
              <Link href={`/gaps/${gap.id}`} className="text-[13px] text-foreground no-underline hover:underline">
                {gap.name}
              </Link>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                Parked{gap.parked_reason ? `: ${gap.parked_reason}` : ""}
              </p>
            </div>
            <UnparkGapButton gapId={gap.id} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Tactics a person rejected: out of the library, but listed here with their way back. */
export function RejectedTactics({ tactics }: { tactics: IegpState["tactics"] }) {
  const rejected = tactics.filter((tactic) => tactic.review_status === "rejected");
  if (rejected.length === 0) return null;
  return (
    <section
      aria-labelledby="rejected-tactics"
      data-testid="rejected-tactics"
      className="mt-8 border border-border bg-card/40 p-4"
    >
      <h2 id="rejected-tactics" className="text-[13px] font-medium text-foreground">
        Rejected tactics ({rejected.length})
      </h2>
      <p className="mt-0.5 mb-3 text-[12px] text-muted-foreground">
        Out of the library and the timeline. Restore one to map it onto gaps again.
      </p>
      <ul className="grid gap-2">
        {rejected.map((tactic) => (
          <li key={tactic.id} className="flex flex-wrap items-center gap-3 border border-border bg-background p-3">
            <div className="min-w-0 flex-1">
              <Link href={`/tactics/${tactic.id}`} className="text-[13px] text-foreground no-underline hover:underline">
                {tactic.name}
              </Link>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                Rejected
                {tactic.lock.actor_name ? ` by ${tactic.lock.actor_name}` : ""}
                {tactic.lock.note ? ` · “${tactic.lock.note}”` : ""}
              </p>
            </div>
            <RestoreTacticButton tacticId={tactic.id} />
          </li>
        ))}
      </ul>
    </section>
  );
}

export type RejectedMappingRow = {
  gap_id: string;
  tactic_id: string;
  gap_name: string;
  tactic_name: string;
  note: string | null;
  actor_name: string | null;
};

/**
 * Every gap ↔ tactic pair a person rejected or removed. A rejected pair is never
 * mapped by a later run, so it stays listed here rather than vanishing.
 */
export function RejectedMappings({ rows }: { rows: RejectedMappingRow[] }) {
  return (
    <section
      aria-labelledby="rejected-mappings"
      data-testid="rejected-mappings"
      className="mt-8 border border-border bg-card/40 p-4"
    >
      <h2 id="rejected-mappings" className="text-[13px] font-medium text-foreground">
        Rejected mappings ({rows.length})
      </h2>
      <p className="mt-0.5 mb-3 text-[12px] text-muted-foreground">
        Pairs you or a colleague rejected or removed. They are never mapped again unless you restore them.
      </p>
      {rows.length === 0 ? (
        <p className="text-[12px] text-muted-foreground">None.</p>
      ) : (
        <ul className="grid gap-2">
          {rows.map((row) => (
            <li
              key={`${row.gap_id}::${row.tactic_id}`}
              className="flex flex-wrap items-center gap-3 border border-border bg-background p-3"
            >
              <div className="min-w-0 flex-1">
                <p className="text-[13px] text-foreground">
                  <Link href={`/tactics/${row.tactic_id}`} className="text-foreground no-underline hover:underline">
                    {row.tactic_name}
                  </Link>{" "}
                  ↛{" "}
                  <Link href={`/gaps/${row.gap_id}`} className="text-foreground no-underline hover:underline">
                    {row.gap_name}
                  </Link>
                </p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  Rejected{row.actor_name ? ` by ${row.actor_name}` : ""}
                  {row.note ? ` · “${row.note}”` : ""}
                </p>
              </div>
              <RestoreMappingButton gapId={row.gap_id} tacticId={row.tactic_id} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
