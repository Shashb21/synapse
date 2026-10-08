"use client";

/** Labeled contributor changes with explicit reasons and source-backed evidence. */
import { useState } from "react";
import type { ResolvedAssemblyItem } from "@/accuracy/domain/assembly";
import type { AssemblyRevisionChange } from "@/accuracy/domain/assembly-revision";
import type { ProvenanceSpan } from "@/accuracy/store/quote-validator";
import { Button } from "@/components/ui/button";
import { TACTIC_STATUSES, TACTIC_TYPES, TACTIC_TYPE_LABELS, type TacticStatus, type TacticType } from "@/lib/iegp/enums";

export type RevisionEvidenceBlock = { id: string; source_file_id: string; text: string };
export type RevisionFormTarget =
  | { action: "add"; claimType: "gap" | "tactic" }
  | { action: "edit" | "remove"; item: ResolvedAssemblyItem };

type RevisionFormProps = {
  target: RevisionFormTarget;
  sourceIds: string[];
  evidenceBlocks: RevisionEvidenceBlock[];
  disabled: boolean;
  onSave: (change: AssemblyRevisionChange) => void;
  onCancel: () => void;
};
const inputClass = "border border-border bg-background p-2 text-foreground";

/** Author one reasoned change; item identity and lineage remain server-owned. */
export function AssemblyRevisionForm({ target, sourceIds, evidenceBlocks, disabled, onSave, onCancel }: RevisionFormProps) {
  const item = target.action === "add" ? null : target.item;
  const claimType = target.action === "add" ? target.claimType : target.item.claim_type;
  const payload = item?.payload;
  const [reason, setReason] = useState("");
  const [sourceId, setSourceId] = useState(item?.source_file_id ?? sourceIds[0] ?? "");
  const [statement, setStatement] = useState(typeof payload?.statement === "string" ? payload.statement : "");
  const [externalId, setExternalId] = useState<string | null>(typeof payload?.external_id === "string" ? payload.external_id : null);
  const [name, setName] = useState(typeof payload?.name === "string" ? payload.name : "");
  const [type, setType] = useState(typeof payload?.type === "string" ? payload.type : "");
  const [status, setStatus] = useState(typeof payload?.status === "string" ? payload.status : "");
  const [question, setQuestion] = useState(typeof payload?.evidence_question === "string" ? payload.evidence_question : "");
  // Clone every stored span, including optional character offsets. Never collapse to the first quote.
  const [spans, setSpans] = useState<ProvenanceSpan[]>(() => Array.isArray(payload?.provenance)
    ? (payload.provenance as ProvenanceSpan[]).map(span => ({ ...span }))
    : [{ source_file_id: sourceId, block_id: "", quote: "" }]);
  const blocks = evidenceBlocks.filter(block => block.source_file_id === sourceId);
  const validEvidence = spans.length > 0 && spans.every(span => {
    const block = blocks.find(candidate => candidate.id === span.block_id && candidate.source_file_id === span.source_file_id);
    return block && span.quote.trim() && block.text.replace(/\s+/g, " ").includes(span.quote.trim().replace(/\s+/g, " "));
  });
  const validContent = claimType === "gap" ? Boolean(statement.trim())
    : Boolean(name.trim() && question.trim() && TACTIC_TYPES.includes(type as TacticType) && TACTIC_STATUSES.includes(status as TacticStatus));
  const canSave = !disabled && Boolean(reason.trim()) && (target.action === "remove" || Boolean(sourceId && validContent && validEvidence));

  function updateSpan(index: number, field: "block_id" | "quote", value: string) {
    setSpans(current => current.map((span, position) => {
      if (position !== index) return span;
      // Offsets describe the old quote. A changed quote/block needs a new range, so omit old offsets.
      return { source_file_id: sourceId, block_id: field === "block_id" ? value : span.block_id, quote: field === "quote" ? value : "" };
    }));
  }

  function save() {
    if (!canSave) return;
    if (target.action === "remove") {
      onSave({ action: "remove", item_version_id: target.item.id, reason: reason.trim() });
      return;
    }
    const content = claimType === "gap"
      ? { claim_type: "gap" as const, source_file_id: sourceId, payload: { statement, external_id: externalId, provenance: spans } }
      : { claim_type: "tactic" as const, source_file_id: sourceId, payload: { name, type: type as TacticType, status: status as TacticStatus, evidence_question: question, origin: "inventory" as const, provenance: spans } };
    onSave(target.action === "add" ? { action: "add", reason: reason.trim(), content }
      : { action: "edit", item_version_id: target.item.id, reason: reason.trim(), content });
  }

  return (
    <form className="grid gap-3 border-t border-border pt-3" aria-label={`${target.action} ${claimType} revision`} onSubmit={event => { event.preventDefault(); save(); }}>
      <p className="font-medium">{target.action === "add" ? "Add" : target.action === "edit" ? "Edit" : "Remove"} {claimType}{item ? ` ${item.id}` : ""}</p>
      {target.action === "remove" ? <p className="text-muted-foreground">Remove this item from the successor proposal. History is retained, and the successor requires fresh approval.</p> : null}
      <label className="grid gap-1"><span>Reason for change</span>
        <textarea className={inputClass} required disabled={disabled} value={reason} onInput={event => setReason(event.currentTarget.value)} onChange={event => setReason(event.currentTarget.value)} />
      </label>
      {target.action !== "remove" ? (
        <>
          <label className="grid gap-1"><span>Source file</span>
            <select className={inputClass} value={sourceId} required disabled={disabled || target.action === "edit"} onChange={event => {
              const nextSource = event.currentTarget.value;
              setSourceId(nextSource); setSpans([{ source_file_id: nextSource, block_id: "", quote: "" }]);
            }}>
              <option value="">Select a source</option>
              {sourceIds.map(id => <option value={id} key={id}>{id}</option>)}
            </select>
          </label>
          {claimType === "gap" ? (
            <>
              <label className="grid gap-1"><span>Gap statement</span><textarea className={inputClass} value={statement} required disabled={disabled} onInput={event => setStatement(event.currentTarget.value)} onChange={event => setStatement(event.currentTarget.value)} /></label>
              <label className="grid gap-1"><span>External ID (optional)</span><input className={inputClass} value={externalId ?? ""} disabled={disabled} onInput={event => setExternalId(event.currentTarget.value || null)} onChange={event => setExternalId(event.currentTarget.value || null)} /></label>
            </>
          ) : (
            <>
              <label className="grid gap-1"><span>Tactic name</span><input className={inputClass} value={name} required disabled={disabled} onInput={event => setName(event.currentTarget.value)} onChange={event => setName(event.currentTarget.value)} /></label>
              <label className="grid gap-1"><span>Tactic type</span><select className={inputClass} value={type} required disabled={disabled} onChange={event => setType(event.currentTarget.value)}><option value="">Select a tactic type</option>{TACTIC_TYPES.map(value => <option key={value} value={value}>{TACTIC_TYPE_LABELS[value]}</option>)}</select></label>
              <label className="grid gap-1"><span>Tactic status</span><select className={inputClass} value={status} required disabled={disabled} onChange={event => setStatus(event.currentTarget.value)}><option value="">Select a tactic status</option>{TACTIC_STATUSES.map(value => <option key={value} value={value}>{value[0].toUpperCase() + value.slice(1)}</option>)}</select></label>
              <label className="grid gap-1"><span>Evidence question</span><textarea className={inputClass} value={question} required disabled={disabled} onInput={event => setQuestion(event.currentTarget.value)} onChange={event => setQuestion(event.currentTarget.value)} /></label>
            </>
          )}
          <fieldset className="grid gap-3" disabled={disabled}>
            <legend className="mb-2 font-medium">Evidence</legend>
            <p className="text-muted-foreground">Choose a source block and copy the supporting quote. All existing quotes are retained unless you change or remove them.</p>
            {spans.map((span, index) => {
              const selectedBlock = blocks.find(block => block.id === span.block_id);
              return <div key={index} className="grid gap-2 border border-border p-2">
                <label className="grid gap-1"><span>Evidence block {index + 1}</span>
                  <select className={inputClass} value={span.block_id} required onChange={event => updateSpan(index, "block_id", event.currentTarget.value)}>
                    <option value="">Select a block</option>
                    {!selectedBlock && span.block_id ? <option value={span.block_id}>{span.block_id} (unavailable)</option> : null}
                    {blocks.map(block => <option value={block.id} key={block.id}>{block.text.slice(0, 120)} ({block.id})</option>)}
                  </select>
                </label>
                {selectedBlock ? <p className="whitespace-pre-wrap break-words text-muted-foreground">Source text: {selectedBlock.text}</p> : <p className="text-muted-foreground">Select an available evidence block.</p>}
                <label className="grid gap-1"><span>Evidence quote {index + 1}</span><textarea className={inputClass} value={span.quote} required onInput={event => updateSpan(index, "quote", event.currentTarget.value)} onChange={event => updateSpan(index, "quote", event.currentTarget.value)} /></label>
                {span.char_start !== undefined || span.char_end !== undefined ? <p className="text-muted-foreground">Original character range: {span.char_start ?? "unspecified"}–{span.char_end ?? "unspecified"}. Changing the quote clears this range.</p> : null}
                <div><Button type="button" size="sm" variant="outline" disabled={disabled || spans.length === 1} onClick={() => setSpans(current => current.filter((_, position) => position !== index))}>Remove evidence quote {index + 1}</Button></div>
              </div>;
            })}
            {!validEvidence ? <p className="text-muted-foreground">Each quote must match text in its selected source block.</p> : null}
            <div><Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => setSpans(current => [...current, { source_file_id: sourceId, block_id: "", quote: "" }])}>Add evidence quote</Button></div>
          </fieldset>
        </>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={!canSave}>Save revision</Button>
        <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={onCancel}>Cancel change</Button>
      </div>
    </form>
  );
}
