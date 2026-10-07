import type { Actor } from "@/modules/kernel/contracts";
import { validatePlacement } from "@/modules/stages/s8-prioritization/module";
import {
  addTimelineActivity,
  createTimelineActivity,
  setTimelineDependencies,
} from "@/modules/stages/s10-timeline/module";

/**
 * The Velmara demo's prioritized plan: validated bands and a dated timeline,
 * so a demo workspace opens with Prioritize, Tactics and Timeline populated.
 * This is fixture data for the demo only, written through the same S8/S10
 * edit paths a person uses; nothing here runs for a real workspace.
 */
const DEMO_ACTOR: Actor = { name: "Synapse demo data", function: "medical_affairs" };
const WHY = "Velmara demo plan";

export const DEMO_BANDS = [
  { gap_id: "GAP-PERSIST", band: "high" },
  { gap_id: "GAP-CNS", band: "high" },
  { gap_id: "GAP-IRA", band: "medium" },
  { gap_id: "GAP-CAREGIVER", band: "low" },
] as const;

export async function loadDemoPlan(workspaceId?: string): Promise<void> {
  const common = { rationale: WHY, actor: DEMO_ACTOR, workspace_id: workspaceId };
  for (const { gap_id, band } of DEMO_BANDS) {
    await validatePlacement({ gap_id, band, ...common });
  }
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
