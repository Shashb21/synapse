/** Production-safe recall helper; it accepts explicit targets and imports no gold pack. */
import { scoreRecallAgainstTargets } from "./pack-recall";

export function scoreGapIdRecall(args: { targets: string[]; extractedExternalIds: (string | null | undefined)[] }): { found: string[]; missing: string[]; recall: number } {
  const slice = scoreRecallAgainstTargets({ gap_ids: args.targets, tactic_numbers: [], tactic_identifiers: [] }, { gap_ids: args.extractedExternalIds }).gap_ids;
  return { found: slice.found, missing: slice.missing, recall: slice.recall };
}
