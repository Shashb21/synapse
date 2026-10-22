"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ComponentProps, type RefObject } from "react";
import Link from "next/link";
import { SourceClaimReviewContent } from "./source-claim-review-content";
import { RelationshipFit } from "./relationship-fit";
import { RequirementBasisReview } from "./requirement-basis-review";
import type { GapRecord } from "@/lib/iegp/gap-record";
import { gapNumberLabel } from "@/lib/iegp/gap-number";
import { RecordNavigation, RecordPanel } from "@/components/record-panel";
import { EvidenceDecisionContext } from "@/components/prioritize/priority-context";
import { GapCoverageContext, GapRecordSections } from "@/components/gap-record-sections";
import { GapMetadataView } from "@/components/gap-metadata";
import { SettingChips } from "@/components/gap-settings-editor";
import { EntityHistory } from "@/components/entity-history";
import type { TacticDraftGuard } from "@/components/tactic-ideation/use-tactic-draft-guard";
import { TacticPanelRecord, TacticRecordLink } from "@/components/tactic-ideation/tactic-panel";
import { GapPriorityActions } from "@/components/prioritize/gap-priority-actions";
import type { PrioritizeGap } from "@/components/prioritize/prioritize-matrix";

type PriorityEditor = Omit<ComponentProps<typeof GapPriorityActions>, "gap">;

export function GapPanel({ gapId, onClose, returnFocusRef, priorityEditor, refreshVersion }: {
  gapId: string | null; onClose: () => void; returnFocusRef: RefObject<HTMLElement | null>;
  priorityEditor?: PriorityEditor;
  refreshVersion?: string;
}) {
  const [detailRevision, setDetailRevision] = useState(0);
  const [tacticId, setTacticId] = useState<string | null>(null);
  const backButtonRef = useRef<HTMLButtonElement | null>(null);
  const tacticFocusRef = useRef<HTMLElement | null>(null);
  const tacticDraftRef = useRef<TacticDraftGuard | null>(null);
  // Move focus in the commit that swaps visible content, before the sheet restores
  // focus to its container when the previously focused element disappears.
  useLayoutEffect(() => {
    if (tacticId) backButtonRef.current?.focus();
    else tacticFocusRef.current?.focus();
  }, [tacticId]);
  function backToGap() {
    if (tacticDraftRef.current && !tacticDraftRef.current.allowDiscard()) return;
    tacticDraftRef.current?.reset();
    setTacticId(null);
    setDetailRevision(value => value + 1);
  }
  function close() {
    if (tacticId) backToGap();
    else onClose();
  }
  return <RecordPanel open={gapId !== null} onClose={close} returnFocusRef={returnFocusRef}
    title={tacticId ? "Tactic details" : "Gap details"} description="Current evidence context, next actions and recorded history.">
    <RecordNavigation.Provider value={{ openTactic: (id, trigger) => {
      tacticFocusRef.current = trigger;
      setTacticId(id);
    } }}>
      <div hidden={tacticId !== null}>
        {gapId ? <GapPanelRecord key={gapId} gapId={gapId} priorityEditor={priorityEditor} refreshVersion={`${refreshVersion ?? ""}:${detailRevision}`} /> : null}
      </div>
      {tacticId ? <>
        <button ref={backButtonRef} type="button" className="mb-3 underline" onClick={backToGap}>Back to gap</button>
        <TacticPanelRecord key={tacticId} tacticId={tacticId} draftGuardRef={tacticDraftRef} onClose={backToGap} onSaved={backToGap} />
      </> : null}
    </RecordNavigation.Provider>
  </RecordPanel>;
}

function GapPanelRecord({ gapId, priorityEditor, refreshVersion }: { gapId: string; priorityEditor?: PriorityEditor; refreshVersion?: string }) {
  const [record, setRecord] = useState<GapRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(true);
  // Revalidate saved data independently of editor configuration identity. Keep the
  // existing editor mounted: ActionDialog retains its opening fields and write token.
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      setError(null);
      setLoading(true);
      try {
        const response = await fetch(`/api/gaps/${encodeURIComponent(gapId)}`, { signal: controller.signal, cache: "no-store" });
        if (!response.ok) throw new Error(response.status === 404 ? "This gap is missing or unavailable in this workspace." : response.status === 401 || response.status === 403 || response.status === 409 ? "You do not currently have access to this gap. Check your workspace or sign in again." : "Gap details could not be loaded. Try again.");
        const body: GapRecord = await response.json();
        if (!controller.signal.aborted) setRecord(body);
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Gap details could not be loaded. Try again.");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [gapId, attempt, refreshVersion]);

  const priority = record?.priority;
  const editorGap: PrioritizeGap | null = record ? {
    gap_id: record.gap.id, gap_name: record.gap.name, statement: record.gap.statement,
    objective: record.objective, domain_label: record.gap.domain, settings: record.gap.settings,
    tactic_count: record.coverages.length,
    axis_scores: (priority?.axis_scores as Record<string, number> | null) ?? null,
    band: (priority?.band as PrioritizeGap["band"]) ?? null,
    validated: priority?.validated ?? false,
    suggested_band: (priority?.suggested_band as PrioritizeGap["suggested_band"]) ?? null,
    suggested_rationale: priority?.suggested_rationale ?? null,
    rationale: priority?.rationale ?? null, actor_name: priority?.actor_name ?? null, at: priority?.at ?? null,
    run_id: priority?.run_id, needs_review: priority?.needs_review,
    human_band: priority?.human_band, human_axes: priority?.human_axes,
    context_version: record.gap.priority_context_version,
    version: priority?.version ?? null,
    support_status: priority?.suggested_references?.length ? "supported" : "unsupported",
  } : null;

  return <div data-testid="gap-panel" className="grid min-w-0 gap-4">
    <div className="flex flex-wrap gap-3">
      <Link href={`/gaps/${encodeURIComponent(gapId)}`}>Open full record</Link>
      <Link href={`/gaps/${encodeURIComponent(gapId)}`}>Edit gap and mappings</Link>
    </div>
    {error ? <div><p role="alert">{error}</p>{record ? <p>Showing previously loaded details.</p> : null}<button type="button" className="mt-2 underline" onClick={() => setAttempt(value => value + 1)}>Retry gap details</button></div> : null}
    {loading ? <p role="status">{record ? "Refreshing gap details…" : "Loading gap details…"}</p> : null}
    {record ? <>
      <h2 className="break-words text-lg font-semibold leading-snug">{gapNumberLabel(record.gap.number)} · {record.gap.name}</h2>
      <section aria-label="Constituent needs">
        <h2 className="font-medium">Constituent needs</h2>
        {record.needs.length ? <ul className="grid gap-2">{record.needs.map(({ need, source, role }) => <li key={need.id}>
          <p>{need.statement}</p>
          {source ? <Link href={`/sources/${encodeURIComponent(source.id)}`}>{source.title}</Link> : <p>Source not recorded</p>}
          <p className="text-[11px] text-muted-foreground">{role}</p>
        </li>)}</ul> : <p>No constituent needs yet.</p>}
      </section>
      <GapCoverageContext record={record} />
      {record.permissions?.coverage ? <RequirementBasisReview onRefresh={() => setAttempt(value => value + 1)} gapId={gapId} review={record.requirement_review} /> : null}
      {record.source_review ? <SourceClaimReviewContent onRefresh={() => setAttempt(value => value + 1)} data={record.source_review} identity={{ signed_in: true, actor_name: "", actor_function: "medical_affairs" }} canReview={record.permissions?.coverage ?? false} /> : null}
      <EvidenceDecisionContext statement={record.gap.statement} objective={record.objective} />
      <SettingChips settings={record.gap.settings} />
      <GapMetadataView metadata={record.gap.metadata} />
      <GapRecordSections record={record} axes={record.priority_axes} tacticsUnlocked={record.tactics_unlocked} open={record.open} />
      {priorityEditor && editorGap ? <GapPriorityActions {...priorityEditor} gap={editorGap} /> : null}
      <section aria-label="Linked tactics">
        <h2 className="font-medium">Linked tactics</h2>
        {record.coverages.length ? <ul className="grid gap-2">{record.coverages.map(coverage => <li key={coverage.id}>
          <TacticRecordLink tacticId={coverage.tactic_id}>{coverage.tactic?.name || coverage.tactic_id}</TacticRecordLink> · {coverage.tactic?.status ?? "Tactic unavailable"} · {coverage.overall}
          {coverage.fit ? <RelationshipFit fit={coverage.fit} tacticName={coverage.tactic?.name ?? coverage.tactic_id} /> : null}
        </li>)}</ul> : <p>No tactics mapped.</p>}
      </section>
      <details aria-label="History" className="border-t border-border pt-3">
        <summary className="cursor-pointer font-medium">History</summary>
        <EntityHistory entries={record.history} />
      </details>
    </> : null}
  </div>;
}

/** An ordinary full-record link remains usable without JavaScript or in a new tab. */
export function GapRecordLink({ gapId, children, onClick, ...props }: Omit<ComponentProps<typeof Link>, "href"> & { gapId: string }) {
  const triggerRef = useRef<HTMLAnchorElement | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  return <>
    <Link {...props} ref={triggerRef} href={`/gaps/${encodeURIComponent(gapId)}`} aria-haspopup="dialog" onClick={event => {
      onClick?.(event);
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault(); setSelected(gapId);
    }}>{children}</Link>
    <GapPanel gapId={selected} onClose={() => setSelected(null)} returnFocusRef={triggerRef} />
  </>;
}
