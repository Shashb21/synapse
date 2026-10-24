/** The four matrix priorities (KAN-8, the owner's Figma design). */
export type Band = "high" | "medium" | "low" | "defer";

export const BANDS: Band[] = ["high", "medium", "low", "defer"];

export const BAND_LABELS: Record<Band, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
  defer: "Defer",
};

/**
 * The quadrant each band is on the canvas. One vocabulary everywhere (KAN-158):
 * the canvas, chips and lists all say High, Medium, Low and Defer.
 */
export const QUADRANT_NAMES: Record<Band, string> = BAND_LABELS;

/**
 * Band colour comes from the tokens so the plot, chips and legend agree. Priority
 * is a decision, not a status, so it is one accent at falling strength (KAN-158):
 * red, amber and green stay for evidence status alone.
 */
export const BAND_TOKENS: Record<Band, string> = {
  high: "var(--primary)",
  medium: "color-mix(in oklab, var(--primary) 62%, var(--muted-foreground))",
  low: "color-mix(in oklab, var(--primary) 28%, var(--muted-foreground))",
  defer: "var(--muted-foreground)",
};

const BAND_BARS: Record<Band, number> = { high: 3, medium: 2, low: 1, defer: 0 };

/** Priority as a three-step bar glyph, like signal strength; the word sits beside it. */
export function PriorityBars({ band, className }: { band: Band; className?: string }) {
  const filled = BAND_BARS[band];
  return (
    <span aria-hidden className={`inline-flex items-end gap-px ${className ?? ""}`}>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="w-[3px] rounded-[1px]"
          style={{ height: 4 + i * 3, backgroundColor: i < filled ? BAND_TOKENS.high : "var(--border)" }}
        />
      ))}
    </span>
  );
}

export function BandChip({ band, validated }: { band: Band; validated: boolean }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 text-callout font-medium text-foreground"
      title={validated ? `${BAND_LABELS[band]} priority, validated` : `${BAND_LABELS[band]} priority, suggested and not yet validated`}
    >
      <PriorityBars band={band} />
      {BAND_LABELS[band]}
      {validated ? null : <span className="font-normal text-muted-foreground">(suggested)</span>}
    </span>
  );
}

export function BandLegend({ counts }: { counts: Record<Band, number> }) {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-caption text-muted-foreground">
      {BANDS.map((band) => (
        <li key={band} className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-full" style={{ backgroundColor: BAND_TOKENS[band] }} aria-hidden />
          {BAND_LABELS[band]}
          <span className="text-foreground">{counts[band]}</span>
        </li>
      ))}
      <li className="flex items-center gap-1.5">
        <span className="size-2.5 rounded-full border border-dashed border-muted-foreground" aria-hidden />
        Dashed means suggested, not yet validated
      </li>
    </ul>
  );
}
