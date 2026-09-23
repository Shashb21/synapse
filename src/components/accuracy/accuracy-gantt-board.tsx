"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { GanttActivity } from "@/accuracy/modules/gantt-project/engine";
import { activitiesToSvg } from "@/accuracy/modules/gantt-project/export-svg";

function toDay(iso: string): number {
  return Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
}

function downloadSvg(filename: string, svg: string) {
  const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function AccuracyGanttBoard({
  workspaceId,
  activities,
  planVersion,
  planStatus,
}: {
  workspaceId: string;
  activities: GanttActivity[];
  planVersion: number | null;
  planStatus: string | null;
}) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const timeWindow = useMemo(() => {
    if (activities.length === 0) return null;
    const starts = activities.map((a) => toDay(a.start));
    const ends = activities.map((a) => toDay(a.end));
    const min = Math.min(...starts);
    const max = Math.max(...ends);
    const span = Math.max(max - min, 1);
    return { min, span };
  }, [activities]);

  async function saveFinal() {
    setError(null);
    setMessage(null);
    if (note.trim().length < 3) {
      setError("A short sign-off rationale is required.");
      return;
    }
    setPending(true);
    try {
      const res = await fetch("/api/accuracy/gantt/save-final", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspace_id: workspaceId,
          status: "final",
          note,
        }),
      });
      const body = (await res.json()) as {
        error?: string;
        plan?: { version: number; status: string };
      };
      if (!res.ok) {
        setError(body.error ?? "Save final failed");
        return;
      }
      setMessage(
        body.plan ? `Saved v${body.plan.version} as ${body.plan.status}` : "Saved as final",
      );
      setNote("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save final failed");
    } finally {
      setPending(false);
    }
  }

  function exportSvg() {
    if (activities.length === 0) return;
    downloadSvg(`synapse-gantt-${workspaceId}.svg`, activitiesToSvg(activities));
  }

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[12px] text-muted-foreground">
          {activities.length} bar(s) from validated tactics only
          {planVersion != null ? (
            <span>
              {" "}
              · latest plan v{planVersion} ({planStatus ?? "—"})
            </span>
          ) : null}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={activities.length === 0} onClick={exportSvg}>
            Export SVG
          </Button>
          <Button
            size="sm"
            disabled={pending || activities.length === 0}
            onClick={() => void saveFinal()}
          >
            {pending ? "Saving…" : "Save as final"}
          </Button>
        </div>
      </div>

      <label className="grid gap-1 text-[11px] text-muted-foreground">
        Sign-off rationale (required)
        <Textarea
          value={note}
          onChange={(event) => setNote(event.target.value)}
          rows={2}
          placeholder="Why this projection is the final IEGP truth"
          className="text-[12px]"
        />
      </label>
      {error ? <p className="text-[11px] text-destructive">{error}</p> : null}
      {message ? <p className="text-[11px] text-[var(--known)]">{message}</p> : null}

      {activities.length === 0 ? (
        <p className="text-[12px] text-muted-foreground">
          No Gantt bars yet. Validate tactics with start and end dates in the ledger first.
        </p>
      ) : (
        <ul
          className="grid gap-2"
          aria-label={`Gantt timeline with ${activities.length} activities`}
        >
          {activities.map((activity) => {
            const left = timeWindow
              ? ((toDay(activity.start) - timeWindow.min) / timeWindow.span) * 100
              : 0;
            const width = timeWindow
              ? Math.max(
                  ((toDay(activity.end) - toDay(activity.start)) / timeWindow.span) * 100,
                  2,
                )
              : 2;
            return (
              <li key={activity.id} className="border border-border bg-card/40 p-3">
                <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-[13px] text-foreground">{activity.tactic_id}</p>
                  <span className="text-[11px] text-muted-foreground">
                    {activity.start.slice(0, 10)} → {activity.end.slice(0, 10)}
                  </span>
                </div>
                <div className="relative h-3 overflow-hidden rounded-sm bg-muted/40">
                  <div
                    className="absolute inset-y-0 rounded-sm bg-foreground/70"
                    style={{ left: `${left}%`, width: `${width}%` }}
                    title={`${activity.tactic_id}: ${activity.start} → ${activity.end}`}
                  />
                </div>
                {activity.depends_on.length > 0 ? (
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    Depends on {activity.depends_on.join(", ")}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
