/** @vitest-environment jsdom */
/** Behavioral coverage for quiet idle UI and actionable status descriptions. */
import React, { act, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { RouteFields } from '@/components/development/development-route-fields';
import { CostPreview, DevelopmentCosts } from '@/components/development/development-costs';
import type { ExecutionRoute } from '@/modules/development/execution-schema';
import type { ProviderKeyView } from '@/modules/llm/api-keys';
import type { CostAccountSummary } from '@/modules/development/cost-store';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const button = (label: string) => [...container.querySelectorAll('button')].find(item => item.textContent === label)!;
const descriptions = () => {
  for (const element of container.querySelectorAll('[aria-describedby]')) {
    for (const id of element.getAttribute('aria-describedby')!.split(/\s+/)) {
      expect(document.getElementById(id), `Missing description: ${id}`).not.toBeNull();
    }
  }
};
const providers = [
  { provider_id: 'xai-grok', label: 'Grok (xAI)', status: 'missing', auth: 'api_key', models: ['grok'], default_model: 'grok' },
  { provider_id: 'anthropic-claude', label: 'Claude (Anthropic)', status: 'configured', auth: 'api_key', models: ['claude'], default_model: 'claude' },
  { provider_id: 'openai', label: 'OpenAI', status: 'configured', auth: 'api_key', models: ['gpt'], default_model: 'gpt' },
] as ProviderKeyView[];
const route: ExecutionRoute = { provider_id: 'xai-grok', model: 'grok', temperature: 0.2, max_tokens: 1000, fallbacks: ['openai', 'anthropic-claude'] };
const account = {
  paused: false, pause_reason: null, allowance_usd: 5, override_enabled: false, unknown_acknowledged: true,
  estimate: { total_usd: null, uncertainty: ['Prices unavailable'], categories: [] },
  generation_usage_usd: 0.01, evaluation_usage_usd: 0, unknown_usage_calls: 1,
  unknown_active_reservations: 0, reserved_usd: 0, reported_total: null, events: [],
} as unknown as CostAccountSummary;

describe('UI-9 backup provider guidance', () => {
  it('shows readable names in saved order and appends reselected providers', () => {
    function Controls() {
      const [value, setValue] = useState(route);
      return <RouteFields value={value} onChange={setValue} providers={providers} />;
    }
    act(() => root.render(<Controls />));
    expect(container.textContent).toContain('Backup order: OpenAI → Claude (Anthropic)');
    expect(container.textContent).toContain('Selecting a checkbox adds it to the end');
    expect(container.textContent).toContain('request errors do not trigger a backup');
    const openai = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(input => input.closest('label')?.textContent === 'OpenAI')!;
    act(() => openai.click());
    act(() => openai.click());
    expect(container.textContent).toContain('Backup order: Claude (Anthropic) → OpenAI');
  });
});

describe('UI-9 spending status', () => {
  it('hides idle action prose while retaining unknown charges and pause controls', () => {
    act(() => root.render(<DevelopmentCosts root="/costs" account={account} disabled={false} onChange={vi.fn()} />));
    expect(container.querySelector('#spending-lock')).toBeNull();
    expect(container.textContent).not.toContain('Spending actions are available');
    expect(container.textContent).toContain('unknown charges can exceed the allowance');
    expect(button('Pause spending').disabled).toBe(false);
    descriptions();
  });
  it('preserves blocked descriptions, pending status and error recovery', async () => {
    act(() => root.render(<DevelopmentCosts root="/costs" account={{ ...account, paused: true, pause_reason: 'Uncertain send' }} disabled onChange={vi.fn()} />));
    expect(container.querySelector('#spending-lock')?.textContent).toContain('Save or refresh');
    expect(container.textContent).toContain('Spending paused: Uncertain send');
    expect(button('Resume spending').closest('fieldset')?.disabled).toBe(true);
    descriptions();
    act(() => root.render(<DevelopmentCosts root="/costs" account={account} disabled={false} onChange={vi.fn()} />));
    let finish!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })));
    await act(async () => button('Pause spending').click());
    expect(container.querySelector('#spending-lock')?.textContent).toBe('Saving spending action…');
    expect(button('Pause spending').closest('fieldset')?.disabled).toBe(true);
    descriptions();
    await act(async () => finish(Response.json({ error: 'Reload history before retrying.' }, { status: 409 })));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Reload history');
    expect(container.querySelector('#spending-lock')).toBeNull();
    expect(button('Pause spending').closest('fieldset')?.disabled).toBe(false);
    descriptions();
  });
  it('announces a cost preview while pending and keeps provider-free guidance', async () => {
    let fail!: (error: Error) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((_resolve, reject) => { fail = reject; })));
    act(() => root.render(<CostPreview root="/costs" />));
    expect(container.textContent).toContain('Preview uses no provider calls');
    await act(async () => button('Preview generation cost').click());
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Loading cost preview…');
    expect(button('Preview generation cost').disabled).toBe(true);
    descriptions();
    await act(async () => fail(new Error('Try preview again.')));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Try preview again.');
    expect(container.querySelector('[role="status"]')).toBeNull();
    descriptions();
  });
});

import { DevelopmentSetup } from '@/components/development/development-setup';
import { DevelopmentExecution } from '@/components/development/development-execution';
import { DevelopmentEvaluation } from '@/components/development/development-evaluation';
import { DevelopmentComparison } from '@/components/development/development-comparison';
import { balancedProfile } from '@/modules/development/profile-schema';
import { findProvider } from '@/modules/llm/provider';
import type { Experiment } from '@/modules/development/schema';

const draft = { id: 'clarity-draft', name: 'Saved experiment', revision: 1, source_workspace_id: null, documents: [] } as unknown as Experiment;
const sourceDraft = { ...draft, documents: [{ id: 'source', role: 'source', compatibility: 'compatible' }] } as unknown as Experiment;
/** Serve only local fixture data; unexpected paths fail instead of reaching a provider. */
function fixtureFetch() {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url === '/api/control') return Response.json({ provider_keys: providers.map(provider => ({ ...provider, models: findProvider(provider.provider_id)!.models, default_model: findProvider(provider.provider_id)!.default_model })), defaults: { primary: 'openai' } });
    if (url.endsWith('/profiles')) return Response.json({ profiles: [balancedProfile] });
    if (url.endsWith('/evaluations')) return Response.json({ evaluations: [], delivery: { available: true } });
    if (url.endsWith('/executions')) return Response.json({ executions: [], next_cursor: null, history: {}, delivery: { available: true } });
    if (url.endsWith('/demo-documents')) return Response.json({ documents: [] });
    if (url.endsWith('/workspaces')) return Response.json({ workspaces: [] });
    if (url.endsWith('/sources')) return Response.json({ sources: [] });
    if (url === '/api/admin/development') return Response.json({ experiments: [draft] });
    if (url === '/api/admin/development/clarity-draft') return Response.json({ experiment: draft });
    throw new Error(`Unexpected fixture request: ${url}`);
  });
}
/** Change a controlled text input through its native value setter. */
function inputValue(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('UI-9 setup and execution status', () => {
  it('suppresses ready/no-change setup prose and retains dirty and stale blockers', async () => {
    const fetch = fixtureFetch();
    vi.stubGlobal('fetch', fetch);
    await act(async () => root.render(<DevelopmentSetup />));
    expect(container.querySelector('#create-reason')?.textContent).toContain('Enter a name');
    act(() => [...container.querySelectorAll('summary')].find(item => item.textContent === 'New experiment')!.click());
    const newName = container.querySelector<HTMLInputElement>('input[maxlength="120"]')!;
    act(() => inputValue(newName, 'New experiment'));
    expect(container.querySelector('#create-reason')).toBeNull();
    descriptions();
    await act(async () => button('Saved experiment').click());
    expect(container.querySelector('#document-lock')).toBeNull();
    expect(container.querySelector('#save-name-reason')).toBeNull();
    expect(container.textContent).not.toContain('No name changes to save');
    expect(container.textContent).not.toContain('Document actions are available');
    descriptions();
    act(() => button('Rename').click());
    const name = [...container.querySelectorAll<HTMLInputElement>('input[maxlength="120"]')].at(-1)!;
    act(() => inputValue(name, 'Edited name'));
    expect(button('Saved experiment').disabled).toBe(true);
    expect(button('Create experiment').disabled).toBe(true);
    expect(container.querySelector('#experiment-lock')?.textContent).toContain('Save the edited name');
    fetch.mockImplementationOnce(async () => Response.json({ code: 'stale_revision' }, { status: 409 }));
    await act(async () => button('Save name').click());
    expect(container.querySelector('#save-name-reason')?.textContent).toContain('Reload');
    expect(container.querySelector('#document-lock')?.textContent).toContain('Reload');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('edited name will be kept');
    expect(name.value).toBe('Edited name');
    descriptions();
  });
  it('hides ready generation/history status but shows source blockers with valid descriptions', async () => {
    vi.stubGlobal('fetch', fixtureFetch());
    const props = { disabled: false, step: 'run' as const, onNavigate: vi.fn(), onStaleRevision: vi.fn(), onWorkflowChange: vi.fn() };
    await act(async () => root.render(<DevelopmentExecution draft={sourceDraft} {...props} />));
    expect(button('Run all sections').disabled).toBe(false);
    expect(container.querySelector('#run-readiness')).toBeNull();
    expect(container.querySelector('#history-action-status')).toBeNull();
    expect(container.textContent).not.toContain('Ready to run all sections');
    descriptions();
    await act(async () => root.render(<DevelopmentExecution draft={draft} {...props} />));
    expect(button('Run all sections').disabled).toBe(true);
    expect(container.querySelector('#run-readiness')?.textContent).toContain('Add a source snapshot');
    expect(button('Run all sections').getAttribute('aria-describedby')).toBe('run-readiness');
    descriptions();
  });
});

describe('UI-9 evaluation status', () => {
  it('hides idle lock/history prose, preserves pending/error feedback, and defines profiles locally', async () => {
    const fetch = fixtureFetch();
    vi.stubGlobal('fetch', fetch);
    const props = { draft, providers, onHistoryChange: vi.fn() };
    await act(async () => root.render(<DevelopmentEvaluation {...props} disabled={false} />));
    expect(container.querySelector('#evaluation-lock')).toBeNull();
    expect(container.querySelector('#evaluation-history-status')).toBeNull();
    expect(container.querySelector('#profile-help')?.textContent).toContain('scoring anchors');
    expect(container.textContent).toContain('Assess a saved output without generating it again.');
    descriptions();
    await act(async () => root.render(<DevelopmentEvaluation {...props} disabled />));
    expect(container.querySelector('#evaluation-lock')?.textContent).toContain('save or refresh');
    descriptions();
    let fail!: (error: Error) => void;
    fetch.mockImplementationOnce(() => new Promise<Response>((_resolve, reject) => { fail = reject; }));
    await act(async () => button('Reload evaluation data').click());
    expect(container.querySelector('#evaluation-history-status')?.textContent).toContain('Wait');
    expect(button('Reload evaluation data').disabled).toBe(true);
    descriptions();
    await act(async () => fail(new Error('Reload fixture failed')));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Reload fixture failed');
    expect(container.querySelector('#evaluation-history-status')).toBeNull();
    expect(button('Reload evaluation data').disabled).toBe(false);
    descriptions();
  });
});

describe('UI-9 comparison history status', () => {
  it('hides routine availability and retains pending descriptions and retry after failure', async () => {
    const fetch = fixtureFetch();
    fetch.mockImplementation(async input => {
      const url = String(input);
      if (url === '/api/admin/development') return Response.json({ experiments: [draft] });
      if (url.endsWith('/executions')) return Response.json({ executions: [], next_cursor: 'older' });
      throw new Error(`Unexpected fixture request: ${url}`);
    });
    vi.stubGlobal('fetch', fetch);
    await act(async () => root.render(<DevelopmentComparison onCopy={vi.fn()} />));
    await act(async () => {
      const select = container.querySelector('select')!;
      select.value = draft.id;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(container.querySelector('#comparison-Left-status')).toBeNull();
    expect(container.textContent).not.toContain('Older executions are available');
    expect(button('Load older left executions').disabled).toBe(false);
    descriptions();
    let fail!: (error: Error) => void;
    fetch.mockImplementationOnce(() => new Promise<Response>((_resolve, reject) => { fail = reject; }));
    await act(async () => button('Load older left executions').click());
    expect(container.querySelector('#comparison-Left-status')?.getAttribute('role')).toBe('status');
    expect(container.querySelector('#comparison-Left-status')?.textContent).toBe('Loading older executions…');
    expect(button('Load older left executions').disabled).toBe(true);
    descriptions();
    await act(async () => fail(new Error('Reload older history.')));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Reload older history.');
    expect(container.querySelector('#comparison-Left-status')).toBeNull();
    expect(button('Load older left executions').disabled).toBe(false);
    descriptions();
  });
});
