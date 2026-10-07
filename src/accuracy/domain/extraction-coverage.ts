/** Shared applicability of accepted page-kind coverage for publication and omission currency. */
import type { SourcePageInput, SourceProgress } from "./source-pages";

export type SourceCoverageUnit = SourcePageInput["units"][number];
export type SourceCoverageBatch = {
  id: string; workspace_id: string; source_file_id: string; created_at: string;
  requested_kinds: string[]; drafts_persisted: boolean; source_progress: SourceProgress | null;
  legacy_block_ids?: string[];
};

/** Legacy applied batches represent whole-source coverage; paged batches expose only successful units. */
export function successfulSourceUnits(batch: SourceCoverageBatch, kind: string): SourceCoverageUnit[] | null {
  if (!batch.drafts_persisted || !batch.requested_kinds.includes(kind)) return [];
  return batch.source_progress ? batch.source_progress.pages.flatMap(page => page.attempts[kind]?.state === "successful" ? page.units : [])
    : batch.legacy_block_ids?.map(block_id => ({ block_id, char_start: 0, char_end: Infinity })) ?? null;
}

/** Creation order is server-owned; source/workspace and extractor kind are independent scopes. */
export function isNewerSourceCoverage(older: SourceCoverageBatch, newer: SourceCoverageBatch, kind: string): boolean {
  return older.workspace_id === newer.workspace_id && older.source_file_id === newer.source_file_id
    && newer.requested_kinds.includes(kind) && newer.drafts_persisted
    && (newer.created_at > older.created_at || (newer.created_at === older.created_at && newer.id > older.id));
}

/** Half-open original UTF-16 intervals, including a zero-width empty source block. */
export function sourceUnitsOverlap(left: SourceCoverageUnit[], right: SourceCoverageUnit[]): boolean {
  return left.some(a => right.some(b => a.block_id === b.block_id && (Math.max(a.char_start, b.char_start) < Math.min(a.char_end, b.char_end)
    || (a.char_start === a.char_end && b.char_start === b.char_end && a.char_start === b.char_start))));
}

/** Coverage may span several successful pages; gaps and unsuccessful slices never count. */
export function sourceUnitsCover(coverage: SourceCoverageUnit[], targets: SourceCoverageUnit[]): boolean {
  return targets.every(target => {
    const ranges = coverage.filter(unit => unit.block_id === target.block_id).sort((a, b) => a.char_start - b.char_start);
    if (target.char_start === target.char_end) return ranges.some(unit => unit.char_start <= target.char_start && unit.char_end >= target.char_end);
    let end = target.char_start;
    for (const range of ranges) {
      if (range.char_start > end) break;
      end = Math.max(end, range.char_end);
      if (end >= target.char_end) return true;
    }
    return false;
  });
}

/** Cross-revision offsets are incomparable: only a fully inspected original block can replace them.
 * Legacy whole-source batches retain their former whole-source semantics.
 */
export function newerSourceCoverageCovers(older: SourceCoverageBatch, newer: SourceCoverageBatch, kind: string, targets: SourceCoverageUnit[]): boolean {
  if (!isNewerSourceCoverage(older, newer, kind)) return false;
  const coverage = successfulSourceUnits(newer, kind);
  if (coverage === null) return true;
  if (!newer.source_progress) return sourceUnitsCover(coverage, targets);
  if (older.source_progress && newer.source_progress?.source_revision === older.source_progress.source_revision) return sourceUnitsCover(coverage, targets);
  const declared = newer.source_progress?.pages.flatMap(page => page.units) ?? [];
  return targets.every(target => {
    const block = declared.filter(unit => unit.block_id === target.block_id);
    return block.length > 0 && sourceUnitsCover(coverage, block);
  });
}

/** Publication fences any newer successful overlap at the same source revision before writes. */
export function newerSourceCoverageOverlaps(older: SourceCoverageBatch, newer: SourceCoverageBatch, kind: string, targets: SourceCoverageUnit[]): boolean {
  if (!isNewerSourceCoverage(older, newer, kind)) return false;
  if (older.source_progress && newer.source_progress && older.source_progress.source_revision !== newer.source_progress.source_revision) return false;
  const coverage = successfulSourceUnits(newer, kind);
  return coverage === null || sourceUnitsOverlap(coverage, targets);
}
