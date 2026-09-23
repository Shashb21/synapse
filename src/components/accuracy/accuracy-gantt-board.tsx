"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type { GanttActivity } from "@/accuracy/modules/gantt-project/engine";
import {
  ganttBarAriaLabel,
  resolveActivityDetail,
} from "@/accuracy/modules/gantt-project/activity-detail";
import {
  activitiesToSvg,
  ganttExportFileName,
} from "@/accuracy/modules/gantt-project/export-svg";
import type { GanttCatalogEntry } from "@/accuracy/modules/gantt-project/snapshot-hash";
import { svgMarkupToPngBlob, triggerBlobDownload } from "@/components/accuracy/svg-to-png";

function toDay(iso: string): number {
  return Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
}

function downloadSvg(filename: string, svg: string) {
  const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
  triggerBlobDownload(blob, filename);
}

function focusBar(refs: Array<HTMLButtonElement | null>, index: number) {
  const next = refs[index];
  if (!next) return;
  next.focus();
}

export function AccuracyGanttBoard({
  workspaceId,
  activities,
  catalog,
  planVersion,
  planStatus,
  planId,
  snapshotHash,
  auditBundleHref,
}: {
  workspaceId: string;
  activities: GanttActivity[];
  catalog: GanttCatalogEntry[];
  planVersion: number | null;
  planStatus: string | null;
  planId: string | null;
  snapshotHash: string | null;
  auditBundleHref: string | null;
}) {
  const router = useRouter();
  const barRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [savedHash, setSavedHash] = useState<string | null>(null);
  const [savedAuditHref, setSavedAuditHref] = useState<string | null>(null);

  const hash = savedHash ?? snapshotHash;
  const auditHref = savedAuditHref ?? auditBundleHref;
  const selected = activities.find((row) => row.id === selectedId) ?? null;
  const detail = selected
    ? resolveActivityDetail({ activity: selected, activities, catalog })
    : null;

  const timeWindow = useMemo(() => {
    if (activities.length === 0) return null;
    const starts = activities.map((a) => toDay(a.start));
    const ends = activities.flatMap((a) => [toDay(a.end), a.readout ? toDay(a.readout) : toDay(a.end)]);
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
        plan?: { version: number; status: string; id: string };
        snapshot_hash?: string;
        audit_bundle?: { href: string; snapshot_hash: string };
      };
      if (!res.ok) {
        setError(body.error ?? "Save final failed");
        return;
      }
      const nextHash = body.snapshot_hash ?? body.audit_bundle?.snapshot_hash ?? null;
      const nextHref = body.audit_bundle?.href ?? null;
      setSavedHash(nextHash);
      setSavedAuditHref(nextHref);
      setMessage(
        body.plan
          ? `Saved v${body.plan.version} as ${body.plan.status}`
          : "Saved as final",
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
    downloadSvg(
      ganttExportFileName({ workspace_id: workspaceId, version: planVersion, ext: "svg" }),
      activitiesToSvg(activities),
    );
  }

  async function exportPng() {
    if (activities.length === 0) return;
    setExporting(true);
    setError(null);
    try {
      const blob = await svgMarkupToPngBlob(activitiesToSvg(activities));
      triggerBlobDownload(
        blob,
        ganttExportFileName({ workspace_id: workspaceId, version: planVersion, ext: "png" }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "PNG export failed");
    } finally {
      setExporting(false);
    }
  }

  function onBarKeyDown(index: number, event: KeyboardEvent<HTMLButtonElement>) {
    const last = activities.length - 1;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      event.preventDefault();
      focusBar(barRefs.current, Math.min(index + 1, last));
      return;
    }
    if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      event.preventDefault();
      focusBar(barRefs.current, Math.max(index - 1, 0));
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      focusBar(barRefs.current, 0);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      focusBar(barRefs.current, last);
    }
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
              {planId ? ` · ${planId}` : ""}
            </span>
          ) : null}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={activities.length === 0}
            onClick={exportSvg}
          >
            Export SVG
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={activities.length === 0 || exporting}
            onClick={() => void exportPng()}
          >
            {exporting ? "Exporting…" : "Export PNG"}
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

      {hash ? (
        <p className="text-[11px] text-muted-foreground" data-testid="gantt-snapshot-hash">
          Snapshot hash{" "}
          <code className="break-all font-mono text-[11px] text-foreground" title={hash}>
            {hash}
          </code>
          {auditHref ? (
            <>
              {" "}
              ·{" "}
              <Link
                href={auditHref}
                className="text-foreground underline-offset-2 hover:underline"
                data-testid="gantt-audit-bundle-link"
              >
                Audit bundle
              </Link>
            </>
          ) : null}
        </p>
      ) : null}

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
          Coverage joins and dependencies keep successor bars after upstream readouts.
        </p>
      ) : (
        <ul
          className="grid gap-2"
          aria-label={`Gantt timeline with ${activities.length} activities`}
        >
          {activities.map((activity, index) => {
            const left = timeWindow
              ? ((toDay(activity.start) - timeWindow.min) / timeWindow.span) * 100
              : 0;
            const width = timeWindow
              ? Math.max(
                  ((toDay(activity.end) - toDay(activity.start)) / timeWindow.span) * 100,
                  2,
                )
              : 2;
            const readoutLeft =
              timeWindow && activity.readout
                ? ((toDay(activity.readout) - timeWindow.min) / timeWindow.span) * 100
                : null;
            const selectedBar = selectedId === activity.id;
            return (
              <li key={activity.id}>
                <button
                  type="button"
                  ref={(node) => {
                    barRefs.current[index] = node;
                  }}
                  className={`w-full border bg-card/40 p-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/60 ${
                    selectedBar ? "border-foreground" : "border-border"
                  }`}
                  aria-label={ganttBarAriaLabel(activity, catalog)}
                  aria-pressed={selectedBar}
                  onClick={() => setSelectedId(activity.id)}
                  onKeyDown={(event) => onBarKeyDown(index, event)}
                >
                  <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                    <p className="text-[13px] text-foreground">
                      {catalog.find((row) => row.id === activity.tactic_id)?.statement ??
                        activity.tactic_id}
                    </p>
                    <span className="text-[11px] text-muted-foreground">
                      {activity.start.slice(0, 10)} → {activity.end.slice(0, 10)}
                      {activity.readout ? ` · readout ${activity.readout.slice(0, 10)}` : ""}
                    </span>
                  </div>
                  <div className="relative h-3 rounded-sm bg-muted/40">
                    <div
                      className="absolute inset-y-0 rounded-sm bg-foreground/70"
                      style={{ left: `${left}%`, width: `${width}%` }}
                    />
                    {readoutLeft != null ? (
                      <span
                        aria-hidden
                        className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rotate-45 bg-[var(--opportunity,#60a5fa)]"
                        style={{ left: `${readoutLeft}%` }}
                      />
                    ) : null}
                  </div>
                  {activity.gap_ids.length > 0 ? (
                    <p className="mt-2 text-[11px] text-muted-foreground">
                      Covers {activity.gap_ids.join(", ")}
                    </p>
                  ) : null}
                  {activity.depends_on.length > 0 ? (
                    <p className="mt-2 text-[11px] text-muted-foreground">
                      Depends on {activity.depends_on.join(", ")}
                    </p>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <Sheet open={selected !== null} onOpenChange={(open) => (open ? null : setSelectedId(null))}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-md">
          {detail ? (
            <>
              <SheetHeader>
                <SheetTitle className="text-[15px]">
                  {detail.tactic?.statement ?? detail.activity.tactic_id}
                </SheetTitle>
                <SheetDescription className="text-[12px]">
                  Tactic {detail.activity.tactic_id} · activity {detail.activity.id}
                </SheetDescription>
              </SheetHeader>
              <div className="grid gap-4 px-4 pb-6">
                <section>
                  <h3 className="text-[12px] font-medium text-foreground">Evidence gaps</h3>
                  {detail.gaps.length === 0 ? (
                    <p className="mt-1 text-[12px] text-muted-foreground">
                      No validated coverage joins on this bar.
                    </p>
                  ) : (
                    <ul className="mt-1 grid gap-1">
                      {detail.gaps.map((gap) => (
                        <li key={gap.id} className="text-[12px] text-muted-foreground">
                          <span className="text-foreground">{gap.statement}</span>{" "}
                          <span className="text-muted-foreground/70">{gap.id}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
                <section>
                  <h3 className="text-[12px] font-medium text-foreground">Interdependencies</h3>
                  <dl className="mt-1 grid gap-1 text-[12px] text-muted-foreground">
                    <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-2">
                      <dt>Start</dt>
                      <dd className="text-foreground">{detail.activity.start.slice(0, 10)}</dd>
                    </div>
                    <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-2">
                      <dt>End</dt>
                      <dd className="text-foreground">{detail.activity.end.slice(0, 10)}</dd>
                    </div>
                    <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-2">
                      <dt>Readout</dt>
                      <dd className="text-foreground">
                        {detail.activity.readout?.slice(0, 10) ?? "—"}
                      </dd>
                    </div>
                  </dl>
                  {detail.depends_on.length > 0 ? (
                    <p className="mt-2 text-[12px] text-muted-foreground">
                      Depends on{" "}
                      {detail.depends_on
                        .map((row) => `${row.statement} (${row.id})`)
                        .join("; ")}
                    </p>
                  ) : (
                    <p className="mt-2 text-[12px] text-muted-foreground">No upstream waits.</p>
                  )}
                  {detail.dependents.length > 0 ? (
                    <p className="mt-1 text-[12px] text-muted-foreground">
                      Unblocks{" "}
                      {detail.dependents
                        .map((row) => `${row.statement} (${row.id})`)
                        .join("; ")}
                    </p>
                  ) : null}
                </section>
              </div>
            </>
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}
