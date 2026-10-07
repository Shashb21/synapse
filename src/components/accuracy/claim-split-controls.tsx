"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAiEnabled } from "@/components/platform/ai-status";
import { COVERAGE_DIMENSIONS } from "@/lib/iegp/enums";
import type { SplitProposal } from "@/accuracy/store/partial-split-store";
import type { ProvenanceSpan } from "@/accuracy/store/quote-validator";
import { ClaimEvidence } from "./claim-evidence";
import { sendJson } from "./claim-api";

type Inputs = {
  expected_parent_revision: string; expected_coverage_revision: string;
  supporting_coverage: { tactic_id: string; rationale: string | null }[];
  permitted_evidence: ProvenanceSpan[];
};
const buttonClass = "border border-border px-2 py-1 text-[11px] disabled:opacity-40 hover:bg-muted/40";
const inputClass = "border border-border bg-background px-2 py-1 text-[12px]";

export function ClaimSplitControls({ workspaceId, gapId }: { workspaceId: string; gapId: string }) {
  const router = useRouter(), aiOn = useAiEnabled();
  const [open, setOpen] = useState(false), [pending, setPending] = useState(false);
  const [input, setInput] = useState<Inputs | null>(null), [proposal, setProposal] = useState<SplitProposal | null>(null);
  const [rationale, setRationale] = useState(""), [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null), [operationKey, setOperationKey] = useState("");

  async function load() {
    setOpen(true); setPending(true); setError(null); setConfirmed(false); setProposal(null); setInput(null);
    try {
      const response = await fetch(`/api/accuracy/claims/split?workspace_id=${encodeURIComponent(workspaceId)}&gap_id=${encodeURIComponent(gapId)}`);
      const json = await response.json();
      if (!response.ok) { setError(json.error ?? "Could not load current split inputs."); setInput(null); return; }
      setInput(json); setOperationKey(crypto.randomUUID());
    } catch { setError("Could not load split inputs; retry before confirming."); }
    finally { setPending(false); }
  }
  function manual() {
    if (!input) return;
    setConfirmed(false);
    setProposal({ workspace_id: workspaceId, parent_gap_id: gapId, expected_parent_revision: input.expected_parent_revision,
      expected_coverage_revision: input.expected_coverage_revision, confirmed: false,
      addressed_name: "", addressed_statement: "", open_name: "", open_statement: "",
      addressed_tactic_ids: [], addressed_evidence: [], open_evidence: [], uncovered_dimensions: [], confidence: 0, rationale: [] });
  }
  async function suggest() {
    setPending(true); setError(null); setConfirmed(false);
    const result = await sendJson("/api/accuracy/claims/split/propose", "POST", { workspace_id: workspaceId, gap_id: gapId });
    setPending(false);
    if (!result.ok) { setError(`${result.error} You can prepare a manual split from the current evidence.`); return; }
    if (!result.json.proposal) { setError("No supported split proposal returned. Prepare a manual split from the evidence, or retry."); return; }
    const next = result.json.proposal as SplitProposal;
    if (!input || next.expected_parent_revision !== input.expected_parent_revision || next.expected_coverage_revision !== input.expected_coverage_revision) {
      setProposal(null); setError("Split inputs changed since the evidence was displayed. Reload current split inputs and review a new proposal."); return;
    }
    setProposal(next); setOperationKey(crypto.randomUUID());
  }
  function change(patch: Partial<SplitProposal>) {
    if (!proposal) return;
    setProposal({ ...proposal, ...patch }); setConfirmed(false); setOperationKey(crypto.randomUUID());
  }
  async function apply() {
    if (!proposal || !confirmed) return;
    setPending(true); setError(null);
    const result = await sendJson("/api/accuracy/claims/split/apply", "POST", { workspace_id: workspaceId,
      proposal: { ...proposal, confirmed: true, rationale: proposal.rationale.length ? proposal.rationale : [rationale.trim()] }, operation_key: operationKey, rationale });
    setPending(false);
    if (!result.ok) { setError(`${result.error} Reload current inputs if the parent or coverage changed.`); return; }
    setOpen(false); setProposal(null); router.refresh();
  }
  return <div className="mt-3 grid gap-2">
    <button className={buttonClass} type="button" disabled={pending} onClick={() => open ? setOpen(false) : void load()}>{open ? "Close split" : "Resolve Partial gap"}</button>
    {open ? <section aria-label="Resolve Partial gap" className="grid gap-2 border-t border-border pt-2">
      <p className="text-[12px]">Review exact addressed and residual statements and their source evidence before confirming. The residual starts Open with pending coverage and no inherited priority.</p>
      <div className="flex flex-wrap gap-2">
        <button className={buttonClass} type="button" disabled={pending} onClick={() => void load()}>Reload current split inputs</button>
        <button className={buttonClass} type="button" disabled={pending || !input} onClick={manual}>Prepare manual split</button>
        {aiOn ? <button className={buttonClass} type="button" disabled={pending || !input} onClick={() => void suggest()}>Suggest a split</button> : null}
      </div>
      {proposal && input ? <>
        <p className="text-[11px]">{proposal.confidence ? `Suggestion confidence: ${proposal.confidence}. ${proposal.rationale.join(" ")}` : "Manual proposal — requires human confirmation."}</p>
        {(["addressed", "open"] as const).map(slice => <fieldset key={slice} className="grid gap-2 border border-border p-2">
          <legend className="text-[12px]">{slice === "addressed" ? "Addressed slice" : "Open residual"}</legend>
          <label className="grid gap-1 text-[12px]">{slice === "addressed" ? "Addressed" : "Residual"} name<input className={inputClass} value={proposal[`${slice}_name`]} onChange={e => change({ [`${slice}_name`]: e.target.value })} /></label>
          <label className="grid gap-1 text-[12px]">{slice === "addressed" ? "Addressed" : "Residual"} statement<textarea className={inputClass} value={proposal[`${slice}_statement`]} onChange={e => change({ [`${slice}_statement`]: e.target.value })} /></label>
          <p className="text-[11px]">Select direct source evidence{slice === "open" ? " (optional; inherited context alone stays unknown)" : " (required)"}:</p>
          {input.permitted_evidence.map((span, index) => <label key={index} className="flex gap-2 text-[12px]">
            <input type="checkbox" checked={proposal[`${slice}_evidence`].some(s => JSON.stringify(s) === JSON.stringify(span))}
              onChange={e => change({ [`${slice}_evidence`]: e.target.checked ? [...proposal[`${slice}_evidence`], span] : proposal[`${slice}_evidence`].filter(s => JSON.stringify(s) !== JSON.stringify(span)) })} />
            {slice === "addressed" ? "Addressed" : "Residual"} evidence: {span.quote}
          </label>)}
          <ClaimEvidence workspaceId={workspaceId} spans={proposal[`${slice}_evidence`]} />
        </fieldset>)}
        <fieldset className="grid gap-1"><legend>Committed closing tactics</legend>
          {input.supporting_coverage.map(row => <label key={row.tactic_id} className="flex gap-2 text-[12px]"><input type="checkbox" checked={proposal.addressed_tactic_ids.includes(row.tactic_id)} onChange={e => change({ addressed_tactic_ids: e.target.checked ? [...proposal.addressed_tactic_ids, row.tactic_id] : proposal.addressed_tactic_ids.filter(id => id !== row.tactic_id) })} />{row.tactic_id} · {row.rationale}</label>)}
        </fieldset>
        <fieldset className="flex flex-wrap gap-2"><legend>Uncovered residual dimensions</legend>
          {COVERAGE_DIMENSIONS.map(dimension => <label key={dimension} className="flex gap-1 text-[12px]"><input type="checkbox" checked={proposal.uncovered_dimensions.includes(dimension)} onChange={e => change({ uncovered_dimensions: e.target.checked ? [...proposal.uncovered_dimensions, dimension] : proposal.uncovered_dimensions.filter(d => d !== dimension) })} />{dimension}</label>)}
        </fieldset>
        <label className="grid gap-1 text-[12px]">Split rationale (required)<textarea className={inputClass} value={rationale} onChange={e => { setRationale(e.target.value); setConfirmed(false); setOperationKey(crypto.randomUUID()); }} /></label>
        <p className="text-[12px]">Confirm addressed: {proposal.addressed_statement}<br />Confirm residual: {proposal.open_statement}</p>
        <label className="flex gap-2 text-[12px]"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />I reviewed both exact statements, closing tactics and evidence.</label>
        <button className={buttonClass} type="button" disabled={pending || !confirmed || rationale.trim().length < 3 || !proposal.addressed_evidence.length || !proposal.addressed_tactic_ids.length || !proposal.uncovered_dimensions.length || [proposal.addressed_name, proposal.addressed_statement, proposal.open_name, proposal.open_statement].some(s => s.trim().length < 3)} onClick={() => void apply()}>{pending ? "Applying…" : "Confirm and apply split"}</button>
      </> : null}
      {error ? <p role="alert" className="text-[12px] text-destructive">{error}</p> : null}
    </section> : null}
  </div>;
}

export type SplitHistoryRow = { id: string; parent_gap_id: string; addressed_gap_id: string; open_residual_gap_id: string; state: string; actor: { name?: string }; rationale: string; created_at: string; rolled_back_at: string | null };
export function SplitOperationHistory({ workspaceId, operations }: { workspaceId: string; operations: SplitHistoryRow[] }) {
  return <section aria-label="Split operation history" className="mt-4 grid gap-2">
    <h2 className="text-[13px] font-semibold">Split operation history</h2>
    {!operations.length ? <p className="text-[12px] text-muted-foreground">No split operations.</p> : operations.map(operation => <RollbackOperation key={`${operation.id}:${operation.state}`} workspaceId={workspaceId} operation={operation} />)}
  </section>;
}
function RollbackOperation({ workspaceId, operation }: { workspaceId: string; operation: SplitHistoryRow }) {
  const router = useRouter();
  const [rationale, setRationale] = useState(""), [confirmed, setConfirmed] = useState(false), [pending, setPending] = useState(false), [error, setError] = useState<string | null>(null);
  async function rollback() {
    setPending(true); setError(null);
    const result = await sendJson("/api/accuracy/claims/split/rollback", "POST", { workspace_id: workspaceId, operation_id: operation.id, rationale });
    setPending(false);
    if (!result.ok) {
      setError(result.json.code === "rollback_blocked"
        ? `${result.error} Later human decisions are preserved. Review the child decisions and use a new edit; this split cannot safely be reversed.`
        : `${result.error} Reload operation history before retrying; the rollback result could not be confirmed.`);
      return;
    }
    router.refresh();
  }
  return <article data-testid={`split-operation-${operation.id}`} className="grid gap-2 border border-border p-3 text-[12px]">
    <p>{operation.state} · {operation.created_at} · {operation.actor.name} · {operation.rationale}</p>
    <p>Parent {operation.parent_gap_id} → addressed {operation.addressed_gap_id} + residual {operation.open_residual_gap_id}</p>
    {operation.state === "applied" ? <>
      <label className="grid gap-1">Rollback rationale (required)<textarea className={inputClass} value={rationale} onChange={e => setRationale(e.target.value)} /></label>
      <label className="flex gap-2"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />Restore the original parent and retire these children if no later decisions exist.</label>
      <button className={buttonClass} type="button" disabled={pending || !confirmed || rationale.trim().length < 3} onClick={() => void rollback()}>{pending ? "Checking…" : "Rollback split"}</button>
    </> : <p>Rolled back at {operation.rolled_back_at}; original parent restored.</p>}
    {error ? <p role="alert" className="text-destructive">{error}</p> : null}
  </article>;
}
