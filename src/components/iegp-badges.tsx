"use client";

import type { ReactNode } from "react";
import {
  GAP_STATUS_DEFINITIONS,
  GAP_STATUS_LABELS,
  OVERALL_COVERAGE_HELPERS,
  OVERALL_COVERAGE_LABELS,
  PRIORITY_BAND_HELPERS,
  TACTIC_REVIEW_LABELS,
  TACTIC_STATUS_HELPERS,
  type GapStatus,
  type OverallCoverage,
  type PriorityBand,
  type TacticReviewStatus,
  type TacticStatus,
} from "@/lib/iegp/enums";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Lock } from "@/lib/iegp/types";

function BadgeHelp({ help, children }: { help: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger
        nativeButton={false}
        delay={0}
        render={<span className="inline-flex max-w-full cursor-help align-middle" />}
      >
        {children}
      </TooltipTrigger>
      <TooltipContent className="max-w-xs text-left whitespace-normal">
        {help}
      </TooltipContent>
    </Tooltip>
  );
}

export function GapBadge({ status }: { status: GapStatus }) {
  const tone =
    status === "validated_addressed"
      ? "bg-emerald-500/15 text-emerald-300"
      : status === "validated_open"
        ? "bg-amber-500/15 text-amber-300"
        : status === "validated_partial"
          ? "bg-sky-500/15 text-sky-300"
          : status === "excluded"
            ? "bg-zinc-500/20 text-zinc-400"
            : "bg-violet-500/15 text-violet-300";
  return (
    <BadgeHelp help={GAP_STATUS_DEFINITIONS[status]}>
      <Badge variant="outline" className={tone}>
        {GAP_STATUS_LABELS[status]}
      </Badge>
    </BadgeHelp>
  );
}

export function CoverageBadge({ overall }: { overall: OverallCoverage }) {
  return (
    <BadgeHelp help={OVERALL_COVERAGE_HELPERS[overall]}>
      <Badge variant="outline">{OVERALL_COVERAGE_LABELS[overall]}</Badge>
    </BadgeHelp>
  );
}

export function PriorityBadge({ band }: { band: PriorityBand }) {
  const tone =
    band === "critical"
      ? "bg-red-500/15 text-red-300"
      : band === "high"
        ? "bg-orange-500/15 text-orange-300"
        : band === "medium"
          ? "bg-yellow-500/15 text-yellow-200"
          : "bg-zinc-500/20 text-zinc-400";
  return (
    <BadgeHelp help={PRIORITY_BAND_HELPERS[band]}>
      <Badge variant="outline" className={`capitalize ${tone}`}>
        {band}
      </Badge>
    </BadgeHelp>
  );
}

export function TacticBadge({ status }: { status: TacticStatus }) {
  return (
    <BadgeHelp help={TACTIC_STATUS_HELPERS[status]}>
      <Badge variant="outline" className="capitalize">
        {status}
      </Badge>
    </BadgeHelp>
  );
}

export function TacticReviewBadge({ status }: { status: TacticReviewStatus }) {
  const tone =
    status === "accepted"
      ? "bg-emerald-500/15 text-emerald-300"
      : status === "rejected"
        ? "bg-zinc-500/20 text-zinc-400"
        : "bg-violet-500/15 text-violet-300";
  const help =
    status === "accepted"
      ? "This tactic is in the living plan."
      : status === "rejected"
        ? "This tactic is out of the plan."
        : "This tactic has not been taken into the living plan.";
  return (
    <BadgeHelp help={help}>
      <Badge variant="outline" className={tone}>
        {TACTIC_REVIEW_LABELS[status]}
      </Badge>
    </BadgeHelp>
  );
}

export function LockMeta({ lock }: { lock: Lock }) {
  if (!lock.locked) {
    return <span className="text-[11px] text-amber-300">Unlocked — human gate open</span>;
  }
  return (
    <span className="text-[11px] text-muted-foreground">
      Locked by {lock.actor_name} ({lock.actor_function?.replaceAll("_", " ")})
      {lock.locked_at ? ` · ${lock.locked_at.slice(0, 10)}` : ""}
    </span>
  );
}

/**
 * Coverage (this gap–tactic pair) may be out of date because the tactic’s
 * status changed or new evidence was ingested. Dimension values are not
 * automatically trusted until a human reviews them. Older copy said
 * “Stale — re-lock”; “re-lock” was leftover from calling every coverage
 * edit “Lock” and did not mean freeze forever.
 */
export function StaleFlag({ stale }: { stale: boolean }) {
  if (!stale) return null;
  return (
    <BadgeHelp help="This gap–tactic coverage call may be out of date because the tactic’s status changed or new sources were ingested. Open the gap to review coverage. Dimension values are not automatically trusted.">
      <Badge variant="destructive" className="h-auto max-w-full whitespace-normal text-left">
        Outdated coverage
      </Badge>
    </BadgeHelp>
  );
}

/**
 * A sibling live gap mapped to the same tactic had a dimension or overall
 * change. Values were not copied onto this gap. Distinct from outdated
 * coverage (`stale`), which is tactic-status or ingest.
 */
export function NeedsReviewFlag({ needsReview }: { needsReview: boolean }) {
  if (!needsReview) return null;
  return (
    <BadgeHelp help="Another live gap that uses this tactic changed a dimension or overall. Confirm or edit this gap’s own coverage. Values were not copied.">
      <Badge
        variant="outline"
        className="h-auto max-w-full whitespace-normal border-amber-500/40 bg-amber-500/15 text-left text-amber-200"
      >
        Review coverage — also mapped elsewhere
      </Badge>
    </BadgeHelp>
  );
}
