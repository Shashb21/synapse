import Link from "next/link";
import { StepWaiting } from "@/components/step-waiting";
import type { ActionIdentity } from "@/components/platform/action-dialog";
import type { ProposalCardModel } from "@/components/ideation/proposal-card";
import { IdeationBoard } from "@/components/tactic-ideation/ideation-board";
import type { OpenGapCard, TacticLibraryItem } from "@/lib/iegp/engine";

const NO_IDENTITY: ActionIdentity = { signed_in: false, actor_name: "", actor_function: "medical_affairs" };

/**
 * Tactic Ideation (KAN-8, from the Figma design). Ideate proposed tactics here after Prioritize:
 * only the Open gaps validated as High are listed. Medium and Low gaps get their tactics mapped
 * on Evidence Inventory.
 */
export function TacticsPlace({
  ready,
  highGaps,
  otherCount = 0,
  availableTactics,
  proposals = [],
  identity = NO_IDENTITY,
  mayIdeate = false,
}: {
  /** False until Prioritize is finished. The place still shows; the banner says what it waits on. */
  ready: boolean;
  highGaps: OpenGapCard[];
  otherCount?: number;
  availableTactics: TacticLibraryItem[];
  proposals?: ProposalCardModel[];
  identity?: ActionIdentity;
  mayIdeate?: boolean;
}) {
  return (
    <div className="grid gap-4">
      {!ready ? (
        <StepWaiting
          title="Waiting on Prioritize"
          body="Tactic Ideation lists the Open gaps validated as High on the Prioritization Matrix. Finish Prioritize and choose Continue to tactics; until then there is little to ideate here, but you can look through the tactic library below."
          href="/?place=plan"
          cta="Go to Prioritize"
        />
      ) : null}
      <IdeationBoard
        gaps={highGaps}
        proposals={proposals}
        library={availableTactics}
        identity={identity}
        mayIdeate={mayIdeate}
      />
      <p className="text-[11px] text-muted-foreground">
        {otherCount > 0
          ? `${otherCount} other Open gap${otherCount === 1 ? " is" : "s are"} Medium, Low or not validated yet; map tactics to them on `
          : "Medium and Low gaps get their tactics mapped on "}
        <Link href="/?place=gaps" className="text-foreground">
          Evidence Inventory
        </Link>
        . Every idea decision is on{" "}
        <Link href="/ideation" className="text-foreground">
          the ideation review
        </Link>
        .
      </p>
    </div>
  );
}
