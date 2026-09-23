import Link from "next/link";
import { OpenGapsQueue, TacticLibrary } from "@/components/plan-cards";
import { planColumn, type OpenGapCard, type PlanColumn, type TacticLibraryItem } from "@/lib/iegp/engine";

const GROUPS: { id: PlanColumn; title: string }[] = [
  { id: "high", title: "High" },
  { id: "medium", title: "Medium" },
  { id: "low", title: "Low" },
];

export function TacticsPlace({
  unlocked,
  openGaps,
  availableTactics,
}: {
  unlocked: boolean;
  openGaps: OpenGapCard[];
  availableTactics: TacticLibraryItem[];
}) {
  if (!unlocked) {
    return (
      <section className="border border-border bg-card/40 p-4">
        <h2 className="text-[15px] font-medium text-foreground">Tactics is locked</h2>
        <p className="mt-1 text-[12px] text-muted-foreground">
          Validate gaps, then prioritize Open gaps. Tactics is the next stage.
        </p>
      </section>
    );
  }
  const open = openGaps.filter((c) => c.gap_status === "validated_open");
  const unbanded = open.filter((c) => !c.band);
  return (
    <div className="grid gap-10">
      <section>
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-[15px] font-medium">Open gaps</h2>
          <Link href="/ideation" className="text-[12px] text-muted-foreground no-underline hover:underline">
            Open ideation →
          </Link>
        </div>
        <p className="mb-4 text-[12px] text-muted-foreground">
          Ideate proposed tactics here after Prioritize. Assign a library tactic onto an Open gap,
          or create a new proposed one. Mapping existing inventory and recording missed studies
          happens on Gaps. Grouped by priority — High first.
        </p>
        <div className="grid gap-6">
          {GROUPS.map((group) => {
            const cards = open.filter((c) => c.band && planColumn(c.band) === group.id);
            if (cards.length === 0) return null;
            return (
              <div key={group.id}>
                <h3 className="mb-2 text-[13px] font-medium text-foreground">
                  {group.title} <span className="font-normal text-muted-foreground">({cards.length})</span>
                </h3>
                <OpenGapsQueue cards={cards} availableTactics={availableTactics} />
              </div>
            );
          })}
          {unbanded.length > 0 ? (
            <div>
              <h3 className="mb-2 text-[13px] font-medium text-foreground">
                Not yet banded <span className="font-normal text-muted-foreground">({unbanded.length})</span>
              </h3>
              <OpenGapsQueue cards={unbanded} availableTactics={availableTactics} />
            </div>
          ) : null}
          {open.length === 0 ? (
            <p className="text-[12px] text-muted-foreground">
              Prioritize Open gaps first, then assign tactics here.
            </p>
          ) : null}
        </div>
      </section>
      <TacticLibrary items={availableTactics} />
    </div>
  );
}
