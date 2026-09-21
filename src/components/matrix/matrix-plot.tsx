import type { ActionIdentity } from "@/components/platform/action-dialog";
import type { PriorityAxis } from "@/modules/stages/s8-prioritization/axes";
import {
  MatrixClusterCard,
  MatrixGapCard,
  type MatrixCard,
} from "@/components/matrix/matrix-gap-card";
import { BAND_TOKENS, type Band } from "@/components/matrix/bands";

type Point = { x: number; y: number };

const SQUARE: Point[] = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 100 },
  { x: 0, y: 100 },
];

/**
 * Keeps the half-plane `a*x + b*y >= c` (or `<= c`) of a convex polygon.
 * Used to turn the band thresholds into shaded regions of the plot.
 */
function clipHalfPlane(polygon: Point[], a: number, b: number, c: number, keepAbove: boolean): Point[] {
  const side = (p: Point) => (keepAbove ? a * p.x + b * p.y - c : c - (a * p.x + b * p.y));
  const out: Point[] = [];
  for (let i = 0; i < polygon.length; i += 1) {
    const current = polygon[i];
    const next = polygon[(i + 1) % polygon.length];
    const sc = side(current);
    const sn = side(next);
    if (sc >= 0) out.push(current);
    if (sc >= 0 !== sn >= 0) {
      const t = sc / (sc - sn);
      out.push({ x: current.x + t * (next.x - current.x), y: current.y + t * (next.y - current.y) });
    }
  }
  return out;
}

function svgPoints(polygon: Point[]): string {
  return polygon.map((p) => `${p.x.toFixed(2)},${(100 - p.y).toFixed(2)}`).join(" ");
}

/** The chord where the threshold line `a*x + b*y = c` crosses the plot square. */
function thresholdChord(a: number, b: number, c: number): Point[] {
  const edges: [Point, Point][] = [
    [SQUARE[0], SQUARE[1]],
    [SQUARE[1], SQUARE[2]],
    [SQUARE[2], SQUARE[3]],
    [SQUARE[3], SQUARE[0]],
  ];
  const hits: Point[] = [];
  for (const [p, q] of edges) {
    const fp = a * p.x + b * p.y - c;
    const fq = a * q.x + b * q.y - c;
    if (fp === 0) hits.push(p);
    else if (fp < 0 !== fq < 0) {
      const t = fp / (fp - fq);
      hits.push({ x: p.x + t * (q.x - p.x), y: p.y + t * (q.y - p.y) });
    }
  }
  return hits
    .filter(
      (point, index) =>
        hits.findIndex((other) => Math.abs(other.x - point.x) < 0.01 && Math.abs(other.y - point.y) < 0.01) ===
        index,
    )
    .slice(0, 2);
}

/**
 * The band comes from the weighted score across every axis, so on a two-axis
 * plot the thresholds project onto a diagonal of the two plotted weights.
 */
function bandRegions(args: { xWeight: number; yWeight: number; bands: { high: number; medium: number } }) {
  const wx = args.xWeight > 0 || args.yWeight > 0 ? args.xWeight : 1;
  const wy = args.xWeight > 0 || args.yWeight > 0 ? args.yWeight : 1;
  const total = wx + wy || 1;
  const cHigh = args.bands.high * total;
  const cMedium = args.bands.medium * total;
  return {
    high: clipHalfPlane(SQUARE, wx, wy, cHigh, true),
    medium: clipHalfPlane(clipHalfPlane(SQUARE, wx, wy, cMedium, true), wx, wy, cHigh, false),
    low: clipHalfPlane(SQUARE, wx, wy, cMedium, false),
    boundaries: [
      { band: "medium" as Band, chord: thresholdChord(wx, wy, cMedium) },
      { band: "high" as Band, chord: thresholdChord(wx, wy, cHigh) },
    ],
  };
}

/**
 * A card is about a quarter of the plot wide and a sixth tall, so the plot is
 * divided into slots of that size — the columns line up with the quarter
 * gridlines. A card sits in the slot its two plotted scores fall into, and gaps
 * that share a slot share one cluster card instead of covering each other. The
 * exact scores stay on the card and in its expanded panel.
 */
const COLUMNS = 4;
const ROWS = 5;

function slotOf(x: number, y: number): { column: number; row: number } {
  return {
    column: Math.max(0, Math.min(COLUMNS - 1, Math.floor((x / 100) * COLUMNS))),
    row: Math.max(0, Math.min(ROWS - 1, Math.floor(((100 - y) / 100) * ROWS))),
  };
}

export function MatrixPlot({
  cards,
  axes,
  xAxis,
  yAxis,
  bands,
  identity,
  mayPrioritize,
}: {
  cards: MatrixCard[];
  axes: PriorityAxis[];
  xAxis: PriorityAxis;
  yAxis: PriorityAxis;
  bands: { high: number; medium: number };
  identity: ActionIdentity;
  mayPrioritize: boolean;
}) {
  const regions = bandRegions({ xWeight: xAxis.weight, yWeight: yAxis.weight, bands });
  const slots = new Map<string, { column: number; row: number; cards: MatrixCard[] }>();
  for (const card of cards) {
    const x = Math.max(0, Math.min(100, card.axis_scores[xAxis.id] ?? 0));
    const y = Math.max(0, Math.min(100, card.axis_scores[yAxis.id] ?? 0));
    const slot = slotOf(x, y);
    const key = `${slot.column}:${slot.row}`;
    const existing = slots.get(key);
    if (existing) existing.cards.push(card);
    else slots.set(key, { ...slot, cards: [card] });
  }

  return (
    <div className="grid gap-2">
      <div className="flex items-stretch gap-2">
        <div className="flex w-6 shrink-0 flex-col items-center justify-between py-1 text-[11px] text-muted-foreground">
          <span className="[writing-mode:vertical-rl] rotate-180 whitespace-nowrap">
            {yAxis.high_label}
          </span>
          <span className="[writing-mode:vertical-rl] rotate-180 whitespace-nowrap text-foreground">
            {yAxis.label}
          </span>
          <span className="[writing-mode:vertical-rl] rotate-180 whitespace-nowrap">
            {yAxis.low_label}
          </span>
        </div>
        <div className="relative aspect-square w-full max-w-[680px] rounded-md border border-border bg-card/40">
          <svg
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            className="absolute inset-0 size-full rounded-md"
            aria-hidden
          >
            <polygon points={svgPoints(regions.low)} fill={BAND_TOKENS.low} opacity="0.06" />
            <polygon points={svgPoints(regions.medium)} fill={BAND_TOKENS.medium} opacity="0.08" />
            <polygon points={svgPoints(regions.high)} fill={BAND_TOKENS.high} opacity="0.12" />
            {[25, 50, 75].map((tick) => (
              <g key={tick} stroke="var(--border)" strokeWidth="0.25">
                <line x1={tick} y1="0" x2={tick} y2="100" />
                <line x1="0" y1={tick} x2="100" y2={tick} />
              </g>
            ))}
            {regions.boundaries.map(({ band, chord }) =>
              chord.length === 2 ? (
                <line
                  key={band}
                  x1={chord[0].x}
                  y1={100 - chord[0].y}
                  x2={chord[1].x}
                  y2={100 - chord[1].y}
                  stroke={BAND_TOKENS[band]}
                  strokeWidth="0.4"
                  strokeDasharray="1.5 1.5"
                  opacity="0.75"
                />
              ) : null,
            )}
          </svg>
          <span className="pointer-events-none absolute right-2 top-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
            High band region
          </span>
          <span className="pointer-events-none absolute bottom-1.5 left-2 text-[10px] uppercase tracking-wide text-muted-foreground">
            Low band region
          </span>
          {[...slots.entries()].map(([key, cluster]) => {
            const style = {
              left: `${((cluster.column + 0.5) / COLUMNS) * 100}%`,
              top: `${((cluster.row + 0.5) / ROWS) * 100}%`,
              width: `calc(${100 / COLUMNS}% - 8px)`,
              transform: "translate(-50%, -50%)",
            };
            return cluster.cards.length === 1 ? (
              <MatrixGapCard
                key={key}
                card={cluster.cards[0]}
                axes={axes}
                xAxis={xAxis}
                yAxis={yAxis}
                identity={identity}
                mayPrioritize={mayPrioritize}
                style={style}
              />
            ) : (
              <MatrixClusterCard
                key={key}
                cards={cluster.cards}
                axes={axes}
                xAxis={xAxis}
                yAxis={yAxis}
                identity={identity}
                mayPrioritize={mayPrioritize}
                style={style}
              />
            );
          })}
        </div>
      </div>
      <div className="flex max-w-[680px] items-center justify-between pl-8 text-[11px] text-muted-foreground">
        <span>{xAxis.low_label}</span>
        <span className="text-foreground">{xAxis.label}</span>
        <span>{xAxis.high_label}</span>
      </div>
    </div>
  );
}
