import { db } from "@/lib/iegp/db";
import { nowIso } from "@/modules/kernel/ids";
import { priorityPlacements } from "@/modules/kernel/schema";
import type { Actor } from "@/modules/kernel/contracts";
import {
  addTimelineActivity,
  createTimelineActivity,
  setTimelineDependencies,
} from "@/modules/stages/s10-timeline/module";

/**
 * The Velmara demo's prioritized plan: validated bands and a dated timeline,
 * so a demo workspace opens with Prioritize, Tactics and Timeline populated.
 * These historical bands are fixture rows loaded with the demo inventory,
 * which intentionally includes unresolved gaps for visitors to review.
 */
const DEMO_ACTOR: Actor = { name: "Synapse demo data", function: "medical_affairs" };
const WHY = "Velmara demo plan";

export const DEMO_BANDS = [
  { gap_id: "GAP-PERSIST", band: "high" },
  { gap_id: "GAP-CNS", band: "high" },
  { gap_id: "GAP-IRA", band: "medium" },
  { gap_id: "GAP-CAREGIVER", band: "low" },
] as const;

/** Loads the fixed fixture after the workspace's previous module rows are cleared. */
export async function loadDemoPlan(workspaceId?: string): Promise<void> {
  const common = { rationale: WHY, actor: DEMO_ACTOR, workspace_id: workspaceId };
  const at = nowIso();
  await db().insert(priorityPlacements).values(DEMO_BANDS.map(({ gap_id, band }) => ({
    gap_id,
    axis_scores: {},
    suggested_band: band,
    suggested_rationale: "",
    band,
    validated: true,
    human_band: true,
    rationale: WHY,
    actor_name: DEMO_ACTOR.name,
    actor_function: DEMO_ACTOR.function,
    at,
  })));
  // Mapped tactics, dated from their start to when evidence is available.
  const claims = await addTimelineActivity({
    tactic_id: "TAC-CLAIMS",
    start_date: "2026-11-01",
    end_date: "2027-04-01",
    ...common,
  });
  const bim = await addTimelineActivity({
    tactic_id: "TAC-BIM",
    start_date: "2027-04-15",
    end_date: "2027-07-31",
    ...common,
  });
  // The budget-impact model uses the claims persistence estimates.
  await setTimelineDependencies({ id: bim.id, depends_on: [claims.id], ...common });
  await createTimelineActivity({
    gap_id: "GAP-CNS",
    name: "CNS sub-study of VEL-301 brain-metastasis patients",
    type: "secondary_analysis",
    evidence_question: "What are intracranial response and duration in patients with brain metastases?",
    start_date: "2027-01-15",
    end_date: "2027-09-30",
    ...common,
  });
  // GAP-CAREGIVER is left unscheduled on purpose, to show the Unscheduled state.
}
