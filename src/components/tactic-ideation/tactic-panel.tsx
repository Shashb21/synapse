"use client";

import { requestErrorMessage, RequestOutcomeError } from "@/lib/post-json";

import Link from "next/link";
import { useEffect, useRef, useState, type ComponentProps, type RefObject } from "react";
import type { CustomTacticType } from "@/lib/iegp/custom-tactic-type";
import type { ActorFunction, TacticStatus, TacticType } from "@/lib/iegp/enums";
import type { ActionIdentity } from "@/components/platform/action-dialog";
import type { TacticRecord } from "@/lib/iegp/tactic-record";
import type { TacticDraftGuard } from "@/components/tactic-ideation/use-tactic-draft-guard";
import { RecordPanel, useRecordNavigation } from "@/components/record-panel";
import { TacticRecordContent } from "@/components/tactic-record-content";

/** The fields the side panel edits (KAN-50). */
export type TacticEditModel = {
  id: string;
  version?: string;
  name: string;
  type: TacticType;
  custom_type: CustomTacticType | null;
  status: TacticStatus;
  evidence_question: string;
  start_date: string | null;
  evidence_available: string | null;
  budget: string | null;
  owner: string;
  function: ActorFunction;
};


/** The existing editable tactic interaction, now using the common record surface. */
export function TacticEditPanel({ tactic, onClose, returnFocusRef }: {
  tactic: TacticEditModel | null; identity: ActionIdentity; inUse: CustomTacticType[];
  onClose: () => void; returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  return <TacticPanel tacticId={tactic?.id ?? null} onClose={onClose} returnFocusRef={returnFocusRef} refreshVersion={tactic?.version} />;
}

export function TacticPanel({ tacticId, onClose, returnFocusRef, refreshVersion }: {
  tacticId: string | null; onClose: () => void; returnFocusRef?: RefObject<HTMLElement | null>; refreshVersion?: string;
}) {
  const fallbackFocus = useRef<HTMLElement | null>(null);
  const draftGuardRef = useRef<TacticDraftGuard | null>(null);
  function requestClose() {
    if (draftGuardRef.current && !draftGuardRef.current.allowDiscard()) return;
    draftGuardRef.current?.reset();
    onClose();
  }
  return <RecordPanel open={tacticId !== null} onClose={requestClose} returnFocusRef={returnFocusRef ?? fallbackFocus}
    title="Tactic details" description="Current tactic details, authorised actions and recorded history.">
    {tacticId ? <TacticPanelRecord key={tacticId} tacticId={tacticId} refreshVersion={refreshVersion}
      draftGuardRef={draftGuardRef} onClose={requestClose} onSaved={onClose} /> : null}
  </RecordPanel>;
}

export function TacticPanelRecord({ tacticId, refreshVersion, draftGuardRef, onClose, onSaved }: {
  tacticId: string; refreshVersion?: string; draftGuardRef: RefObject<TacticDraftGuard | null>;
  onClose: () => void; onSaved: () => void;
}) {
  const [record, setRecord] = useState<TacticRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      setError(null); setLoading(true);
      try {
        const response = await fetch(`/api/tactics/${encodeURIComponent(tacticId)}`, { signal: controller.signal, cache: "no-store" });
        if (!response.ok) throw new RequestOutcomeError(response.status === 404 ? "This tactic is missing or unavailable in this workspace." : [401, 403, 409].includes(response.status) ? "You do not currently have access to this tactic. Check your workspace or sign in again." : "Tactic details could not be loaded. Try again.", "rejected", response.status);
        const body: TacticRecord = await response.json();
        if (!controller.signal.aborted) setRecord(body);
      } catch (failure) {
        if (!controller.signal.aborted) setError(requestErrorMessage(failure, "Tactic details could not be loaded. Try again."));
      } finally { if (!controller.signal.aborted) setLoading(false); }
    }
    void load();
    return () => controller.abort();
  }, [tacticId, attempt, refreshVersion]);
  return <div data-testid="tactic-panel" className="grid min-w-0 gap-4">
    <Link href={`/tactics/${encodeURIComponent(tacticId)}`}>Open full record</Link>
    {record ? <button type="button" className="w-fit underline" onClick={() => setAttempt(value => value + 1)}>Refresh tactic details</button> : null}
    {error ? <div><p role="alert">{error}</p>{record ? <p>Showing previously loaded details.</p> : null}<button type="button" className="underline" onClick={() => setAttempt(value => value + 1)}>Retry tactic details</button></div> : null}
    {loading ? <p role="status">{record ? "Refreshing tactic details…" : "Loading tactic details…"}</p> : null}
    {record ? <TacticRecordContent record={record} draftGuardRef={draftGuardRef} onClose={onClose} onSaved={onSaved} onRefresh={() => setAttempt(value => value + 1)} /> : null}
  </div>;
}

/** Ordinary navigation and new-tab behaviour remain available from every entry point. */
export function TacticRecordLink({ tacticId, children, onClick, ...props }: Omit<ComponentProps<typeof Link>, "href"> & { tacticId: string }) {
  const triggerRef = useRef<HTMLAnchorElement | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const navigation = useRecordNavigation();
  return <>
    <Link {...props} ref={triggerRef} href={`/tactics/${encodeURIComponent(tacticId)}`} aria-haspopup="dialog" onClick={event => {
      onClick?.(event);
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || props.target === "_blank") return;
      event.preventDefault();
      if (navigation) navigation.openTactic(tacticId, event.currentTarget);
      else setSelected(tacticId);
    }}>{children}</Link>
    <TacticPanel tacticId={selected} onClose={() => setSelected(null)} returnFocusRef={triggerRef} />
  </>;
}
