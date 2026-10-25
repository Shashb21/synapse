/** Read current ideation eligibility and retained mapped work without changing assessments. */
import { buildIdeationGapBrief, type IdeationGapBrief } from "@/modules/stages/s9-ideation/context";
import type { IdeationGapOutcome } from "@/modules/stages/s9-ideation/recommendation-contract";
import type { AcceptedContext } from "@/components/ideation/evidence-context";
import { tacticEditVersion } from "@/lib/iegp/tactic-edit-version";
import type { ActionIdentity } from "@/components/platform/action-dialog";
import type { ProposalCardModel } from "@/components/ideation/proposal-card";
import { displayedGapStatus, mappedTactics, type OpenGapCard, type PlanTactic } from "@/lib/iegp/engine";
import { loadState } from "@/lib/iegp/store";
import type { TacticEditModel } from "@/components/tactic-ideation/tactic-panel";
import { can } from "@/modules/auth/roles";
import { sessionContext } from "@/modules/auth/session";
import { listPlacements } from "@/modules/stages/s8-prioritization/module";
import { acceptedIdeationContexts, listIdeationGapOutcomes, ideationBandOrder, listIdeationProposals } from "@/modules/stages/s9-ideation/module";

/** Read-only discovery; actions keep using the shared record's responsible editors. */
export type RetainedTacticGap = {
  gap_id: string;
  gap_name: string;
  number: number;
  domain: OpenGapCard["domain"];
  gap_status: OpenGapCard["gap_status"];
  band: OpenGapCard["band"];
  needs_review: boolean;
  priority_confirmed: boolean;
  tactics: PlanTactic[];
  tactic_count: number;
  option_count: number;
};

export type TacticIdeationData = {
  /** Current High/Open eligibility. Existing work is listed separately. */
  highGaps: OpenGapCard[];
  briefs: Record<string, IdeationGapBrief>;
  outcomes: IdeationGapOutcome[];
  acceptedContexts: AcceptedContext[];
  retainedGaps: RetainedTacticGap[];
  /** Open gaps left out: validated Medium or Low, or not validated yet. Defer is out of this cycle. */
  otherCount: number;
  proposals: ProposalCardModel[];
  identity: ActionIdentity;
  mayIdeate: boolean;
  /** Each library tactic's editable fields, for the side panel (KAN-50). */
  tactics: Record<string, TacticEditModel>;
};

/** Load current eligibility and retained relationship facts from their existing sources. */
export async function loadTacticIdeation(openGaps: OpenGapCard[]): Promise<TacticIdeationData> {
  const [placements, proposals, session, state, outcomes] = await Promise.all([
    listPlacements(),
    listIdeationProposals(),
    sessionContext(),
    loadState(),
    listIdeationGapOutcomes(),
  ]);
  const byGap = new Map(placements.map((row) => [row.gap_id, row]));
  const eligibleBands = ideationBandOrder(placements);
  const highGaps: OpenGapCard[] = [];
  let otherCount = 0;
  for (const card of openGaps) {
    if (card.gap_status !== "validated_open") continue;
    const placement = byGap.get(card.gap_id);
    const band = placement?.validated ? placement.band : null;
    if (eligibleBands.has(card.gap_id)) highGaps.push({ ...card, band: "high" });
    else if (band !== "defer") otherCount += 1;
  }
  const eligibleIds = new Set(highGaps.map(gap => gap.gap_id));
  const retainedGaps = state.gaps.flatMap(gap => {
    if (eligibleIds.has(gap.id)) return [];
    const option_count = proposals.filter(proposal => proposal.gap_id === gap.id).length;
    const tactics = mappedTactics(state, gap.id);
    const tactic_count = tactics.length;
    if (!option_count && !tactic_count) return [];
    const priority = byGap.get(gap.id);
    return [{ gap_id: gap.id, gap_name: gap.name, number: gap.number, domain: gap.domain,
      gap_status: displayedGapStatus(gap), band: priority?.band ?? null,
      needs_review: priority?.needs_review ?? false, priority_confirmed: priority?.validated ?? false,
      tactics, tactic_count, option_count }];
  });
  return {
    highGaps,
    briefs: Object.fromEntries(highGaps.map(gap => [gap.gap_id, buildIdeationGapBrief(state, gap.gap_id, placements)])),
    outcomes,
    acceptedContexts: acceptedIdeationContexts(proposals),
    retainedGaps,
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
          version: tacticEditVersion(tactic),
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
