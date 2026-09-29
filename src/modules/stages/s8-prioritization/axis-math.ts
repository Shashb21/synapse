/**
 * Pure matrix geometry for Prioritize, free of the database so the client
 * matrix can share it with the server.
 */

export type PriorityAxis = {
  id: string;
  label: string;
  description: string;
  /** Legacy relative weight; the band is the quadrant on the two plotted axes. */
  weight: number;
  low_label: string;
  high_label: string;
  /**
   * Whether a higher score argues for a higher priority. False for cost-style
   * axes (Effort & cost): there the low end is the favourable one. The matrix
   * flips such an axis so its favourable end always sits top / right.
   */
  higher_is_priority?: boolean;
};

/** A score moved onto the axis's favourable scale: 100 is always the priority end. */
export function favourability(axis: Pick<PriorityAxis, "higher_is_priority">, score: number): number {
  const clamped = Math.max(0, Math.min(100, score));
  return axis.higher_is_priority === false ? 100 - clamped : clamped;
}

/** Inverse of `favourability`: the raw axis score for a favourable-scale value. */
export function scoreFromFavourability(
  axis: Pick<PriorityAxis, "higher_is_priority">,
  favourable: number,
): number {
  const clamped = Math.max(0, Math.min(100, Math.round(favourable)));
  return axis.higher_is_priority === false ? 100 - clamped : clamped;
}

/** The end of the axis that argues for priority (plotted top on Y, left on X). */
export function favourableLabel(axis: PriorityAxis): string {
  return axis.higher_is_priority === false ? axis.low_label : axis.high_label;
}

export function unfavourableLabel(axis: PriorityAxis): string {
  return axis.higher_is_priority === false ? axis.high_label : axis.low_label;
}

/** The four matrix priorities (KAN-8, the owner's Figma design). */
export const MATRIX_BANDS = ["high", "medium", "low", "defer"] as const;
export type MatrixBand = (typeof MATRIX_BANDS)[number];

export const MATRIX_BAND_LABELS: Record<MatrixBand, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
  defer: "Defer",
};

/** The quadrant names the design shows on the canvas. */
export const QUADRANT_LABELS: Record<MatrixBand, { label: string; sub: string }> = {
  high: { label: "Prioritize", sub: "Favourable on both axes" },
  medium: { label: "Plan", sub: "Favourable on the vertical axis only" },
  low: { label: "Monitor", sub: "Favourable on the horizontal axis only" },
  defer: { label: "Defer", sub: "Favourable on neither axis" },
};

/**
 * The quadrant a placement sits in, as a suggestion the person confirms.
 * Favourable on both plotted axes (top-right) is Prioritize (High); on the
 * vertical axis only (top-left) Plan (Medium); on the horizontal axis only
 * (bottom-right) Monitor (Low); on neither (bottom-left) Defer.
 */
export function quadrantBand(args: {
  xAxis: PriorityAxis;
  yAxis: PriorityAxis;
  scores: Record<string, number>;
}): MatrixBand {
  const x = favourability(args.xAxis, args.scores[args.xAxis.id] ?? 0) >= 50;
  const y = favourability(args.yAxis, args.scores[args.yAxis.id] ?? 0) >= 50;
  if (x && y) return "high";
  if (y) return "medium";
  if (x) return "low";
  return "defer";
}

/** Mean favourability on the two plotted axes, 0–100 — the matrix's single score. */
export function quadrantScore(args: {
  xAxis: PriorityAxis;
  yAxis: PriorityAxis;
  scores: Record<string, number>;
}): number {
  return Math.round(
    (favourability(args.xAxis, args.scores[args.xAxis.id] ?? 0) +
      favourability(args.yAxis, args.scores[args.yAxis.id] ?? 0)) /
      2,
  );
}
