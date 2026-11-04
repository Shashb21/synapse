/** Read-only section evidence. Saved model content is always rendered as text. */
import { developmentStyles as styles } from "./development-styles";
import React from 'react';
import type { ExecutionCall, SectionAttempt } from '@/modules/development/execution-store';
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const rows = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.filter(record) : [];
const text = (value: unknown): string => value === null || value === undefined ? 'unavailable' : typeof value === 'string' ? value : JSON.stringify(value);
const fieldLabels: Record<string, string> = { source_quote: 'Source quotation', document_id: 'Document', source_id: 'Source', statement: 'Evidence need', evidence_question: 'Evidence question', duplicate_of: 'Duplicate of', critic_note: 'Critic explanation', score: 'Generation judge score (not evaluation)', addressed_statement: 'Supported addressed scope', open_statement: 'Complete remaining need', addressed_tactic_ids: 'Addressed tactic references', uncovered_dimensions: 'Uncovered dimensions', parent_gap_id: 'Parent gap', rationale: 'Explanation', references: 'Citations', dimensions: 'Design dimensions', verdict: 'Generation verdict' };

/** Expose each preserved field without interpreting model prose as trusted markup. */
function EvidenceValue({ value }: { value: unknown }) {
  if (record(value)) return <EvidenceRecord value={value} />;
  if (Array.isArray(value)) return <ul className="space-y-2 pl-4">{value.map((item, index) => <li key={index}><EvidenceValue value={item} /></li>)}</ul>;
  return <span className="whitespace-pre-wrap">{text(value)}</span>;
}
function EvidenceRecord({ value }: { value: Record<string, unknown> }) {
  const technical = (key: string) => key === 'id' || key.endsWith('_id') || key.endsWith('_ids');
  const entries = Object.entries(value).filter(([key]) => key !== 'mappings');
  const priority = ['name', 'gap_name', 'statement', 'addressed_statement', 'open_statement', 'rationale'];
  const readable = entries.filter(([key]) => !technical(key)).sort(([a], [b]) => (priority.indexOf(a) < 0 ? 99 : priority.indexOf(a)) - (priority.indexOf(b) < 0 ? 99 : priority.indexOf(b)));
  const fields = (items: [string, unknown][], technicalFields = false) => <dl className={`mt-3 space-y-4 ${technicalFields ? styles.metadata : "text-sm leading-6"}`}>{items.map(([key, item]) => <div key={key} className="min-w-0 [overflow-wrap:anywhere]"><dt className="font-medium">{fieldLabels[key] ?? (key.charAt(0).toUpperCase() + key.slice(1).replaceAll('_', ' '))}</dt><dd className="mt-2 max-w-[65ch]"><EvidenceValue value={item} /></dd></div>)}</dl>;
  return <>{fields(readable)}{entries.some(([key]) => technical(key)) && <details><summary className="cursor-pointer [overflow-wrap:anywhere]">Technical fields</summary>{fields(entries.filter(([key]) => technical(key)), true)}</details>}</>;
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
  return <div className="min-w-0 space-y-6">
    {result && attempt.status !== 'not_applicable' ? <p>Generated output: unreviewed{result.reason ? ` · ${result.reason}` : ''}</p> : attempt.status === 'not_applicable' ? null : <p>Generation status: {attempt.status}. No saved output{attempt.status === 'queued' || attempt.status === 'running' ? ' yet. Waiting for generation progress.' : '. Review the run error and settings before explicitly rerunning.'}</p>}
    {attempt.status === 'not_applicable' ? <p>Not applicable: no eligible partial gap. No quality score is assigned.</p> : result ? <>
      {attempt.section === 'matching_coverage' && <div className="max-w-[65ch] space-y-3 text-sm leading-6 font-normal text-muted-foreground"><p>Relevance: review relationships and rationales; a separate assessment is unavailable unless saved in evaluation.</p><p>Design fit: review dimensions; scores appear in saved evaluations.</p><p>Delivered evidence coverage: a relevant or planned tactic does not prove delivery. Review citations and saved coverage evaluation separately.</p></div>}
      {attempt.section === 'partial_splitting' && <p className={styles.explanation}>Assess supported addressed scope, complete remaining need, non-overlap, parent-meaning preservation and valid references separately in the saved evaluation. Unrecorded assessments are unavailable.</p>}
      {!groups.some(([, items]) => items.length) && <p className={styles.explanation}>Structured evidence unavailable or empty. Inspect the retained raw content below.</p>}
      {groups.map(([label, items]) => !!items.length && <div key={label} className="min-w-0 space-y-3"><h6 className={styles.subsection}>{label} ({items.length})</h6>{items.map((item, index) => <details key={index} className="min-w-0 space-y-3 border-t border-border pt-3"><summary className="cursor-pointer [overflow-wrap:anywhere]">{text(item.name ?? item.gap_name ?? item.statement ?? item.addressed_statement ?? item.parent_gap_id ?? item.id ?? `Item ${index + 1}`)}</summary><EvidenceRecord value={item} />{rows(item.mappings).map((mapping, mappingIndex) => <div key={mappingIndex} className="mt-4 min-w-0 border-t border-border pt-4"><p className="font-medium">Tactic relationship {mappingIndex + 1}</p><EvidenceRecord value={mapping} /></div>)}</details>)}</div>)}
    </> : null}
    {result && <details><summary className="cursor-pointer [overflow-wrap:anywhere]">View generated output</summary><pre className={`${styles.metadata} mt-3 max-w-full overflow-x-auto whitespace-pre-wrap`}>{text(result ?? null)}</pre></details>}
  </div>;
}

/** Show retained call accounting; elapsed time includes provider and receipt settlement. */
export function CallEvidence({ call }: { call: ExecutionCall }) {
  const elapsed = call.sending_at && call.settled_at ? Date.parse(call.settled_at) - Date.parse(call.sending_at) : NaN;
  const cost = call.receipt?.cost_usd ?? call.failure_accounting?.cost_usd;
  return <div>{call.error && <p role="alert">{call.error}</p>}{cost == null && <p>Call {call.ordinal} cost: unknown</p>}<details><summary className="cursor-pointer [overflow-wrap:anywhere]">Call {call.ordinal}: {call.status}</summary><div className={`${styles.metadata} min-w-0 space-y-2 pt-3`}><p>Role: {call.request?.role ?? "unknown"} · Purpose: {call.request?.purpose ?? "unknown"} · Trace: {call.identity ?? call.id} · LLM call ID: {call.receipt?.llm_call_id ?? "unknown"}</p><p>Sent: {call.sending_at ?? "unknown"} · Settled: {call.settled_at ?? "unknown"}</p><p>Latency: {Number.isFinite(elapsed) && elapsed >= 0 ? `${elapsed} ms (send to settlement)` : "unknown"}</p><p>Cost: {call.receipt?.cost_usd ?? call.failure_accounting?.cost_usd ?? "unknown"} · Price source: {call.receipt?.price_source ?? call.failure_accounting?.price_source ?? "unknown"}</p><p>Usage: {call.receipt?.usage || call.failure_accounting?.usage ? JSON.stringify(call.receipt?.usage ?? call.failure_accounting?.usage) : "unknown"}</p><p>Frozen call route: {call.route ? JSON.stringify(call.route) : "unknown"}</p>{call.error && <p>{call.error}</p>}<pre className={`${styles.metadata} mt-3 max-w-full overflow-x-auto whitespace-pre-wrap`}>{call.receipt?.text ?? "No response recorded."}</pre></div></details></div>;
}
