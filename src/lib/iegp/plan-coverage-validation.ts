import type { EvidenceGap, GapTacticCoverage, Lock, Tactic } from "./types";

/** Coverage facts only: validation/derived status writes never change these inputs. */
export function planGapRevision(gap: EvidenceGap): string {
  return JSON.stringify([1, gap.id, gap.name, gap.statement, gap.domain, gap.objective_id, gap.settings,
    gap.metadata.stakeholders, gap.metadata.geography, gap.metadata.regional_nuances, gap.metadata.notes]);
}
export function planTacticRevision(tactic: Tactic): string {
  return JSON.stringify([1, tactic.id, tactic.name, tactic.type, tactic.status, tactic.review_status,
    tactic.description, tactic.evidence_question, tactic.intended_use, tactic.lifecycle_stage, tactic.source_quote ?? "", tactic.population, tactic.intervention, tactic.comparator,
    tactic.outcomes, tactic.study_design, tactic.data_source, tactic.geography, tactic.start_date, tactic.evidence_available]);
}
export function currentPlanCoverageLock(lock: Lock, gap: EvidenceGap, tactic: Tactic): Lock {
  return { ...lock, gap_revision: planGapRevision(gap), tactic_revision: planTacticRevision(tactic) };
}
/** Read existing lock history without upgrading a legacy or stale human verdict. */
export function planCoverageFreshness(row: GapTacticCoverage, gap?: EvidenceGap, tactic?: Tactic): NonNullable<GapTacticCoverage["validation_freshness"]> {
  if (!gap || !tactic || row.stale || row.needs_review) return "stale";
  const lock = row.overall_lock;
  if (!lock.locked) return "unassessed";
  if (!lock.gap_revision || !lock.tactic_revision || !lock.actor_name?.trim() || !lock.actor_function || !lock.locked_at || !lock.note?.trim()) return "unknown";
  return lock.gap_revision === planGapRevision(gap) && lock.tactic_revision === planTacticRevision(tactic) ? "current" : "stale";
}
