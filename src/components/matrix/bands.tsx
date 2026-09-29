/** The four matrix priorities (KAN-8, the owner's Figma design). */
export type Band = "high" | "medium" | "low" | "defer";

export const BANDS: Band[] = ["high", "medium", "low", "defer"];

export const BAND_LABELS: Record<Band, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
  defer: "Defer",
};

/** The quadrant each band is on the canvas, as the design names them. */
export const QUADRANT_NAMES: Record<Band, string> = {
  high: "Prioritize",
  medium: "Plan",
  low: "Monitor",
  defer: "Defer",
};

/** Band colour comes from the tokens so the plot, chips and legend agree. */
export const BAND_TOKENS: Record<Band, string> = {
  high: "var(--chart-5)",
  medium: "var(--chart-4)",
  low: "var(--opportunity)",
  defer: "var(--muted-foreground)",
};

export function BandChip({ band, validated }: { band: Band; validated: boolean }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-4xl border px-1.5 py-px text-[10px] font-medium"
      style={{
        borderColor: BAND_TOKENS[band],
        color: BAND_TOKENS[band],
        borderStyle: validated ? "solid" : "dashed",
      }}
    >
      <span className="size-1.5 rounded-full" style={{ backgroundColor: BAND_TOKENS[band] }} aria-hidden />
      {BAND_LABELS[band]}
    </span>
  );
}

export function BandLegend({ counts }: { counts: Record<Band, number> }) {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-muted-foreground">
      {BANDS.map((band) => (
        <li key={band} className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-full" style={{ backgroundColor: BAND_TOKENS[band] }} aria-hidden />
          {BAND_LABELS[band]}
          <span className="text-foreground">{counts[band]}</span>
        </li>
      ))}
      <li className="flex items-center gap-1.5">
        <span className="size-2.5 rounded-full border border-dashed border-muted-foreground" aria-hidden />
        A dashed edge means the band is still only an AI suggestion
      </li>
    </ul>
  );
}
