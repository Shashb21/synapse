import type { ActionIdentity } from "@/components/platform/action-dialog";
import type { ProposalCardModel } from "@/components/ideation/proposal-card";
import type { OpenGapCard } from "@/lib/iegp/engine";
import { loadState } from "@/lib/iegp/store";
import type { TacticEditModel } from "@/components/tactic-ideation/tactic-panel";
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
  /** Each library tactic's editable fields, for the side panel (KAN-50). */
  tactics: Record<string, TacticEditModel>;
};

export async function loadTacticIdeation(openGaps: OpenGapCard[]): Promise<TacticIdeationData> {
  const [placements, proposals, session, state] = await Promise.all([
    listPlacements(),
    listIdeationProposals(),
    sessionContext(),
    loadState(),
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
    tactics: Object.fromEntries(
      state.tactics.map((tactic): [string, TacticEditModel] => [
        tactic.id,
        {
          id: tactic.id,
          name: tactic.name,
          type: tactic.type,
          custom_type: tactic.custom_type ?? null,
          status: tactic.status,
          evidence_question: tactic.evidence_question,
          start_date: tactic.start_date,
          evidence_available: tactic.evidence_available,
          budget: tactic.budget,
          owner: tactic.owner,
          function: tactic.function,
        },
      ]),
    ),
  };
}
