import Link from "next/link";
import { reviewGapTasks, type GapPrioritizationReadiness, type PrioritizationBlocker, type ReviewGapCard } from "@/lib/iegp/engine";
import { plural } from "@/lib/plural";

/** Links each blocking evidence assessment to its gap record. */
export function PrioritizationBlockers({ blockers }: { blockers: PrioritizationBlocker[] }) {
  if (blockers.length === 0) return null;
  return (
    <div className="mt-2 text-[12px] text-muted-foreground">
      <p className="font-medium text-foreground">Prioritization is paused</p>
      <ul className="mt-1 list-disc space-y-1 pl-4">
        {blockers.map(blocker => (
          <li key={blocker.gapId ?? "empty"}>
            {blocker.gapId === null ? (
              <><Link className="underline" href="/?place=gaps">Evidence Inventory</Link>. {blocker.reason}</>
            ) : (
              <><Link className="underline" href={`/gaps/${blocker.gapId}`}>{blocker.gapName}</Link>. {blocker.reason}</>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Human review work is separate from evidence status and downstream eligibility. */
export function InventoryReadiness({ cards, readyForPrioritize, readiness }: {
  cards: ReviewGapCard[];
  readyForPrioritize: boolean;
  readiness?: GapPrioritizationReadiness;
}) {
  const liveCount = readiness?.liveCount ?? cards.length;
  // Candidate gaps need review but are omitted from workbench cards.
  const attention = cards.filter(card => reviewGapTasks(card).length > 0).length + liveCount - cards.length;
  const unconfirmed = cards.filter(card => !card.human_validated).length;
  const partial = cards.filter(card => card.gap_status === "validated_partial").length;
  const mappings = cards.filter(card => card.needs_review || card.tactics.some(tactic => tactic.needs_review)).length;
  const sources = cards.filter(card => card.new_source).length;
  return (
    <section aria-label="Inventory review readiness" className="rounded-lg border border-border bg-card p-4" aria-live="polite">
      <h2 className="text-[13px] font-semibold">Inventory review readiness</h2>
      <p className="mt-1 text-[12px] text-muted-foreground">
        {liveCount ? `${plural(liveCount, "live gap")} · ${attention} gaps needing attention` : "No live gaps yet."}
      </p>
      {cards.length > 0 ? <p className="mt-1 text-[12px] text-muted-foreground">
        {`${unconfirmed} gaps with unconfirmed evidence assessments · ${partial} partial gaps to resolve · ${mappings} gaps needing tactic mapping review · ${sources} gaps needing new source review`}
        {". Review categories can overlap; each gap counts once in gaps needing attention."}
      </p> : null}
      <p className="mt-1 text-[12px] text-muted-foreground">
        {attention ? "Inventory review work remains. " : liveCount ? "Inventory review is complete. " : "Add gaps to begin review. "}
        {readyForPrioritize ? "Gap assessments are ready for prioritization. " : null}
        Previously unlocked stages remain available for eligible work. Human review does not mean evidence gaps are addressed.
      </p>
      <PrioritizationBlockers blockers={readiness?.blockers ?? []} />
    </section>
  );
}
