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

type Tone = "positive" | "caution" | "neutral" | "draft" | "muted" | "negative";

/**
 * Status as a dot and a word (KAN-158): calmer than filled pills, and the word
 * carries the meaning so colour is never the only signal. Open is the normal
 * starting state, so it is a hollow ring, not an alarm.
 */
export function StatusDot({ tone, children, className }: { tone: Tone; children: ReactNode; className?: string }) {
  const dot =
    tone === "positive"
      ? "bg-known"
      : tone === "caution"
        ? "bg-unknown"
        : tone === "negative"
          ? "bg-destructive"
          : tone === "draft"
            ? "border border-dashed border-muted-foreground"
            : tone === "muted"
              ? "bg-muted-foreground/50"
              : "border-[1.5px] border-muted-foreground";
  return (
    <span
      data-slot="status"
      className={`inline-flex max-w-full items-center gap-1.5 text-callout font-medium whitespace-nowrap ${tone === "muted" ? "text-muted-foreground" : "text-foreground"} ${className ?? ""}`}
    >
      <span aria-hidden className={`size-2 shrink-0 rounded-full ${dot}`} />
      {children}
    </span>
  );
}

const GAP_TONES: Record<GapStatus, Tone> = {
  candidate: "draft",
  validated_addressed: "positive",
  validated_partial: "caution",
  validated_open: "neutral",
  excluded: "muted",
};

export function GapBadge({ status }: { status: GapStatus }) {
  return (
    <BadgeHelp help={GAP_STATUS_DEFINITIONS[status]}>
      <StatusDot tone={GAP_TONES[status]}>{GAP_STATUS_LABELS[status]}</StatusDot>
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
      <StatusDot tone="muted">Parked</StatusDot>
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
  const tone: Tone = status === "accepted" ? "positive" : status === "rejected" ? "muted" : "draft";
  const help =
    status === "accepted"
      ? "This tactic is in the living plan."
      : status === "rejected"
        ? "This tactic is out of the plan."
        : "This tactic has not been taken into the living plan.";
  return (
    <BadgeHelp help={help}>
      <StatusDot tone={tone}>{TACTIC_REVIEW_LABELS[status]}</StatusDot>
    </BadgeHelp>
  );
}

export function LockMeta({ lock }: { lock: Lock }) {
  if (!lock.locked) {
    return <span className="text-caption text-unknown-foreground">Awaiting human lock</span>;
  }
  return (
    <span className="text-caption text-muted-foreground">
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
      <StatusDot tone="caution">Review coverage</StatusDot>
    </BadgeHelp>
  );
}
