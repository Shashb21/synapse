/**
 * A tactic's two dates (KAN-68): when it starts and when its evidence is available.
 * Each is YYYY-MM or YYYY-MM-DD, or blank, and evidence can't arrive before the
 * start. Shared by the store (the rule) and the dialogs (the same check, earlier).
 */

export const TACTIC_DATE_LABELS = { start_date: "Start date", evidence_available: "Evidence available" } as const;
export type TacticDateField = keyof typeof TACTIC_DATE_LABELS;

export const TACTIC_DATE_ORDER_MESSAGE = "Evidence available must be on or after the start date.";

/** True for a real calendar month or day: 2026-02 and 2026-02-28, not 2026-13 or 2026-02-30. */
export function isTacticDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return false;
  if (match[3] === undefined) return true;
  const day = Number(match[3]);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day >= 1 && day <= daysInMonth;
}

/** Why a typed tactic date can't be saved, or null (blank is fine). */
export function tacticDateError(field: TacticDateField, value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  if (!trimmed || isTacticDate(trimmed)) return null;
  return `${TACTIC_DATE_LABELS[field]} must be a date (YYYY-MM-DD) or blank.`;
}

/**
 * Evidence before the start, or null. A month-only date covers its whole month, so
 * with one on either side only the months are compared (2027-06 is fine with 2027-06-15).
 */
export function tacticDateOrderError(
  start: string | null | undefined,
  evidence: string | null | undefined,
): string | null {
  const from = (start ?? "").trim();
  const to = (evidence ?? "").trim();
  if (!from || !to || !isTacticDate(from) || !isTacticDate(to)) return null;
  const monthOnly = from.length === 7 || to.length === 7;
  const a = monthOnly ? from.slice(0, 7) : from;
  const b = monthOnly ? to.slice(0, 7) : to;
  return b < a ? TACTIC_DATE_ORDER_MESSAGE : null;
}

/** The first problem with a tactic's two dates as typed, or null. */
export function tacticDatesError(start: string | null | undefined, evidence: string | null | undefined): string | null {
  return (
    tacticDateError("start_date", start) ??
    tacticDateError("evidence_available", evidence) ??
    tacticDateOrderError(start, evidence)
  );
}
