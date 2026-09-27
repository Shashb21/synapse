/**
 * Client-side checks for typing a gap's axis scores by hand, so a bad value is
 * caught before anything is sent and the message names the axis a person sees.
 */

/** Null when the typed score is empty (unscored) or a number from 0 to 100; else the message. */
export function scoreError(axisLabel: string, value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const score = Number(trimmed);
  if (!Number.isFinite(score) || score < 0 || score > 100) {
    return `${axisLabel} score must be a number from 0 to 100.`;
  }
  return null;
}
