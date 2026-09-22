import type { IegpState } from "./types";

/** Asset and company context gathered in the product setup wizard. */
export type PlanningContext = {
  asset_name: string;
  inn: string;
  indication: string;
  geography: string;
  lifecycle_stage: string;
  launch_timeline: string;
  competitor_positioning: string;
  key_decision: string;
  decision_date: string;
  company_situation: string;
  strategic_importance: number;
};

export const EMPTY_PLANNING_CONTEXT: PlanningContext = {
  asset_name: "",
  inn: "",
  indication: "",
  geography: "",
  lifecycle_stage: "peri-launch",
  launch_timeline: "",
  competitor_positioning: "",
  key_decision: "",
  decision_date: "",
  company_situation: "",
  strategic_importance: 3,
};

export function parsePlanningContext(raw: unknown): PlanningContext {
  if (!raw || typeof raw !== "object") return { ...EMPTY_PLANNING_CONTEXT };
  const row = raw as Record<string, unknown>;
  const importance = Number(row.strategic_importance);
  return {
    asset_name: String(row.asset_name ?? ""),
    inn: String(row.inn ?? ""),
    indication: String(row.indication ?? ""),
    geography: String(row.geography ?? ""),
    lifecycle_stage: String(row.lifecycle_stage ?? "peri-launch"),
    launch_timeline: String(row.launch_timeline ?? ""),
    competitor_positioning: String(row.competitor_positioning ?? ""),
    key_decision: String(row.key_decision ?? ""),
    decision_date: String(row.decision_date ?? ""),
    company_situation: String(row.company_situation ?? ""),
    strategic_importance:
      Number.isFinite(importance) && importance >= 1 && importance <= 5 ? importance : 3,
  };
}

/** Context block passed into the S8 prioritization LLM (merged with per-run overrides). */
export function prioritizationContextFromState(state: IegpState) {
  const planning = parsePlanningContext(state.asset.planning_context);
  const objective = state.objectives[0];
  return {
    key_decision: planning.key_decision || objective?.key_decision || undefined,
    decision_date: planning.decision_date || objective?.decision_date || undefined,
    competitor_pressure: planning.competitor_positioning || undefined,
    launch_timeline: planning.launch_timeline || undefined,
    company_situation: planning.company_situation || undefined,
    lifecycle_stage: planning.lifecycle_stage || objective?.lifecycle_stage || undefined,
    strategic_importance: planning.strategic_importance || objective?.strategic_importance,
  };
}
