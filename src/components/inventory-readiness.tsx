import { reviewGapTasks, type ReviewGapCard } from "@/lib/iegp/engine";

/** Human review work is separate from evidence status and downstream eligibility. */
export function InventoryReadiness({ cards, readyForPrioritize }: {
  cards: ReviewGapCard[];
  readyForPrioritize: boolean;
}) {
  const attention = cards.filter(card => reviewGapTasks(card).length > 0).length;
  const unconfirmed = cards.filter(card => !card.human_validated).length;
  const partial = cards.filter(card => card.gap_status === "validated_partial").length;
  const mappings = cards.filter(card => card.needs_review || card.tactics.some(tactic => tactic.needs_review)).length;
  const sources = cards.filter(card => card.new_source).length;
  return (
    <section aria-label="Inventory review readiness" className="rounded-lg border border-border bg-card p-4" aria-live="polite">
      <h2 className="text-[13px] font-semibold">Inventory review readiness</h2>
      <p className="mt-1 text-[12px] text-muted-foreground">
        {cards.length ? `${cards.length} live gaps · ${attention} gaps needing attention` : "No live gaps yet."}
      </p>
      {cards.length > 0 ? <p className="mt-1 text-[12px] text-muted-foreground">
        {`${unconfirmed} gaps with unconfirmed status · ${partial} partial gaps to resolve · ${mappings} gaps needing tactic mapping review · ${sources} gaps needing new source review`}
      </p> : null}
      <p className="mt-1 text-[12px] text-muted-foreground">
        {attention ? "Inventory review work remains. " : cards.length ? "Inventory review is complete. " : "Add gaps to begin review. "}
        {readyForPrioritize ? "Gap assessments are ready for prioritization. " : "Confirm gap assessments and resolve partial gaps before completing initial preparation. "}
        Previously unlocked stages remain available for eligible work. Human review does not mean evidence gaps are addressed.
      </p>
    </section>
  );
}
