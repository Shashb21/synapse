/** Read-only section evidence. Saved model content is always rendered as text. */
import React from 'react';
import type { ExecutionCall, SectionAttempt } from '@/modules/development/execution-store';
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const rows = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.filter(record) : [];
const text = (value: unknown): string => value === null || value === undefined ? 'unavailable' : typeof value === 'string' ? value : JSON.stringify(value);
const fieldLabels: Record<string, string> = { source_quote: 'Source quotation', document_id: 'Document', source_id: 'Source', statement: 'Evidence need', evidence_question: 'Evidence question', duplicate_of: 'Duplicate of', critic_note: 'Critic explanation', score: 'Generation judge score (not evaluation)', addressed_statement: 'Supported addressed scope', open_statement: 'Complete remaining need', addressed_tactic_ids: 'Addressed tactic references', uncovered_dimensions: 'Uncovered dimensions', parent_gap_id: 'Parent gap', rationale: 'Explanation', references: 'Citations', dimensions: 'Design dimensions', verdict: 'Generation verdict' };

/** Expose each preserved field without interpreting model prose as trusted markup. */
function EvidenceRecord({ value }: { value: Record<string, unknown> }) {
  return <dl className="space-y-1 text-sm">{Object.entries(value).map(([key, item]) => <div key={key} className="break-words"><dt className="inline font-medium">{fieldLabels[key] ?? key.replaceAll('_', ' ')}: </dt><dd className="inline whitespace-pre-wrap">{text(item)}</dd></div>)}</dl>;
}

/** Present per-section candidates, relationships and proposals with retained raw output. */
export function DevelopmentResults({ attempt }: { attempt: SectionAttempt }) {
  const result = attempt.result;
  const output = record(result?.output) ? result.output : {};
  const groups: [string, Record<string, unknown>[]][] = attempt.section === 'partial_splitting'
    ? [['Split proposals', rows(output.proposals)]]
    : attempt.section === 'matching_coverage'
      ? [['Gap relationships', rows(output.rows)], ['Unreviewed candidates', rows(result?.candidates)], ['Rejected', rows(output.rejected)]]
      : [['Unreviewed candidates', rows(result?.candidates)], ['Accepted by generation', rows(output.accepted)], ['Rejected', rows(output.rejected)]];
  return <div className="min-w-0 space-y-3">
    <p>Generated output: unreviewed{result?.reason ? ` · ${result.reason}` : ''}</p>
    {attempt.status === 'not_applicable' ? <p>Not applicable: no eligible partial gap. No quality score is assigned.</p> : <>
      {attempt.section === 'matching_coverage' && <div className="space-y-1"><p>Relevance: inspect each relationship and rationale below; a separate relevance assessment is unavailable unless recorded in evaluation.</p><p>Design fit: inspect design dimensions below; criterion scores appear in saved evaluations.</p><p>Delivered evidence coverage: a relevant or planned tactic is not proof of delivered evidence. Inspect cited evidence and saved coverage evaluation separately.</p></div>}
      {attempt.section === 'partial_splitting' && <p>Assess supported addressed scope, complete remaining need, non-overlap, parent-meaning preservation and valid references separately in the saved evaluation. Unrecorded assessments are unavailable.</p>}
      {!groups.some(([, items]) => items.length) && <p>Structured evidence unavailable or empty. Inspect the retained raw content below.</p>}
      {groups.map(([label, items]) => !!items.length && <div key={label} className="space-y-2"><h4 className="font-medium">{label} ({items.length})</h4>{items.map((item, index) => <details key={index} open className="border-t border-border pt-2"><summary className="cursor-pointer">{text(item.name ?? item.gap_name ?? item.parent_gap_id ?? item.id ?? `Item ${index + 1}`)}</summary><EvidenceRecord value={item} />{rows(item.mappings).map((mapping, mappingIndex) => <div key={mappingIndex} className="mt-2 border-t border-border pt-2"><p className="font-medium">Tactic relationship {mappingIndex + 1}</p><EvidenceRecord value={mapping} /></div>)}</details>)}</div>)}
    </>}
    <details><summary className="cursor-pointer">View generated output</summary><pre className="overflow-x-auto whitespace-pre-wrap break-words text-xs">{text(result ?? null)}</pre></details>
  </div>;
}

/** Show retained call accounting; elapsed time includes provider and receipt settlement. */
export function CallEvidence({ call }: { call: ExecutionCall }) {
  const elapsed = call.sending_at && call.settled_at ? Date.parse(call.settled_at) - Date.parse(call.sending_at) : NaN;
  return <details><summary className="cursor-pointer">Call {call.ordinal}: {call.status}</summary><div className="space-y-1 pt-2 break-words"><p>Role: {call.request?.role ?? "unknown"} · Purpose: {call.request?.purpose ?? "unknown"} · Trace: {call.identity ?? call.id} · LLM call ID: {call.receipt?.llm_call_id ?? "unknown"}</p><p>Sent: {call.sending_at ?? "unknown"} · Settled: {call.settled_at ?? "unknown"}</p><p>Latency: {Number.isFinite(elapsed) && elapsed >= 0 ? `${elapsed} ms (send to settlement)` : "unknown"}</p><p>Cost: {call.receipt?.cost_usd ?? call.failure_accounting?.cost_usd ?? "unknown"} · Price source: {call.receipt?.price_source ?? call.failure_accounting?.price_source ?? "unknown"}</p><p>Usage: {call.receipt?.usage || call.failure_accounting?.usage ? JSON.stringify(call.receipt?.usage ?? call.failure_accounting?.usage) : "unknown"}</p><p>Frozen call route: {call.route ? JSON.stringify(call.route) : "unknown"}</p>{call.error && <p>{call.error}</p>}<pre className="overflow-x-auto whitespace-pre-wrap break-words text-xs">{call.receipt?.text ?? "No response recorded."}</pre></div></details>;
}
