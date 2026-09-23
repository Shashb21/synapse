export type ExtractCandidates = {
  gap_ids?: Array<string | null | undefined>;
  tactic_numbers?: Array<number | null | undefined>;
  tactic_identifiers?: Array<string | null | undefined>;
};

export type IdRecallSlice = {
  targets: number;
  found: string[];
  missing: string[];
  recall: number;
};

export type NumberRecallSlice = {
  targets: number;
  found: number[];
  missing: number[];
  recall: number;
};

export type PackRecallTargets = {
  gap_ids: string[];
  tactic_numbers: number[];
  tactic_identifiers: string[];
};

export type PackRecallScore = {
  gap_ids: IdRecallSlice;
  tactic_numbers: NumberRecallSlice;
  tactic_identifiers: IdRecallSlice;
  /** Micro-average over target sets that have at least one must_find row. */
  overall_recall: number;
};

function normalizeIds(values: Array<string | null | undefined> | undefined): Set<string> {
  const out = new Set<string>();
  for (const value of values ?? []) {
    const trimmed = value?.trim();
    if (trimmed) out.add(trimmed);
  }
  return out;
}

function normalizeNumbers(values: Array<number | null | undefined> | undefined): Set<number> {
  const out = new Set<number>();
  for (const value of values ?? []) {
    if (typeof value === "number" && Number.isFinite(value)) out.add(value);
  }
  return out;
}

function scoreIdTargets(targets: string[], foundSet: Set<string>): IdRecallSlice {
  const found = targets.filter((id) => foundSet.has(id));
  const missing = targets.filter((id) => !foundSet.has(id));
  const recall = targets.length === 0 ? 1 : found.length / targets.length;
  return { targets: targets.length, found, missing, recall };
}

function scoreNumberTargets(targets: number[], foundSet: Set<number>): NumberRecallSlice {
  const found = targets.filter((n) => foundSet.has(n));
  const missing = targets.filter((n) => !foundSet.has(n));
  const recall = targets.length === 0 ? 1 : found.length / targets.length;
  return { targets: targets.length, found, missing, recall };
}

/**
 * Source-recall candidates from extracted tactics. Ideated tactics are excluded so
 * live ideation cannot pollute inventory must_find scoring.
 */
export function sourceRecallCandidatesFromTactics(
  tactics: Array<{
    origin?: string | null;
    number?: number | null;
    identifier?: string | null;
  }>,
): ExtractCandidates {
  const inventory = tactics.filter((tactic) => tactic.origin !== "ideated");
  return {
    tactic_numbers: inventory.map((tactic) => tactic.number),
    tactic_identifiers: inventory.map((tactic) => tactic.identifier),
  };
}

/** Pure recall scoring — pass must_find targets explicitly (packs never merged upstream). */
export function scoreRecallAgainstTargets(
  targets: PackRecallTargets,
  candidates: ExtractCandidates = {},
): PackRecallScore {
  const gap_ids = scoreIdTargets(targets.gap_ids, normalizeIds(candidates.gap_ids));
  const tactic_numbers = scoreNumberTargets(
    targets.tactic_numbers,
    normalizeNumbers(candidates.tactic_numbers),
  );
  const tactic_identifiers = scoreIdTargets(
    targets.tactic_identifiers,
    normalizeIds(candidates.tactic_identifiers),
  );

  const slices = [gap_ids, tactic_numbers, tactic_identifiers].filter((s) => s.targets > 0);
  const hit = slices.reduce((sum, s) => sum + s.found.length, 0);
  const total = slices.reduce((sum, s) => sum + s.targets, 0);
  const overall_recall = total === 0 ? 1 : hit / total;

  return { gap_ids, tactic_numbers, tactic_identifiers, overall_recall };
}
