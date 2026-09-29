import type { ActionIdentity } from "@/components/platform/action-dialog";
import type { ProposalCardModel } from "@/components/ideation/proposal-card";
import type { OpenGapCard } from "@/lib/iegp/engine";
import { can } from "@/modules/auth/roles";
import { sessionContext } from "@/modules/auth/session";
import { listPlacements } from "@/modules/stages/s8-prioritization/module";
import { listIdeationProposals } from "@/modules/stages/s9-ideation/module";

export type TacticIdeationData = {
  /** Open gaps a person validated as High on the matrix: the only ones Tactic Ideation lists. */
  highGaps: OpenGapCard[];
  /** Open gaps left out: validated Medium or Low, or not validated yet. Defer is out of this cycle. */
  otherCount: number;
  proposals: ProposalCardModel[];
  identity: ActionIdentity;
  mayIdeate: boolean;
};

export async function loadTacticIdeation(openGaps: OpenGapCard[]): Promise<TacticIdeationData> {
  const [placements, proposals, session] = await Promise.all([
    listPlacements(),
    listIdeationProposals(),
    sessionContext(),
  ]);
  const byGap = new Map(placements.map((row) => [row.gap_id, row]));
  const highGaps: OpenGapCard[] = [];
  let otherCount = 0;
  for (const card of openGaps) {
    if (card.gap_status !== "validated_open") continue;
    const placement = byGap.get(card.gap_id);
    const band = placement?.validated ? placement.band : null;
    if (band === "high") highGaps.push({ ...card, band: "high" });
    else if (band !== "defer") otherCount += 1;
  }
  return {
    highGaps,
    otherCount,
    proposals: proposals.map((proposal): ProposalCardModel => ({ ...proposal })),
    identity: {
      signed_in: session.signed_in,
      actor_name: session.actor.name,
      actor_function: session.actor.function,
    },
    mayIdeate: can(session.role, "ideate"),
  };
}
