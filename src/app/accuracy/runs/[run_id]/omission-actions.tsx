"use client";
/** Run-scoped contributor review, decision retries, and explicit downstream resume. */
import { useCallback, useEffect, useRef, useState } from "react";
import type { OmissionAction, OmissionReviewItem } from "@/accuracy/store/omission-review-store";

type Review = { current: boolean; items: OmissionReviewItem[]; actions: OmissionAction[];
  extraction_batch_id: string | null; source_file_id: string | null; downstream_state: "completed" | "resumable" | "stale" };
type Decision = "add" | "link_existing" | "dismiss" | "reclassify";
const fieldClass = "w-full border border-border bg-background p-2 text-[12px] text-foreground";
const buttonClass = "border border-border px-3 py-2 text-[12px] text-foreground disabled:opacity-50";

/** Read an API response and preserve its actionable failure message. */
async function readResponse(response: Response) {
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `Request failed (HTTP ${response.status}).`);
  return body;
}

/** Keep a request key stable for identical retries, including an uncertain network outcome. */
function useRequestKey() {
  const previous = useRef<{ fingerprint: string; key: string } | null>(null);
  return (body: Record<string, unknown>) => {
    const fingerprint = JSON.stringify(body);
    if (previous.current?.fingerprint !== fingerprint) previous.current = { fingerprint, key: crypto.randomUUID() };
    return { ...body, idempotency_key: previous.current.key };
  };
}

/** Render one issue's action fields, requiring a deliberate confirmation for an ambiguous add. */
function DecisionForm({ item, onSaved, unavailable, onPendingChange }: {
  item: OmissionReviewItem; onSaved: () => Promise<void>; unavailable: boolean;
  onPendingChange: (issueId: string, pending: boolean) => void;
}) {
  const [action, setAction] = useState<Decision>("add");
  const [reason, setReason] = useState("");
  const [statement, setStatement] = useState(item.issue.summary);
  const [claimId, setClaimId] = useState("");
  const [importance, setImportance] = useState("advisory");
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const requestKey = useRequestKey();
  const prefix = `decision-${encodeURIComponent(item.run_id)}-${encodeURIComponent(item.issue.issue_id)}`;
  const payload = { workspace_id: item.workspace_id, run_id: item.run_id, issue_id: item.issue.issue_id,
    action, reason: reason.trim(), ...(action === "add" ? { statement: statement.trim() } : {}),
    ...(action === "link_existing" ? { claim_id: claimId.trim() } : {}),
    ...(action === "reclassify" ? { new_importance: importance } : {}) };
  const fingerprint = JSON.stringify(payload);
  const confirmable = confirmation === fingerprint;

  async function save(confirmedDistinct = false) {
    if (pending || unavailable) return;
    if (!reason.trim() || (action === "link_existing" && !claimId.trim()) || (action === "add" && !statement.trim())) {
      setError("Complete the required fields, including a reason."); return;
    }
    setPending(true); onPendingChange(item.issue.issue_id, true); setError(null);
    try {
      const response = await fetch("/api/accuracy/omissions", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(requestKey({ ...payload, ...(confirmedDistinct ? { confirmed_distinct: true } : {}) })) });
      const body = await response.json();
      if (!response.ok) {
        const message = body.error ?? `Decision failed (HTTP ${response.status}).`;
        // Only the API's ambiguous-identity conflict permits a distinct-item confirmation.
        setConfirmation(response.status === 409 && action === "add" && message.startsWith("Ambiguous claim ")
          && message.includes("confirm this is a distinct item") ? fingerprint : null);
        setError(message); return;
      }
      setConfirmation(null);
      await onSaved();
    } catch {
      setError("Could not save this decision. Try again with the same fields.");
    } finally { setPending(false); onPendingChange(item.issue.issue_id, false); }
  }

  return <form className="mt-3 grid max-w-xl gap-2" aria-label={`Review issue ${item.issue.issue_id}`}
    onSubmit={(event) => { event.preventDefault(); void save(); }}>
    <fieldset disabled={pending || unavailable} className="grid gap-2">
      <label htmlFor={`${prefix}-action`}>Action</label>
      <select id={`${prefix}-action`} className={fieldClass} value={action} onChange={(event) => { setAction(event.target.value as Decision); setConfirmation(null); setError(null); }}>
        <option value="add">Add item</option><option value="link_existing">Link existing item</option>
        <option value="dismiss">Dismiss</option><option value="reclassify">Reclassify</option>
      </select>
      {action === "add" ? <><label htmlFor={`${prefix}-statement`}>Statement</label>
        <textarea id={`${prefix}-statement`} className={fieldClass} required value={statement} onChange={(event) => setStatement(event.target.value)} /></> : null}
      {action === "link_existing" ? <><label htmlFor={`${prefix}-claim`}>Claim ID</label>
        <input id={`${prefix}-claim`} className={fieldClass} required value={claimId} onChange={(event) => setClaimId(event.target.value)} /></> : null}
      {action === "reclassify" ? <><label htmlFor={`${prefix}-importance`}>Importance</label>
        <select id={`${prefix}-importance`} className={fieldClass} value={importance} onChange={(event) => setImportance(event.target.value)}>
          <option value="advisory">Advisory</option><option value="important">Important</option>
        </select></> : null}
      <label htmlFor={`${prefix}-reason`}>Reason</label>
      <textarea id={`${prefix}-reason`} className={fieldClass} required value={reason} onChange={(event) => setReason(event.target.value)} />
      <button className={buttonClass} type="submit">{pending ? "Saving decision…" : "Save decision"}</button>
      {confirmable ? <button className={buttonClass} type="button" onClick={() => void save(true)}>Confirm distinct item and add</button> : null}
    </fieldset>
    {error ? <p role="alert">{error}</p> : null}
    {pending ? <p role="status">Saving decision…</p> : null}
  </form>;
}

/** Show server review state and allow authorized contributors to resolve or resume it. */
export default function OmissionActions({ workspaceId, runId, canReview }: {
  workspaceId: string; runId: string; canReview: boolean;
}) {
  const [review, setReview] = useState<Review | null>(null);
  const [blockers, setBlockers] = useState<OmissionReviewItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [resuming, setResuming] = useState(false);
  const [resumed, setResumed] = useState(false);
  const [pendingDecisions, setPendingDecisions] = useState<Set<string>>(() => new Set());
  const requestKey = useRequestKey();
  const loadReview = useCallback(async () => {
    const query = `workspace_id=${encodeURIComponent(workspaceId)}`;
    const [run, current] = await Promise.all([
      fetch(`/api/accuracy/omissions?${query}&run_id=${encodeURIComponent(runId)}`, { cache: "no-store" }),
      fetch(`/api/accuracy/omissions?${query}`, { cache: "no-store" }),
    ]);
    // Non-applied historical runs still have progression, but no contributor review.
    if (run.status === 404) return { review: null, blockers: [] };
    const [nextReview, nextCurrent] = await Promise.all([readResponse(run), readResponse(current)]);
    return { review: nextReview as Review, blockers: nextCurrent.items.filter((item: OmissionReviewItem) => item.blocking) as OmissionReviewItem[] };
  }, [workspaceId, runId]);
  useEffect(() => {
    let active = true;
    void loadReview().then((next) => {
      if (active) { setReview(next.review); setBlockers(next.blockers); }
    }).catch((failure: unknown) => {
      if (active) setError(failure instanceof Error ? failure.message : "Could not load review. Try again.");
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [loadReview]);

  /** Keep review refresh and resume disabled while any decision awaits its response. */
  function recordPendingDecision(issueId: string, pending: boolean) {
    setPendingDecisions(previous => {
      const next = new Set(previous);
      if (pending) next.add(issueId); else next.delete(issueId);
      return next;
    });
  }

  async function refreshReview() {
    setLoading(true); setError(null);
    try {
      const next = await loadReview();
      setReview(next.review); setBlockers(next.blockers);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not load review. Try again.");
    } finally { setLoading(false); }
  }

  async function resume() {
    if (!review?.extraction_batch_id || !review.source_file_id || loading || error || resuming || pendingDecisions.size || blockers.length || review.items.some(item => item.blocking)) return;
    setResuming(true); setError(null);
    try {
      await readResponse(await fetch("/api/accuracy/extract", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(requestKey({ action: "resume", workspace_id: workspaceId, source_file_id: review.source_file_id,
          extraction_batch_id: review.extraction_batch_id })) }));
      setResumed(true);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Could not resume. Try again."); }
    finally { setResuming(false); }
  }

  return <section aria-label="Omission review" className="mb-4 border border-border bg-card/40 p-3 text-[12px] text-foreground">
    <h2 className="text-[15px] font-medium">Omission review</h2>
    {loading ? <p role="status">Loading review…</p> : null}
    {error ? <p role="alert" className="mt-2">{error}</p> : null}
    {error && !review ? <button type="button" className={buttonClass} disabled={loading} onClick={() => void refreshReview()}>Try again</button> : null}
    {!loading && !error && !review ? <p className="mt-2">No applied extraction review is available for this run.</p> : null}
    {review ? <>
      <p className="mt-2">{review.current ? "Current extraction" : "Superseded extraction · historical findings"} · Run {runId}</p>
      {review.downstream_state === "completed" ? <p className="mt-1">Downstream work completed.</p> : null}
      {review.current && blockers.length ? <p className="mt-1">Paused · {blockers.length} important unresolved {blockers.length === 1 ? "finding" : "findings"} in this workspace.</p> : null}
      <ul className="mt-2 grid gap-3">{review.items.map((item) => {
        const action = item.latest_action;
        const closed = !!action && (action.action !== "reclassify" || action.new_importance === "advisory");
        return <li key={item.issue.issue_id} id={`omission-${encodeURIComponent(item.issue.issue_id)}`} className="border-t border-border pt-2">
          <strong>{(action?.new_importance ?? item.issue.importance) === "important" ? "Important" : "Advisory"} · {item.blocking ? "Blocking" : "Non-blocking"}</strong>: {item.issue.summary}
          <p>Issue ID: {item.issue.issue_id} · Run {item.run_id}</p>
          <p>Source file {item.source_file_id}, block {item.issue.source_ref.block_id}</p>
          <p>Evidence quote: “{item.issue.evidence_quote}”</p>
          {action ? <><p>Latest action: {action.action.replaceAll("_", " ")}{action.claim_id ? ` · Claim ${action.claim_id}` : ""}</p>
            <p>Actor: {action.actor_name} ({action.actor_function}) · Reason: {action.reason}</p></> : <p>Open · No contributor decision recorded.</p>}
          {canReview && review.current && !closed ? <DecisionForm item={item} onSaved={refreshReview}
            unavailable={loading || !!error || resuming} onPendingChange={recordPendingDecision} /> : null}
        </li>;
      })}</ul>
      {review.actions.length ? <details className="mt-3"><summary>Decision history</summary>
        <ul className="mt-2 grid gap-2">{review.actions.map(action => <li key={action.id}>
          Issue {action.issue_id} · {action.action.replaceAll("_", " ")}{action.claim_id ? ` · Claim ${action.claim_id}` : ""}
          <p>{action.actor_name} ({action.actor_function}) · {action.reason} · {action.created_at}</p>
        </li>)}</ul></details> : null}
      {canReview ? <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className={buttonClass} disabled={loading || resuming || pendingDecisions.size > 0} onClick={() => void refreshReview()}>Refresh review</button>
        {review.current && review.downstream_state === "resumable" && review.extraction_batch_id && review.source_file_id && !blockers.length && !review.items.some(item => item.blocking) && !loading && !error && !resumed
          ? <button type="button" className={buttonClass} disabled={resuming || pendingDecisions.size > 0} onClick={() => void resume()}>{resuming ? "Resuming…" : "Resume downstream work"}</button> : null}
      </div> : null}
      {resuming ? <p role="status">Resuming downstream work…</p> : null}
      {resumed ? <p role="status">Downstream work resumed.</p> : null}
    </> : null}
  </section>;
}
