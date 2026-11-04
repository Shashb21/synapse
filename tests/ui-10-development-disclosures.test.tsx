/** @vitest-environment jsdom */
/** Interaction coverage: arrange saved fixtures, act through controls, assert retained evidence and locks. */
import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { DevelopmentSetup } from '@/components/development/development-setup';
import { DevelopmentResults } from '@/components/development/development-results';
import { ComparisonEvidence } from '@/components/development/development-comparison';
import { DevelopmentCosts } from '@/components/development/development-costs';
import type { Experiment } from '@/modules/development/schema';
import type { SectionAttempt } from '@/modules/development/execution-store';
import type { ComparisonResult } from '@/modules/development/comparison';
import type { CostAccountSummary } from '@/modules/development/cost-store';
vi.mock('@/components/development/development-execution', () => ({ DevelopmentExecution: () => null }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const button = (label: string) => [...container.querySelectorAll('button')].find(item => item.textContent === label)!;
const summary = (label: string) => [...container.querySelectorAll('summary')].find(item => item.textContent === label)!;
const input = (label: string) => [...container.querySelectorAll('label')].find(item => item.textContent === label)!.querySelector('input')!;
function change(control: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(control, value);
  control.dispatchEvent(new Event('input', { bubbles: true }));
}
const draft = { id: 'one', name: 'Saved experiment', revision: 1, documents: [] } as unknown as Experiment;
function fixtureFetch(experiments = [draft]) {
  return vi.fn(async (url: string) => {
    if (url.endsWith('/workspaces')) return Response.json({ workspaces: [] });
    if (url.endsWith('/sources')) return Response.json({ sources: [] });
    if (url.endsWith('/demo-documents')) return Response.json({ documents: [] });
    if (url.endsWith('/one')) return Response.json({ experiment: draft });
    return Response.json({ experiments });
  });
}

describe('UI-10 experiment management', () => {
  it('shows creation directly only when empty and focuses an optional new form without losing input or errors', async () => {
    const fetch = fixtureFetch([]); vi.stubGlobal('fetch', fetch);
    await act(async () => root.render(<DevelopmentSetup />));
    expect(summary('New experiment').parentElement!.hasAttribute('open')).toBe(true);
    expect(input('New experiment name').disabled).toBe(false);
    expect(button('Create experiment').disabled).toBe(true);
  });
  it('keeps creation values/errors on closure, blocks closure while busy and focuses the opener after success', async () => {
    const fetch = fixtureFetch(); vi.stubGlobal('fetch', fetch);
    await act(async () => root.render(<DevelopmentSetup />));
    const disclosure = summary('New experiment').parentElement!;
    expect(disclosure.hasAttribute('open')).toBe(false);
    act(() => summary('New experiment').click());
    expect(document.activeElement).toBe(input('New experiment name'));
    act(() => change(input('New experiment name'), 'Useful draft'));
    fetch.mockImplementationOnce(async () => Response.json({ error: 'Name already exists' }, { status: 409 }));
    await act(async () => button('Create experiment').click());
    act(() => summary('New experiment').click());
    expect(disclosure.hasAttribute('open')).toBe(false);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Name already exists');
    act(() => summary('New experiment').click());
    expect(input('New experiment name').value).toBe('Useful draft');
    let resolve!: (value: Response) => void;
    fetch.mockImplementationOnce(() => new Promise<Response>(done => { resolve = done; }));
    await act(async () => button('Create experiment').click());
    act(() => summary('New experiment').click());
    expect(disclosure.hasAttribute('open')).toBe(true);
    await act(async () => resolve(Response.json({ experiment: draft })));
    expect(disclosure.hasAttribute('open')).toBe(false);
    expect(document.activeElement).toBe(summary('New experiment'));
  });
  it('focuses rename, locks switching/creation, cancels explicitly, and preserves edited name through stale reload', async () => {
    const fetch = fixtureFetch(); vi.stubGlobal('fetch', fetch);
    await act(async () => root.render(<DevelopmentSetup />));
    await act(async () => button('Saved experiment').click());
    expect(container.querySelector('#rename-experiment')?.hasAttribute('hidden')).toBe(true);
    act(() => button('Rename').click());
    expect(document.activeElement).toBe(input('Experiment name'));
    act(() => change(input('Experiment name'), 'Edited name'));
    expect(button('Saved experiment').disabled).toBe(true);
    expect(button('Create experiment').disabled).toBe(true);
    act(() => summary('New experiment').click());
    expect(summary('New experiment').parentElement!.hasAttribute('open')).toBe(false);
    act(() => button('Cancel rename').click());
    expect(input('Experiment name').value).toBe(draft.name);
    expect(document.activeElement).toBe(button('Rename'));
    expect(button('Saved experiment').disabled).toBe(false);
    act(() => button('Rename').click());
    act(() => change(input('Experiment name'), 'Keep this name'));
    fetch.mockImplementationOnce(async () => Response.json({ code: 'stale_revision' }, { status: 409 }));
    await act(async () => button('Save name').click());
    expect(button('Save name').disabled).toBe(true);
    await act(async () => button('Reload saved draft').click());
    expect(input('Experiment name').value).toBe('Keep this name');
    expect(button('Save name').disabled).toBe(false);
    fetch.mockImplementationOnce(async () => Response.json({ experiment: { ...draft, name: 'Keep this name', revision: 2 } }));
    await act(async () => button('Save name').click());
    expect(container.querySelector('#rename-experiment')?.hasAttribute('hidden')).toBe(true);
    expect(document.activeElement).toBe(button('Rename'));
  });
});

describe('UI-10 saved evidence', () => {
  it('collapses descriptive records and retains all original fields and raw content', () => {
    const attempt = { section: 'gap_extraction', status: 'succeeded', result: { candidates: [], output: { accepted: [{ name: 'Comparative outcomes', source_quote: 'Exact quote', id: 'record-id', custom_evidence: 'Preserved custom field' }] } } } as unknown as SectionAttempt;
    act(() => root.render(<DevelopmentResults attempt={attempt} />));
    const details = summary('Comparative outcomes').parentElement!;
    expect(details.hasAttribute('open')).toBe(false);
    act(() => summary('Comparative outcomes').click());
    expect(details.hasAttribute('open')).toBe(true);
    expect(details.textContent).toContain('Exact quote');
    expect(details.textContent).toContain('Preserved custom field');
    expect(summary('Technical fields').parentElement!.textContent).toContain('record-id');
    expect(summary('View generated output')).toBeDefined();
  });
  it('shows one overall outcome and populated diagnostics with pair IDs disclosed', () => {
    const compatibility = { controlled: false, blockers: ['source_changed'], missing_evidence: [], varying_factors: [] };
    const comparison = { compatibility, trial_note: 'Single saved trial.', sections: [{ section: 'gap_extraction', compatibility, evaluation_pairs: [{ left_evaluation_id: 'left-id', right_evaluation_id: 'right-id', quality_available: false, compatibility: { ...compatibility, blockers: [], missing_evidence: ['reference_missing'] } }] }] } as unknown as ComparisonResult;
    act(() => root.render(<ComparisonEvidence comparison={comparison} />));
    expect(container.textContent!.match(/Quality comparison is not controlled\./g)).toHaveLength(1);
    expect(container.textContent).not.toContain('none recorded');
    expect(container.textContent).toContain('One trial cannot establish statistical superiority.');
    expect(container.textContent).toContain('Missing evidence:');
    expect(summary('Evaluation pair details').parentElement!.hasAttribute('open')).toBe(false);
    act(() => summary('Evaluation pair details').click());
    expect(summary('Evaluation pair details').parentElement!.textContent).toContain('left-id / right-id');
  });
  it('keeps spending warnings visible and report input/error mounted across closure and busy actions', async () => {
    const account = { paused: true, pause_reason: 'Uncertain send', allowance_usd: 2, override_enabled: true, unknown_acknowledged: false, estimate: { total_usd: null, uncertainty: ['Price unknown'], categories: [] }, generation_usage_usd: 1, evaluation_usage_usd: 0, unknown_usage_calls: 1, unknown_active_reservations: 1, reserved_usd: 0.2, reported_total: null, events: [] } as unknown as CostAccountSummary;
    act(() => root.render(<DevelopmentCosts root="/costs" account={account} disabled={false} onChange={vi.fn()} />));
    expect(summary('Spending details').parentElement!.hasAttribute('open')).toBe(false);
    expect(container.textContent).toContain('Spending paused: Uncertain send');
    expect(container.textContent).toContain('Uncertain sends cannot be resumed');
    expect(container.textContent).toContain('Override removes the allowance check');
    act(() => summary('Report provider total').click());
    act(() => change(input('Reported total amount'), '-1'));
    act(() => button('Save reported total').click());
    act(() => summary('Report provider total').click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('finite nonnegative');
    act(() => summary('Report provider total').click());
    expect(input('Reported total amount').value).toBe('-1');
    act(() => change(input('Reported total amount'), '8'));
    let resolve!: (value: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(done => { resolve = done; })));
    await act(async () => button('Save reported total').click());
    act(() => summary('Report provider total').click());
    expect(summary('Report provider total').parentElement!.hasAttribute('open')).toBe(true);
    await act(async () => resolve(Response.json({ error: 'Check finished evaluation' }, { status: 409 })));
    expect(input('Reported total amount').value).toBe('8');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Check finished evaluation');
  });
});
