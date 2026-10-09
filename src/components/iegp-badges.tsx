"use client";

import type { ReactNode } from "react";
import {
  GAP_STATUS_DEFINITIONS,
  GAP_STATUS_LABELS,
  OVERALL_COVERAGE_HELPERS,
  OVERALL_COVERAGE_LABELS,
  TACTIC_REVIEW_LABELS,
  TACTIC_STATUS_HELPERS,
  type GapStatus,
  type OverallCoverage,
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
    // Figma design (KAN-8): addressed emerald, partial amber, open rose.
    status === "validated_addressed"
      ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300"
      : status === "validated_open"
        ? "border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300"
        : status === "validated_partial"
          ? "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300"
          : status === "excluded"
            ? "bg-zinc-500/20 text-zinc-600 dark:text-zinc-400"
            : "bg-violet-500/15 text-violet-700 dark:text-violet-300";
  return (
    <BadgeHelp help={GAP_STATUS_DEFINITIONS[status]}>
      <Badge variant="outline" className={tone}>
        {GAP_STATUS_LABELS[status]}
      </Badge>
    </BadgeHelp>
  );
}

/**
 * Parked: a human set this gap aside as not a real gap. Reversible — unlike
 * Excluded, it can be unparked. Hidden from Prioritize and Tactics while parked.
 */
export function ParkedFlag({ reason }: { reason?: string | null }) {
  return (
    <BadgeHelp
      help={
        reason
          ? `Parked: ${reason}`
          : "Parked — set aside as not a real gap. Hidden from Prioritize and Tactics until unparked."
      }
    >
      <Badge variant="outline" className="bg-fuchsia-500/15 text-fuchsia-300">
        Parked
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
      ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
      : status === "rejected"
        ? "bg-zinc-500/20 text-zinc-600 dark:text-zinc-400"
        : "bg-violet-500/15 text-violet-700 dark:text-violet-300";
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
    return <span className="text-[11px] text-amber-700 dark:text-amber-300">Unlocked — human gate open</span>;
  }
  return (
    <span className="text-[11px] text-muted-foreground">
      Locked by {lock.actor_name} ({lock.actor_function?.replaceAll("_", " ")})
      {lock.locked_at ? ` · ${lock.locked_at.slice(0, 10)}` : ""}
    </span>
  );
}

/**
 * Coverage to confirm again: a sibling live gap mapped to the same tactic changed
 * a dimension or overall, or this gap's wording changed in a merge (KAN-75).
 * Values were not copied onto this gap.
 */
export function NeedsReviewFlag({ needsReview }: { needsReview: boolean }) {
  if (!needsReview) return null;
  return (
    <BadgeHelp help="Something this coverage depends on changed: the gap’s wording was merged with a new source, or another gap that uses this tactic changed its coverage. Confirm or edit this gap’s own coverage.">
      <Badge
        variant="outline"
        className="h-auto max-w-full whitespace-normal border-amber-500/40 bg-amber-500/15 text-left text-amber-700 dark:text-amber-200"
      >
        Review coverage
      </Badge>
    </BadgeHelp>
  );
}
