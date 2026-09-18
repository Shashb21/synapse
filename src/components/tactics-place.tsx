import { OpenGapsQueue, TacticLibrary } from "@/components/plan-cards";
import type { OpenGapCard, TacticLibraryItem } from "@/lib/iegp/engine";

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
  return (
    <div className="grid gap-10">
      <section>
        <h2 className="mb-2 text-[15px] font-medium">Open gaps</h2>
        <p className="mb-4 text-[12px] text-muted-foreground">
          Ideate proposed tactics here after Prioritize. Assign a library tactic onto an Open gap,
          or create a new proposed one. Mapping existing inventory and recording missed studies
          happens on Gaps.
        </p>
        <OpenGapsQueue
          cards={openGaps.filter((c) => c.gap_status === "validated_open")}
          availableTactics={availableTactics}
        />
      </section>
      <TacticLibrary items={availableTactics} />
    </div>
  );
}
