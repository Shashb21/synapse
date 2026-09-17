import { GAP_STATUS_LABELS, type GapStatus, type OverallCoverage, type PriorityBand, type TacticStatus } from "@/lib/iegp/enums";
import { Badge } from "@/components/ui/badge";
import type { Lock } from "@/lib/iegp/types";

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
    <Badge variant="outline" className={tone}>
      {GAP_STATUS_LABELS[status]}
    </Badge>
  );
}

export function CoverageBadge({ overall }: { overall: OverallCoverage }) {
  return (
    <Badge variant="outline" className="capitalize">
      {overall.replaceAll("_", " ")}
    </Badge>
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
    <Badge variant="outline" className={`capitalize ${tone}`}>
      {band}
    </Badge>
  );
}

export function TacticBadge({ status }: { status: TacticStatus }) {
  return (
    <Badge variant="outline" className="capitalize">
      {status}
    </Badge>
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

export function StaleFlag({ stale }: { stale: boolean }) {
  if (!stale) return null;
  return (
    <Badge variant="destructive">Stale — re-lock</Badge>
  );
}
