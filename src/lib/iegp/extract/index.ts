export { normalizeExtractInput, packNormalizedSource } from "./normalize";
export { runGapExtractionLoop } from "./loop";
export { startGapExtraction } from "./orchestrate";
export { setGapExtractCompleter, assertGapExtractLlmReady, gapExtractLlmReady } from "./client";
export { runGapPromptHillclimb } from "./hillclimb";
export { recordHumanGapFeedback } from "./feedback";
export {
  getExtractRun,
  listExtractRuns,
  extractSettings,
  championPromptVersion,
  listGoldGaps,
  wipeExtractTables,
} from "./store";
export { GAP_EXTRACT_ROUNDS, GAP_EXTRACT_CAP } from "./contracts";
export { GAP_QUALITY_RULES, GAP_PROMPT_REGISTRY } from "./prompts";
