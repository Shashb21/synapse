import {
  GAP_STATUS_DEFINITIONS,
  GAP_STATUS_LABELS,
  type GapStatus,
} from "@/lib/iegp/enums";

const HUMAN_STATUSES: GapStatus[] = [
  "validated_open",
  "validated_partial",
  "validated_addressed",
];

export function GapStatusGuide({ compact = false }: { compact?: boolean }) {
  return (
    <section
      aria-labelledby="gap-status-defs"
      className={compact ? "mb-4" : "mb-6 border border-border bg-card/40 p-4"}
    >
      <h2
        id="gap-status-defs"
        className="text-[13px] font-medium text-foreground"
      >
        Gap status
      </h2>
      <dl className="mt-2 grid gap-3">
        {HUMAN_STATUSES.map((status) => (
          <div key={status}>
            <dt className="text-[12px] font-medium text-foreground">
              {GAP_STATUS_LABELS[status]}
            </dt>
            <dd className="mt-0.5 text-[12px] leading-5 text-muted-foreground">
              {GAP_STATUS_DEFINITIONS[status]}{" "}
              {status === "validated_partial"
                ? "Click Partial to split or rewrite — it cannot stay."
                : "Click Open or Addressed to override with a reason."}
            </dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-[12px] leading-5 text-muted-foreground">
        <span className="font-medium text-foreground">Parked</span> is a separate flag, not a
        status — for a gap you don&apos;t think is real. Park it from the gap page with a reason;
        it stays listed but drops out of Prioritize and Tactics until unparked.
      </p>
    </section>
  );
}
