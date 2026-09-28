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

/**
 * A gap sits on the matrix only when both plotted axes are scored. A save that
 * types one score, leaves the other unscored and picks no band would close the
 * dialog and leave the gap under "Not placed yet", so it is refused with why.
 */
export function placementGapError(args: {
  x: { label: string; typed: string; saved: number | undefined };
  y: { label: string; typed: string; saved: number | undefined };
  band: string;
}): string | null {
  if (args.band.trim()) return null;
  const has = (axis: { typed: string; saved: number | undefined }) =>
    axis.typed.trim() !== "" || typeof axis.saved === "number";
  const typedAny = args.x.typed.trim() !== "" || args.y.typed.trim() !== "";
  if (!typedAny) return null;
  const missing = [args.y, args.x].filter((axis) => !has(axis));
  if (missing.length === 0) return null;
  return `Give the ${missing[0]!.label} score too, so the gap has a place on the matrix, or pick a band.`;
}
