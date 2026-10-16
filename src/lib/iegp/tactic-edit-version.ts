import type { Tactic } from "./types";

/** An opening snapshot for a tactic edit; revalidation must never replace a draft's token. */
export function tacticEditVersion(tactic: Tactic): string {
  return JSON.stringify([
    tactic.name, tactic.type, tactic.custom_type ?? null, tactic.status, tactic.review_status,
    tactic.evidence_question, tactic.population, tactic.intervention, tactic.comparator,
    tactic.outcomes, tactic.study_design, tactic.data_source, tactic.geography,
    tactic.start_date, tactic.evidence_available, tactic.budget, tactic.owner, tactic.function, tactic.lock,
  ]);
}
