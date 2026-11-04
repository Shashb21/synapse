/** Execution spending controls are independent of immutable model settings and outputs. */
"use client";

import { developmentStyles as styles } from "./development-styles";
import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { CostControls, CostAction } from '@/modules/development/cost-schema';
import type { CostAccountSummary } from '@/modules/development/cost-store';
import type { CostEstimate } from '@/modules/development/cost';

/** Preserve unknown values instead of presenting them as free requests. */
function dollars(value: number | null) { return value === null ? 'unknown' : `USD ${value}`; }

/** Show a provider-free preview with explicit uncertainty and category coverage. */
export function CostPreview({ root, evaluationOnly = false, mode = 'standard' }: { root: string; evaluationOnly?: boolean; mode?: 'standard' | 'single_pass' }) {
  const previewStatusId = useId();
  const [estimate, setEstimate] = useState<CostEstimate | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [previewKey, setPreviewKey] = useState('');
  const key = `${root}:${mode}:${evaluationOnly}`;
  async function preview() {
    setPending(true); setError(''); setEstimate(null);
    try {
      const response = await fetch(`${root}/cost-estimate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode, evaluation_only: evaluationOnly }), cache: 'no-store' });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? 'Unable to preview cost. Try preview again.');
      setEstimate(body.estimate); setPreviewKey(key);
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Unable to preview cost.'); }
    finally { setPending(false); }
  }
  return <div className="space-y-2">
    <Button className="h-auto min-h-8 max-w-full whitespace-normal py-1" variant="outline" aria-describedby={previewStatusId} disabled={pending} onClick={() => void preview()}>Preview {evaluationOnly ? 'evaluation' : 'generation'} cost</Button>
    <p id={previewStatusId}>{pending ? "Loading cost preview…" : "Preview uses no provider calls."}</p>
    {error && <p role="alert" className="text-destructive">{error}</p>}
    {estimate && previewKey === key && <div aria-live="polite" className="space-y-2"><p>Estimated total: {dollars(estimate.total_usd)}</p>{estimate.uncertainty.map(reason => <p key={reason}>{reason}</p>)}<p>One HTTP attempt per raw request. Unknown charges can exceed the allowance.</p><details><summary>Estimate categories</summary>{estimate.categories.map(item => <p key={item.category}>{item.category}: {item.calls_min}–{item.calls_max ?? 'unknown'} calls · {dollars(item.cost_usd)} · {item.reason}</p>)}</details></div>}
  </div>;
}

/** Edit explicit start authorization; unchecked unknown charges remain unauthorized. */
export function CostStartFields({ value, onChange, evaluation = false }: { value: CostControls; onChange: (value: CostControls) => void; evaluation?: boolean }) {
  return <fieldset className="space-y-4 border-t border-border pt-3"><legend className={styles.subsection}>{evaluation ? 'Evaluation spending' : 'Generation spending'}</legend>
    <label className={styles.label}>{evaluation ? 'Additional evaluation allowance (USD)' : 'Generation allowance (USD)'}<Input className="text-sm font-normal" type="number" min="0" step="any" value={Number.isNaN(value.allowance_usd) ? '' : value.allowance_usd} onChange={event => onChange({ ...value, allowance_usd: event.target.value === '' ? Number.NaN : Number(event.target.value) })} /></label>
    {evaluation && <p className={styles.explanation}>This adds to the selected execution’s shared generation and evaluation allowance. An existing pause requires Resume spending.</p>}
    <label className="flex min-w-0 items-start gap-2 text-sm font-medium"><input type="checkbox" checked={value.unknown_acknowledged} onChange={event => onChange({ ...value, unknown_acknowledged: event.target.checked })} />I acknowledge unknown provider charges for {evaluation ? 'the currently open' : 'this new'} execution, which may exceed its allowance.</label>
    <p className={styles.explanation}>{evaluation ? "Unknown-cost requests require acknowledgment on this execution’s account; an existing acknowledgment remains valid. Zero additional allowance leaves the current allowance unchanged." : "Without this acknowledgment, requests with unknown cost pause before spending. Zero allowance also pauses spending."}</p>
  </fieldset>;
}

/** Display saved accounting separately from estimates and append-only owner reports. */
export function DevelopmentCosts({ root, account, onChange, disabled }: { root: string; account: CostAccountSummary | null | undefined; onChange: (account: CostAccountSummary) => void; disabled: boolean }) {
  const [increase, setIncrease] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  async function act(action: CostAction) {
    setPending(true); setError('');
    try {
      const response = await fetch(root, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(action), cache: 'no-store' });
      const body = await response.json();
      if (!response.ok) { setError(body.error ?? 'Unable to save spending action. Reload history before retrying.'); return; }
      onChange(body.account);
    } catch (failure) { setError(`${failure instanceof Error ? failure.message : 'Unable to read the spending response.'} The action may have been saved. Reload history before retrying.`); }
    finally { setPending(false); }
  }
  function report() {
    if (!amount.trim() || !Number.isFinite(Number(amount)) || Number(amount) < 0) { setError('Enter a finite nonnegative reported amount.'); return; }
    if (!Intl.supportedValuesOf('currency').includes(currency)) { setError('Enter a supported ISO currency, such as USD or GBP.'); return; }
    void act({ action: 'report', amount: Number(amount), currency, note });
  }
  if (!account) return <p>Historical spending data unavailable. Saved outputs remain available.</p>;
  return <section aria-label="Execution spending" className="space-y-4 border-t border-border pt-6">
    <h5 className={styles.subsection}>Execution spending</h5>
    <p aria-live="polite">{account.paused ? `Spending paused: ${account.pause_reason ?? 'Paused by owner.'}` : 'Spending authorized'}</p>
    <p>Allowance: {dollars(account.allowance_usd)}</p><p>Allowance override: {account.override_enabled ? 'enabled' : 'disabled'} · Unknown charges: {account.unknown_acknowledged ? 'acknowledged for this execution' : 'not acknowledged'}</p>
    <p>Saved estimated total: {dollars(account.estimate.total_usd)}</p>
    {account.estimate.uncertainty.map(reason => <p key={reason}>{reason}</p>)}
    <p>Generation known usage: {dollars(account.generation_usage_usd)}</p><p>Evaluation known usage: {dollars(account.evaluation_usage_usd)}</p>
    <p>Unknown usage calls: {account.unknown_usage_calls} · Unknown active reservations: {account.unknown_active_reservations} · Known reserved: {dollars(account.reserved_usd)}</p>
    <p className={styles.explanation}>Known usage is a subtotal; unknown charges can exceed the allowance.</p>
    {error && <p role="alert" className="text-destructive">{error}</p>}
    <p id="spending-lock">{pending ? "Saving spending action…" : disabled ? "Save or refresh the experiment before changing spending." : "Spending actions are available."}</p>
    <fieldset disabled={pending || disabled} aria-describedby="spending-lock" className="min-w-0 space-y-4"><legend className={styles.subsection}>Spending actions</legend>
      <label className={styles.label}>Increase allowance (USD)<Input className="text-sm font-normal" type="number" min="0" step="any" value={increase} onChange={event => setIncrease(event.target.value)} /></label>
      <div className="flex flex-wrap gap-2"><Button className="h-auto min-h-8 max-w-full whitespace-normal py-1" variant="outline" onClick={() => { if (!increase.trim() || !Number.isFinite(Number(increase)) || Number(increase) <= 0) { setError('Enter a finite positive allowance increase.'); return; } void act({ action: 'increase', amount_usd: Number(increase) }); }}>Increase allowance</Button>
      <Button className="h-auto min-h-8 max-w-full whitespace-normal py-1" variant="outline" onClick={() => void act({ action: 'override', enabled: !account.override_enabled })}>{account.override_enabled ? 'Disable' : 'Enable'} allowance override</Button>
      {!account.unknown_acknowledged && <Button className="h-auto min-h-8 max-w-full whitespace-normal py-1" variant="outline" onClick={() => void act({ action: 'acknowledge_unknown' })}>Acknowledge unknown charges for this execution</Button>}
      <Button className="h-auto min-h-8 max-w-full whitespace-normal py-1" onClick={() => void act({ action: account.paused ? 'resume' : 'pause' })}>{account.paused ? 'Resume spending' : 'Pause spending'}</Button></div>
      <p className={styles.explanation}>Increasing, overriding or acknowledging does not resume spending. Resume explicitly after reviewing the pause. Override removes the allowance check. Uncertain sends cannot be resumed.</p>
    </fieldset>
    <p>Owner-reported total: {account.reported_total ? `${account.reported_total.currency} ${account.reported_total.amount}` : 'not reported'}</p>
    <p className={styles.explanation}>Owner reports are not verified provider billing. Execution totals are not allocated to sections.</p>
    <fieldset disabled={pending || disabled} aria-describedby="spending-lock" className="min-w-0 space-y-4"><legend className={styles.subsection}>Report or correct total after generation and evaluation finish</legend>
      <label className={styles.label}>Reported total amount<Input className="text-sm font-normal" type="number" step="any" value={amount} onChange={event => setAmount(event.target.value)} /></label>
      <label className={styles.label}>Reported currency<Input className="text-sm font-normal" value={currency} onChange={event => setCurrency(event.target.value)} /></label>
      <label className={styles.label}>Correction note<Input className="text-sm font-normal" maxLength={2000} value={note} onChange={event => setNote(event.target.value)} /></label>
      <Button className="h-auto min-h-8 max-w-full whitespace-normal py-1" variant="outline" onClick={report}>Save reported total</Button>
    </fieldset>
    <details><summary className="cursor-pointer [overflow-wrap:anywhere]">Spending action and correction history</summary>{account.events.length ? account.events.map(event => <p key={event.id} className="[overflow-wrap:anywhere]">{event.at} · {event.actor} · {event.action} · {JSON.stringify(event.detail)}</p>) : <p>No owner actions recorded.</p>}</details>
  </section>;
}
