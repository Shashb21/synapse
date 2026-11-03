import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DevelopmentResults } from '@/components/development/development-results';
import { presentationReason } from '@/components/development/development-presentation';
import type { SectionAttempt } from '@/modules/development/execution-store';

const saved = (status: string, result: unknown = null) => ({ section: 'gap_extraction', status, result }) as SectionAttempt;
describe('UI-6 saved results', () => {
  it.each(['queued', 'running', 'failed', 'cancelled'])('does not claim generated output for %s without a result', status => {
    const html = renderToStaticMarkup(<DevelopmentResults attempt={saved(status)} />);
    expect(html).not.toContain('Generated output: unreviewed');
    expect(html).toContain('No saved output');
    expect(html).toContain(status);
  });
  it('prioritizes statement and rationale, escapes prose, and discloses technical fields', () => {
    const html = renderToStaticMarkup(<DevelopmentResults attempt={saved('succeeded', { candidates: [{ id: 'technical-id', statement: '<b>Need evidence</b>', rationale: 'Why it matters', dimensions: { population: 'Adults' } }], output: {} })} />);
    expect(html.indexOf('&lt;b&gt;Need evidence')).toBeLessThan(html.indexOf('technical-id'));
    expect(html).toContain('Technical fields');
    expect(html).toContain('Population');
    expect(html).not.toContain('<b>Need evidence');
    expect(html).toContain('unreviewed');
  });
  it.each([['source_changed', 'Source documents changed'], ['profile_changed', 'Evaluation criteria changed'], ['references_changed', 'Gold standard references changed'], ['gap_extraction:source_changed', 'gap extraction: Source documents changed'], ['left_source_content', 'Left: Source document content'], ['right_profile_version', 'Right: Evaluation profile version'], ['future_reason', 'future reason']])('explains %s', (code, words) => {
    expect(presentationReason(code)).toBe(words);
  });
});

import { EvaluationDetail } from '@/components/development/development-evaluation';
import type { Evaluation } from '@/modules/development/evaluation-store';
const evaluation = (status: string): Evaluation => ({
  id: 'saved-evaluation', status, error: status === 'failed' ? 'Evaluator unavailable' : null,
  manifest: { section: 'gap_extraction', execution_id: 'saved-run', attempt_id: 'saved-attempt', output_id: 'frozen-output',
    profile: { id: 'profile', name: 'Original criteria', version: 1 }, config: { sections: { gap_extraction: { method: 'reference', route: { provider_id: 'openai', model: 'saved-evaluator' } } } },
    route: null, criteria: [], sources: [], references: [] },
  result: status === 'succeeded' ? { checks: { passed: true, items: [] }, rubric: null,
    reference: { status: 'unscored', reasons: ['No reviewed references'], precision: { numerator: 0, denominator: 0, value: null }, recall: { numerator: 0, denominator: 0, value: null }, matches: [], unmatched_output_ids: [], unmatched_reference_ids: [] } } : null,
}) as unknown as Evaluation;
describe('UI-6 optional saved evaluation', () => {
  it.each(['queued', 'running', 'failed', 'succeeded'])('distinguishes evaluation %s from generation', status => {
    const html = renderToStaticMarkup(<EvaluationDetail evaluation={evaluation(status)} />);
    expect(html).toContain(`Evaluation status: ${status}`);
    expect(html).toContain('Original criteria');
    expect(html).toContain('saved-evaluator');
    expect(html).toContain('frozen-output');
    if (status === 'failed') expect(html).toContain('Evaluator unavailable');
    if (status === 'queued' || status === 'running') expect(html).toContain('Waiting for durable worker progress');
  });
  it('preserves frozen evidence and leaves zero denominators unscored', () => {
    const savedEvaluation = evaluation('succeeded');
    const before = JSON.stringify(savedEvaluation);
    const html = renderToStaticMarkup(<EvaluationDetail evaluation={savedEvaluation} />);
    expect(html).toContain('unscored (0/0)');
    expect(html).not.toContain('100.0%');
    expect(html).toContain('Factual checks: passed');
    expect(html).toContain('Provisional AI assessment: not requested');
    expect(html).toContain('Frozen profile, configuration and output');
    expect(JSON.stringify(savedEvaluation)).toBe(before);
  });
});


describe('UI-6 saved evaluation cost visibility', () => {
  it.each([
    ['unknown receipt', { receipt: { cost_usd: null } }, 'Evaluation cost: unknown'],
    ['known zero receipt', { receipt: { cost_usd: 0 } }, 'Evaluation usage-derived cost: $0.000000'],
    ['known failure cost', { failure_accounting: { cost_usd: 0.0123 } }, 'Evaluation usage-derived cost: $0.012300'],
    ['unknown failure cost', { failure_accounting: { cost_usd: null } }, 'Evaluation cost: unknown'],
    ['uncertain dispatch', { status: 'needs_attention', sending_at: '2026-11-03' }, 'Evaluation cost: unknown'],
    ['pending provider work', { status: 'queued' }, 'Evaluation cost: pending'],
    ['unsent failure', { status: 'failed', sending_at: null }, 'No provider call was sent'],
  ])('keeps %s visible with receipt details closed', (_name, evidence, message) => {
    const savedEvaluation = { ...evaluation('succeeded'), ...evidence } as Evaluation;
    const html = renderToStaticMarkup(<EvaluationDetail evaluation={savedEvaluation} />);
    expect(html.split('<details>')[0]).toContain(message);
    expect(html).toContain('Evaluator receipt, trace and usage');
  });

  it.each(['succeeded', 'queued'])('distinguishes %s reference evaluation without a provider request from unknown legacy evidence', status => {
    const savedEvaluation = evaluation(status);
    savedEvaluation.manifest.request = null;
    const html = renderToStaticMarkup(<EvaluationDetail evaluation={savedEvaluation} />);
    expect(html.split('<details>')[0]).toContain('No provider call is needed for this saved evaluation');
    if (status === 'succeeded') expect(html).toContain('unscored (0/0)');
    const legacy = renderToStaticMarkup(<EvaluationDetail evaluation={evaluation('succeeded')} />);
    expect(legacy.split('<details>')[0]).toContain('Evaluation cost: unknown');
  });

  it('distinguishes checks-only work from an unknown provider charge', () => {
    const savedEvaluation = evaluation('succeeded');
    savedEvaluation.manifest.config.sections.gap_extraction.method = 'checks_only';
    const html = renderToStaticMarkup(<EvaluationDetail evaluation={savedEvaluation} />);
    expect(html.split('<details>')[0]).toContain('No provider call is needed for factual checks only');
    expect(html).not.toContain('Evaluation cost: unknown');
  });
});
