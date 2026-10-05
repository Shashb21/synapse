import type { IegpState } from "./types";

/** One overlap suggestion, as the Gaps place shows it (KAN-75). */
export type GapSuggestionCard = {
  id: string;
  gap_id: string;
  gap_number: number;
  gap_name: string;
  gap_statement: string;
  source_title: string;
  source_quote: string;
  /** Other sources in the same run that said the same thing. */
  extra_source_count: number;
  shared_part: string;
  new_part: string;
  merged_name: string;
  merged_statement: string;
  split_name: string;
  split_statement: string;
};

/**
 * Pending overlap suggestions, oldest first, with the gap they are about. A
 * suggestion whose gap was since retired (split or rewritten) still shows, so a
 * person can reject it; deciding it otherwise tells them why it cannot go ahead.
 */
export function pendingSuggestionCards(state: IegpState): GapSuggestionCard[] {
  return state.gap_suggestions
    .filter((row) => row.status === "pending")
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .flatMap((row) => {
      const gap = state.gaps.find((candidate) => candidate.id === row.gap_id);
      if (!gap) return [];
      const source = state.sources.find((candidate) => candidate.id === row.source_id);
      return [
        {
          id: row.id,
          gap_id: gap.id,
          gap_number: gap.number,
          gap_name: gap.name,
          gap_statement: gap.statement,
          source_title: source?.title ?? row.source_id,
          source_quote: row.source_quote,
          extra_source_count: row.extra_sources.length,
          shared_part: row.shared_part,
          new_part: row.new_part,
          merged_name: row.merged_name,
          merged_statement: row.merged_statement,
          split_name: row.split_name,
          split_statement: row.split_statement,
        },
      ];
    });
}
