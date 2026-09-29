"use client";

import { ActionDialog, type ActionIdentity } from "@/components/platform/action-dialog";
import type { GapMetadata } from "@/lib/iegp/types";
import { cn } from "@/lib/utils";

export function hasGapMetadata(metadata: GapMetadata) {
  return Boolean(
    metadata.stakeholders.length || metadata.geography || metadata.regional_nuances || metadata.notes,
  );
}

/** Impacted stakeholders, geography, regional nuances and notes, read-only (KAN-49). */
export function GapMetadataView({
  metadata,
  compact = false,
  className,
}: {
  metadata: GapMetadata;
  /** One line: stakeholders · geography, as on the Tactic Ideation card. */
  compact?: boolean;
  className?: string;
}) {
  if (compact) {
    const parts = [metadata.stakeholders.join(" · "), metadata.geography].filter(Boolean);
    if (parts.length === 0) return null;
    return <span className={cn("text-[11px] text-muted-foreground", className)}>{parts.join(" · ")}</span>;
  }
  if (!hasGapMetadata(metadata)) return null;
  return (
    <dl className={cn("grid gap-2 text-[12px] sm:grid-cols-2", className)} data-testid="gap-metadata">
      {metadata.stakeholders.length ? (
        <div className="grid gap-1">
          <dt className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            Impacted stakeholders
          </dt>
          <dd className="flex flex-wrap gap-1">
            {metadata.stakeholders.map((tag) => (
              <span key={tag} className="rounded-md bg-primary/10 px-1.5 py-px text-[11px] text-indigo-800 dark:text-indigo-300">
                {tag}
              </span>
            ))}
          </dd>
        </div>
      ) : null}
      {metadata.geography ? (
        <div className="grid gap-1">
          <dt className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Geography</dt>
          <dd className="text-foreground">{metadata.geography}</dd>
        </div>
      ) : null}
      {metadata.regional_nuances ? (
        <div className="grid gap-1 sm:col-span-2">
          <dt className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            Regional nuances
          </dt>
          <dd className="whitespace-pre-line text-foreground">{metadata.regional_nuances}</dd>
        </div>
      ) : null}
      {metadata.notes ? (
        <div className="grid gap-1 sm:col-span-2">
          <dt className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Notes</dt>
          <dd className="whitespace-pre-line text-foreground">{metadata.notes}</dd>
        </div>
      ) : null}
    </dl>
  );
}

/** Edit the gap's metadata in one dialog; the change is kept on the audit trail. */
export function GapMetadataDialog({
  gapId,
  gapName,
  metadata,
  identity,
}: {
  gapId: string;
  gapName: string;
  metadata: GapMetadata;
  identity: ActionIdentity;
}) {
  return (
    <ActionDialog
      endpoint="/api/plan"
      payload={{ action: "set_gap_metadata", gap_id: gapId }}
      label={hasGapMetadata(metadata) ? "Edit details" : "Add details"}
      title={`Details for ${gapName}`}
      description="Who the gap affects and where. Split and rewritten gaps keep these details."
      confirmLabel="Save details"
      requireRationale={false}
      identity={identity}
      variant="outline"
      size="sm"
      fields={[
        {
          name: "stakeholders",
          label: "Impacted stakeholders (comma-separated)",
          defaultValue: metadata.stakeholders.join(", "),
          placeholder: "Payers, HTA bodies, KOLs",
        },
        { name: "geography", label: "Geography", defaultValue: metadata.geography, placeholder: "US, EU5" },
        {
          name: "regional_nuances",
          label: "Regional nuances",
          type: "textarea",
          defaultValue: metadata.regional_nuances,
          placeholder: "Germany: G-BA wants a head-to-head comparator…",
        },
        { name: "notes", label: "Notes", type: "textarea", defaultValue: metadata.notes },
      ]}
    />
  );
}
