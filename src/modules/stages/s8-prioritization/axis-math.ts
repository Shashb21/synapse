/**
 * Pure matrix geometry for Prioritize, free of the database so the client
 * matrix can share it with the server.
 */

export type PriorityAxis = {
  id: string;
  label: string;
  description: string;
  /** Relative contribution to the suggested band. 0 keeps an axis visible but non-scoring. */
  weight: number;
  low_label: string;
  high_label: string;
  /** Phrases that raise this axis for a gap. Editable by the user. */
  cues: string[];
  /**
   * Whether a higher score argues for a higher priority. False for cost-style
   * axes (Effort & cost): there the low end is the favourable one. The matrix
   * flips such an axis so its favourable end always sits top / left.
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

/**
 * The matrix band. Favourable on both plotted axes (top-left) is High, on
 * neither (bottom-right) is Low, and the two mixed quadrants are Medium.
 */
export function quadrantBand(args: {
  xAxis: PriorityAxis;
  yAxis: PriorityAxis;
  scores: Record<string, number>;
}): "high" | "medium" | "low" {
  const x = favourability(args.xAxis, args.scores[args.xAxis.id] ?? 0) >= 50;
  const y = favourability(args.yAxis, args.scores[args.yAxis.id] ?? 0) >= 50;
  if (x && y) return "high";
  if (!x && !y) return "low";
  return "medium";
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
