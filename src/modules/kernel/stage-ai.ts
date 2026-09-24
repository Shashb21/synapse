import { STAGES, type StageId } from "./contracts";

/**
 * Stages whose module only exists to call a model (every agentic stage except
 * the timeline, which lays out human dates without AI) plus upload and parse,
 * which the owner switched off with AI. The kernel refuses these while AI is off.
 * Plain module, so both server pages and client components can call it.
 */
export function stageNeedsAi(stage: string): boolean {
  if (stage === "S0" || stage === "S1") return true;
  if (stage === "S10") return false;
  return STAGES[stage as StageId]?.kind === "agentic";
}
