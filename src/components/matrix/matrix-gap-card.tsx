import type { CSSProperties } from "react";
import Link from "next/link";
import { ActionDialog, type ActionIdentity } from "@/components/platform/action-dialog";
import type { PriorityAxis } from "@/modules/stages/s8-prioritization/axes";
import { BandChip, BAND_LABELS, BAND_TOKENS, type Band } from "@/components/matrix/bands";

export type MatrixCard = {
  gap_id: string;
  gap_name: string;
  statement: string;
  domain_label: string;
  axis_scores: Record<string, number>;
  score: number;
  band: Band;
  validated: boolean;
  suggested_band: Band;
  suggested_rationale: string;
  rationale: string | null;
  actor_name: string | null;
  at: string;
  tactic_count: number;
};

function ValidateBandAction({
  card,
  identity,
  mayPrioritize,
}: {
  card: MatrixCard;
  identity: ActionIdentity;
  mayPrioritize: boolean;
}) {
  if (!mayPrioritize) {
    return (
      <p className="text-[11px] text-muted-foreground">
        Your role may not validate priority bands.
      </p>
    );
  }
  return (
    <ActionDialog
      endpoint="/api/plan"
      payload={{ action: "validate_band", gap_id: card.gap_id }}
      label={card.validated ? "Re-validate band" : "Validate band"}
      title={`Validate the band for ${card.gap_name}`}
      description={`S8 suggests ${BAND_LABELS[card.suggested_band]} from a weighted score of ${card.score}. Accept it or pick a different band.`}
      confirmLabel="Validate band"
      requireRationale
      identity={identity}
      size="sm"
      fields={[
        {
          name: "band",
          label: "Band",
          type: "select",
          defaultValue: card.validated ? card.band : card.suggested_band,
          options: [
            { value: "high", label: `High${card.suggested_band === "high" ? " (suggested)" : ""}` },
            { value: "medium", label: `Medium${card.suggested_band === "medium" ? " (suggested)" : ""}` },
            { value: "low", label: `Low${card.suggested_band === "low" ? " (suggested)" : ""}` },
          ],
        },
      ]}
    />
  );
}

/**
 * Several gaps scored onto the same spot. One badge-carrying card holds them so
 * nothing is hidden underneath another card.
 */
export function MatrixClusterCard({
  cards,
  axes,
  xAxis,
  yAxis,
  identity,
  mayPrioritize,
  style,
}: {
  cards: MatrixCard[];
  axes: PriorityAxis[];
  xAxis: PriorityAxis;
  yAxis: PriorityAxis;
  identity: ActionIdentity;
  mayPrioritize: boolean;
  style: CSSProperties;
}) {
  const counts = cards.reduce<Record<Band, number>>(
    (acc, card) => ({ ...acc, [card.band]: acc[card.band] + 1 }),
    { high: 0, medium: 0, low: 0 },
  );
  const pending = cards.filter((card) => !card.validated).length;
  return (
    <details className="group absolute z-20 open:z-50" style={style}>
      <summary className="list-none cursor-pointer rounded-md border border-border bg-card/90 p-1.5 shadow-sm backdrop-blur-[1px] transition-colors hover:bg-card">
        <div className="flex items-center justify-between gap-1">
          <span className="rounded-4xl bg-muted px-1.5 text-[10px] font-medium text-foreground">
            {cards.length} gaps here
          </span>
          <span className="flex items-center gap-0.5" aria-hidden>
            {(["high", "medium", "low"] as Band[]).map((band) =>
              counts[band] > 0 ? (
                <span
                  key={band}
                  className="size-1.5 rounded-full"
                  style={{ backgroundColor: BAND_TOKENS[band] }}
                />
              ) : null,
            )}
          </span>
        </div>
        <p className="mt-1 text-[10px] leading-3 text-muted-foreground">
          {(["high", "medium", "low"] as Band[])
            .filter((band) => counts[band] > 0)
            .map((band) => `${counts[band]} ${BAND_LABELS[band]}`)
            .join(" · ")}
        </p>
        <p className="mt-0.5 text-[10px] leading-3 text-muted-foreground">
          {pending === 0 ? "All validated" : `${pending} awaiting validation`}
        </p>
      </summary>
      <div className="absolute mt-1 grid w-[288px] gap-1.5 rounded-md border border-border bg-card p-2 shadow-lg">
        <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
          Same scores on both plotted axes
        </p>
        {cards.map((card) => (
          <MatrixGapCard
            key={card.gap_id}
            card={card}
            axes={axes}
            xAxis={xAxis}
            yAxis={yAxis}
            identity={identity}
            mayPrioritize={mayPrioritize}
          />
        ))}
      </div>
    </details>
  );
}

/**
 * One gap on the matrix. Positioned when it sits alone on its spot, and listed
 * inside the cluster card when several gaps share one.
 */
export function MatrixGapCard({
  card,
  axes,
  xAxis,
  yAxis,
  identity,
  mayPrioritize,
  style,
}: {
  card: MatrixCard;
  axes: PriorityAxis[];
  xAxis: PriorityAxis;
  yAxis: PriorityAxis;
  identity: ActionIdentity;
  mayPrioritize: boolean;
  style?: CSSProperties;
}) {
  const positioned = Boolean(style);
  return (
    <details
      className={
        positioned
          ? "group absolute z-10 open:z-40"
          : "group relative w-full open:z-40"
      }
      style={style}
    >
      <summary
        className="list-none cursor-pointer rounded-md border bg-card/90 p-1.5 shadow-sm backdrop-blur-[1px] transition-colors hover:bg-card"
        style={{
          borderColor: BAND_TOKENS[card.band],
          borderStyle: card.validated ? "solid" : "dashed",
        }}
      >
        <div className="flex items-center justify-between gap-1">
          <BandChip band={card.band} validated={card.validated} />
          <span className="text-[10px] text-muted-foreground">{card.score}</span>
        </div>
        <p
          className={`mt-1 text-[12px] leading-4 text-foreground group-open:line-clamp-none ${
            positioned ? "line-clamp-2" : ""
          }`}
        >
          {card.gap_name}
        </p>
        <p className="mt-1 truncate text-[10px] text-muted-foreground group-open:whitespace-normal">
          {card.domain_label} · {card.tactic_count} tactic{card.tactic_count === 1 ? "" : "s"}
        </p>
        <p className="mt-0.5 text-[10px] text-muted-foreground">
          {card.validated
            ? `Validated ${BAND_LABELS[card.band]}`
            : `Suggested ${BAND_LABELS[card.suggested_band]}`}
        </p>
      </summary>
      <div
        className={`mt-1 grid gap-2 rounded-md border border-border bg-card p-2 ${
          positioned ? "absolute w-[264px] shadow-lg" : ""
        }`}
      >
        <p className="text-[12px] leading-4 text-muted-foreground">{card.statement}</p>
        <dl className="grid gap-1">
          {axes.map((axis) => {
            const value = card.axis_scores[axis.id];
            const plotted = axis.id === xAxis.id ? "x" : axis.id === yAxis.id ? "y" : null;
            return (
              <div key={axis.id} className="grid gap-0.5">
                <div className="flex items-baseline justify-between gap-2 text-[11px]">
                  <dt className="truncate text-muted-foreground">
                    {axis.label}
                    {plotted ? <span className="text-foreground"> · {plotted}</span> : null}
                  </dt>
                  <dd className="text-foreground">{typeof value === "number" ? value : "—"}</dd>
                </div>
                <div className="h-1 w-full rounded-4xl bg-muted">
                  <div
                    className="h-1 rounded-4xl"
                    style={{
                      width: `${Math.max(0, Math.min(100, value ?? 0))}%`,
                      backgroundColor: plotted ? BAND_TOKENS[card.band] : "var(--muted-foreground)",
                    }}
                  />
                </div>
              </div>
            );
          })}
        </dl>
        <p className="text-[11px] text-muted-foreground">
          Weighted score {card.score} · suggestion {BAND_LABELS[card.suggested_band]}
        </p>
        <p className="text-[11px] leading-4 text-muted-foreground">{card.suggested_rationale}</p>
        {card.validated ? (
          <p className="text-[11px] leading-4" style={{ color: BAND_TOKENS[card.band] }}>
            Validated {BAND_LABELS[card.band]} by {card.actor_name ?? "unknown"}
            {card.at ? ` · ${card.at.slice(0, 10)}` : ""}
            {card.rationale ? ` — ${card.rationale}` : ""}
          </p>
        ) : (
          <p className="text-[11px] text-muted-foreground">
            Not validated yet. The band stays a suggestion until a human accepts or changes it.
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <ValidateBandAction card={card} identity={identity} mayPrioritize={mayPrioritize} />
          <Link
            href={`/gaps/${card.gap_id}`}
            className="text-[11px] text-muted-foreground no-underline hover:underline"
          >
            Gap dossier
          </Link>
        </div>
      </div>
    </details>
  );
}
