/** Owner-only saved experiment comparison with request-bound result publication. */
'use client';
import React, { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { routeSelectClass } from './development-route-fields';
import type { Experiment } from '@/modules/development/schema';
import type { Execution } from '@/modules/development/execution-store';
import type { ComparisonResult, ComparisonCompatibility } from '@/modules/development/comparison';
import { CallEvidence, DevelopmentResults } from './development-results';
import { EvaluationDetail } from './development-evaluation';

/** Display every blocker and unknown independently of permitted varying factors. */
function Compatibility({ value }: { value: ComparisonCompatibility }) {
  return <div className="space-y-1"><p>{value.controlled ? 'Inputs and evaluation settings match for controlled comparison.' : 'Quality comparison is not controlled.'}</p><p>Differences: {value.blockers.join(', ') || 'none recorded'}</p><p>Missing evidence: {value.missing_evidence.join(', ') || 'none recorded'}</p><p>Varying factors: {value.varying_factors.join(', ') || 'none recorded'}</p></div>;
}
/** Show configuration differences and exact evaluation-pair compatibility. */
export function ComparisonEvidence({ comparison }: { comparison: ComparisonResult }) {
  return <div className="min-w-0 space-y-3 break-words"><Compatibility value={comparison.compatibility} /><p>{comparison.trial_note} One trial cannot establish statistical superiority.</p>{comparison.sections.map((section) => <details key={section.section} open><summary className="cursor-pointer font-medium">{section.section.replaceAll('_', ' ')}</summary><Compatibility value={section.compatibility} />{section.evaluation_pairs.map((pair) => <div key={`${pair.left_evaluation_id}:${pair.right_evaluation_id}`} className="mt-2 border-t border-border pt-2"><p>Evaluation pair: {pair.left_evaluation_id} / {pair.right_evaluation_id} · Quality evidence: {pair.quality_available ? 'available' : 'unavailable'}</p><Compatibility value={pair.compatibility} /></div>)}</details>)}</div>;
}

/** Load one experiment's paged history; switching experiment unmounts obsolete selectors. */
function SavedSide({ label, experimentId, onSelect }: { label: string; experimentId: string; onSelect: (execution: string) => void }) {
  const [list, setList] = useState<Execution[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [selected, setSelected] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/admin/development/${experimentId}/executions`, { signal: controller.signal, cache: 'no-store' }).then(async response => {
      if (!response.ok) throw new Error('Unable to load saved executions. Select the experiment again to retry.');
      const body = await response.json(); if (!controller.signal.aborted) { setList(body.executions); setCursor(body.next_cursor); }
    }).catch(failure => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, [experimentId]);
  async function older() {
    setPending(true); setError('');
    try { const response = await fetch(`/api/admin/development/${experimentId}/executions?${new URLSearchParams({ cursor: cursor! })}`, { cache: 'no-store' }); if (!response.ok) throw new Error('Unable to load older executions. Retry.'); const body = await response.json(); setList(current => [...current, ...body.executions.filter((item: Execution) => !current.some(old => old.id === item.id))]); setCursor(body.next_cursor); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Unable to load older executions.'); } finally { setPending(false); }
  }
  return <div className="min-w-0 space-y-2"><label className="block">{label} saved execution<select className={routeSelectClass} value={selected} onChange={event => { setSelected(event.target.value); onSelect(event.target.value); }}><option value="">Choose execution</option>{list.map(item => <option key={item.id} value={item.id}>{item.created_at} · {item.generation_status} · {item.id}</option>)}</select></label>{!list.length && !error && <p>No saved executions loaded.</p>}{cursor && <Button variant="outline" disabled={pending} onClick={() => void older()}>Load older {label.toLowerCase()} executions</Button>}{error && <p role="alert">{error}</p>}</div>;
}

/** Compare saved records, hiding any response as soon as its selection changes. */
export function DevelopmentComparison({ onCopy }: { onCopy: (execution: Execution) => void }) {
  const [experiments, setExperiments] = useState<Experiment[]>([]);
  const [selection, setSelection] = useState({ left_experiment_id: '', left_execution_id: '', right_experiment_id: '', right_execution_id: '' });
  const [state, setState] = useState<{ key: string; result?: ComparisonResult; error?: string }>({ key: '' });
  const key = JSON.stringify(selection);
  const complete = Object.values(selection).every(Boolean);
  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/admin/development', { signal: controller.signal, cache: 'no-store' }).then(async response => { if (!response.ok) throw new Error('Unable to load experiments. Reopen this experiment to retry.'); const body = await response.json(); if (!controller.signal.aborted) setExperiments(body.experiments); }).catch(failure => { if (!controller.signal.aborted) setState({ key: '', error: failure.message }); });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (!complete) return;
    const controller = new AbortController();
    void fetch(`/api/admin/development/comparison?${new URLSearchParams(JSON.parse(key))}`, { signal: controller.signal, cache: 'no-store' }).then(async response => { const body = await response.json(); if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : 'Unable to compare saved executions. Choose again to retry.'); if (!controller.signal.aborted) setState({ key, result: body.comparison }); }).catch(failure => { if (!controller.signal.aborted) setState({ key, error: failure.message }); });
    return () => controller.abort();
  }, [key, complete]);
  const result = state.key === key ? state.result : undefined;
  return <section aria-label="Saved comparison" className="min-w-0 space-y-3 border-t border-border pt-4"><h3 className="font-semibold">Compare saved experiments</h3><p>Compare documents, references, profile versions and evaluator settings before interpreting quality. Mode and generation model may intentionally vary.</p><div className="grid min-w-0 gap-3 sm:grid-cols-2">{(['left', 'right'] as const).map(side => { const label = side === 'left' ? 'Left' : 'Right'; return <div key={side} className="min-w-0 space-y-2"><label className="block">{label} experiment<select className={routeSelectClass} value={selection[`${side}_experiment_id`]} onChange={event => setSelection(current => ({ ...current, [`${side}_experiment_id`]: event.target.value, [`${side}_execution_id`]: '' }))}><option value="">Choose experiment</option>{experiments.map(item => <option key={item.id} value={item.id}>{item.name} · {item.id}</option>)}</select></label>{selection[`${side}_experiment_id`] && <SavedSide key={selection[`${side}_experiment_id`]} label={label} experimentId={selection[`${side}_experiment_id`]} onSelect={id => setSelection(current => ({ ...current, [`${side}_execution_id`]: id }))} />}</div>; })}</div>{!complete && <p>Choose two saved executions to compare.</p>}{complete && state.key !== key && <p role="status">Loading comparison…</p>}{state.error && (state.key === key || state.key === '') && <p role="alert">{state.error}</p>}{result && <><ComparisonEvidence comparison={result} /><div className="grid min-w-0 gap-4 lg:grid-cols-2">{(['left', 'right'] as const).map(side => <div key={side} className="min-w-0 space-y-3 break-words"><h4 className="font-medium">{side === 'left' ? 'Left' : 'Right'}: {result[side].execution.id}</h4><p>Mode: {result[side].execution.manifest.config?.mode ?? 'unavailable'}</p><Button variant="outline" onClick={() => onCopy(result[side].execution)}>Copy {side} configuration</Button><details><summary>Frozen configuration and input identities</summary><pre className="whitespace-pre-wrap break-words text-xs">{JSON.stringify(result[side].execution.manifest, null, 2)}</pre></details>{result[side].execution.sections.map(attempt => <details key={attempt.id}><summary>{attempt.section} · {attempt.status} · {attempt.id}</summary><DevelopmentResults attempt={attempt} /></details>)}{(result[side].execution.calls ?? []).map(call => <CallEvidence key={call.id} call={call} />)}{result[side].evaluations.map(evaluation => <details key={evaluation.id}><summary>Evaluation {evaluation.id} · {evaluation.status}</summary><EvaluationDetail evaluation={evaluation} /></details>)}</div>)}</div></>}</section>;
}
