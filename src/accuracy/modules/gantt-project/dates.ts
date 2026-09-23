/** ISO calendar day used by Gantt bars. */
export const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export type TacticTimingInput = {
  start?: string | null;
  end?: string | null;
  /** Loose timing label when discrete start/end are absent (e.g. "Q1 2027", "H2 2026"). */
  timing?: string | null;
};

export type ResolvedTacticDates = {
  start: string;
  end: string;
};

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function isoDay(year: number, month: number, day: number): string {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function quarterBounds(year: number, quarter: number): ResolvedTacticDates {
  const startMonth = (quarter - 1) * 3 + 1;
  const endMonth = startMonth + 2;
  return {
    start: isoDay(year, startMonth, 1),
    end: isoDay(year, endMonth, lastDayOfMonth(year, endMonth)),
  };
}

function halfBounds(year: number, half: 1 | 2): ResolvedTacticDates {
  if (half === 1) {
    return { start: isoDay(year, 1, 1), end: isoDay(year, 6, 30) };
  }
  return { start: isoDay(year, 7, 1), end: isoDay(year, 12, 31) };
}

/**
 * Expand a single timing token into a closed [start, end] ISO range.
 * Returns null when the token is not a recognized date/period.
 */
export function expandTimingToken(raw: string | null | undefined): ResolvedTacticDates | null {
  if (raw == null) return null;
  const text = raw.trim();
  if (!text) return null;

  if (ISO_DAY.test(text)) {
    return { start: text, end: text };
  }

  const yearMonth = /^(\d{4})-(\d{2})$/.exec(text);
  if (yearMonth) {
    const year = Number(yearMonth[1]);
    const month = Number(yearMonth[2]);
    if (month < 1 || month > 12) return null;
    return {
      start: isoDay(year, month, 1),
      end: isoDay(year, month, lastDayOfMonth(year, month)),
    };
  }

  const yearOnly = /^(\d{4})$/.exec(text);
  if (yearOnly) {
    const year = Number(yearOnly[1]);
    return { start: isoDay(year, 1, 1), end: isoDay(year, 12, 31) };
  }

  const qPrefixed = /^(?:Q([1-4])\s+(\d{4})|(\d{4})[- ]Q([1-4]))$/i.exec(text);
  if (qPrefixed) {
    const year = Number(qPrefixed[2] ?? qPrefixed[3]);
    const quarter = Number(qPrefixed[1] ?? qPrefixed[4]);
    return quarterBounds(year, quarter);
  }

  const hPrefixed = /^(?:H([12])\s+(\d{4})|(\d{4})[- ]H([12]))$/i.exec(text);
  if (hPrefixed) {
    const year = Number(hPrefixed[2] ?? hPrefixed[3]);
    const half = Number(hPrefixed[1] ?? hPrefixed[4]) as 1 | 2;
    return halfBounds(year, half);
  }

  return null;
}

/** Normalize a free-form value to an ISO day used as a range start. */
export function normalizeAsStart(raw: string | null | undefined): string | null {
  return expandTimingToken(raw)?.start ?? null;
}

/** Normalize a free-form value to an ISO day used as a range end. */
export function normalizeAsEnd(raw: string | null | undefined): string | null {
  return expandTimingToken(raw)?.end ?? null;
}

/**
 * Resolve start/end for Gantt projection from discrete fields and/or a timing label.
 * Does not invent dates — returns null when neither side can be resolved.
 */
export function resolveTacticDates(input: TacticTimingInput): ResolvedTacticDates | null {
  const startExplicit = input.start?.trim() ? normalizeAsStart(input.start) : null;
  const endExplicit = input.end?.trim() ? normalizeAsEnd(input.end) : null;

  if (startExplicit && endExplicit) {
    if (endExplicit < startExplicit) return null;
    return { start: startExplicit, end: endExplicit };
  }

  const fromTiming = expandTimingToken(input.timing);
  if (!fromTiming) {
    if (startExplicit || endExplicit) return null;
    return null;
  }

  const start = startExplicit ?? fromTiming.start;
  const end = endExplicit ?? fromTiming.end;
  if (end < start) return null;
  return { start, end };
}

/** Strict ISO day pair for write APIs (after user entry / coverage decide). */
export function requireIsoDateRange(start: string, end: string): ResolvedTacticDates {
  const s = start.trim();
  const e = end.trim();
  if (!ISO_DAY.test(s)) {
    throw new Error("start: expected YYYY-MM-DD");
  }
  if (!ISO_DAY.test(e)) {
    throw new Error("end: expected YYYY-MM-DD");
  }
  if (e < s) {
    throw new Error("An activity cannot end before it starts.");
  }
  return { start: s, end: e };
}
