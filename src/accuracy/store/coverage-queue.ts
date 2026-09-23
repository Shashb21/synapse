import type { AccuracyClaimRow } from "./claim-store";
import { claimMetadata } from "./claim-store";
import type { CoveragePair } from "./coverage-store";

export type CoverageQueuePair = CoveragePair;

export type CoverageQueueSnapshot = {
  undecided: CoverageQueuePair[];
  decided: CoverageQueuePair[];
  /** First undecided pair, or null when the queue is empty. */
  current: CoverageQueuePair | null;
  undecided_count: number;
  decided_count: number;
  total_count: number;
};

/** Split pairs into undecided-first queue (one decision at a time). */
export function buildCoverageQueue(pairs: CoverageQueuePair[]): CoverageQueueSnapshot {
  const undecided = pairs.filter((p) => !p.validated);
  const decided = pairs.filter((p) => p.validated);
  return {
    undecided,
    decided,
    current: undecided[0] ?? null,
    undecided_count: undecided.length,
    decided_count: decided.length,
    total_count: pairs.length,
  };
}

/**
 * Collect parse block ids from gap + tactic provenance for coverage_decide evidence.
 * Falls back to empty when claims lack provenance (module still runs stub/LLM with labels).
 */
export function blockBundleIdsForPair(gap: AccuracyClaimRow, tactic: AccuracyClaimRow): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const claim of [gap, tactic]) {
    const meta = claimMetadata(claim);
    const provenance = Array.isArray(meta.provenance) ? meta.provenance : [];
    for (const span of provenance) {
      if (!span || typeof span !== "object") continue;
      const blockId = (span as { block_id?: unknown }).block_id;
      if (typeof blockId !== "string" || !blockId.trim()) continue;
      if (seen.has(blockId)) continue;
      seen.add(blockId);
      ids.push(blockId);
    }
  }
  return ids;
}
