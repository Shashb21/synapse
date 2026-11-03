/** Tests for ordered, client-side generation readiness. */
import { describe, expect, it } from 'vitest';
import { executionConfigSchema } from '@/modules/development/execution-schema';
import { generationReadiness } from '@/components/development/development-readiness';

const config = executionConfigSchema.parse({});
const provider = (id: string, status: 'configured' | 'missing') => ({ provider_id: id, status });
const ready = { disabled: false, pending: false, loading: false, historyState: 'ready' as const, deliveryAvailable: true, active: false, hasSources: true, config, providers: [provider(config.stages.gap_extraction.route.provider_id, 'configured')], allowance: 0 };

describe('generation readiness', () => {
  it('orders blockers and clears them as inputs are fixed', () => {
    const result = generationReadiness({ ...ready, disabled: true, hasSources: false, allowance: -1 }, 'all');
    expect(result).toEqual(['Save or refresh the experiment before running.', 'Add a source snapshot in Documents.', 'Enter a finite nonnegative generation allowance.']);
    expect(generationReadiness({ ...ready, hasSources: false }, 'all')[0]).toContain('source');
  });
  it('accepts zero allowance and a configured permitted fallback', () => {
    const primary = config.stages.gap_extraction.route.provider_id;
    const fallback = config.stages.gap_extraction.route.fallbacks[0];
    const providers = [provider(primary, 'missing'), provider(fallback, 'configured')];
    expect(generationReadiness({ ...ready, providers }, 'all')).toEqual([]);
  });
  it('distinguishes loading, unavailable history, delivery and active work', () => {
    expect(generationReadiness({ ...ready, loading: true }, 'all')).toContain('Wait for the current operation to finish.');
    expect(generationReadiness({ ...ready, historyState: 'unavailable' }, 'all')).toContain('Reload execution history before running.');
    expect(generationReadiness({ ...ready, deliveryAvailable: false }, 'all')).toContain('Execution delivery is unavailable; check server configuration.');
  });
  it('rejects inactive single-pass overrides that the server schema forbids', () => {
    const singlePass = structuredClone(config);
    singlePass.mode = 'single_pass';
    singlePass.stages.gap_extraction.overrides.critic = singlePass.stages.gap_extraction.route;
    expect(generationReadiness({ ...ready, config: singlePass }, 'all')).toContain('Review invalid model settings.');
  });
  it('blocks invalid settings, unavailable routes and active work', () => {
    expect(generationReadiness({ ...ready, config: { ...config, mode: 'invalid' } as unknown as typeof config }, 'all')).toContain('Review invalid model settings.');
    expect(generationReadiness({ ...ready, providers: [], active: true }, 'all')).toContain('Wait for the active execution to finish.');
    expect(generationReadiness({ ...ready, providers: [] }, 'all').some(message => message.includes('credentials'))).toBe(true);
  });
});

import { currentPrerequisites } from '@/components/development/development-readiness';
import type { SectionAttempt } from '@/modules/development/execution-store';
import type { AttemptHistoryMetadata } from '@/modules/development/execution';

describe('section prerequisites', () => {
  const attempt = (section: string, id: string, extra = {}) => ({ section, id, status: 'succeeded', result: { output_id: id, prerequisite_ids: {} }, prerequisites: {}, ...extra }) as unknown as SectionAttempt;
  const gap = attempt('gap_extraction', 'gap');
  const tactic = attempt('tactic_extraction', 'tactic');
  const current = (id: string) => ({ [id]: { freshness: { current: true, reasons: [] }, evaluations: [] } }) as Record<string, AttemptHistoryMetadata>;
  it('requires successful and known-current evidence', () => {
    expect(currentPrerequisites('matching_coverage', [gap, tactic], {})).toBeNull();
    expect(currentPrerequisites('matching_coverage', [gap, { ...tactic, status: 'failed' }], { ...current('gap'), ...current('tactic') })).toBeNull();
    const outdated = { ...current('gap'), tactic: { freshness: { current: false, reasons: ['newer_attempt'] }, evaluations: [] } } as Record<string, AttemptHistoryMetadata>;
    expect(currentPrerequisites('matching_coverage', [gap, tactic], outdated)).toBeNull();
    expect(currentPrerequisites('matching_coverage', [gap, tactic], { ...current('gap'), ...current('tactic') })).toEqual({ gap_extraction: { attempt_id: 'gap', output_id: 'gap' }, tactic_extraction: { attempt_id: 'tactic', output_id: 'tactic' } });
  });
  it('rejects matching built from different upstream outputs', () => {
    const matching = attempt('matching_coverage', 'matching', { prerequisites: { gap_extraction: 'gap', tactic_extraction: 'tactic' }, result: { output_id: 'matching', prerequisite_ids: { gap_extraction: 'old', tactic_extraction: 'tactic' } } });
    expect(currentPrerequisites('partial_splitting', [gap, tactic, matching], { ...current('gap'), ...current('tactic'), ...current('matching') })).toBeNull();
  });
});

import { effectiveRoute, evaluationRouteReadiness } from '@/components/development/development-readiness';

describe('evaluation and effective routes', () => {
  const route = config.stages.gap_extraction.route;
  const fallback = route.fallbacks[0];
  const providers = [
    { provider_id: route.provider_id, status: 'missing' as const, default_model: route.model },
    { provider_id: fallback, status: 'configured' as const, default_model: 'fallback-model' },
  ];
  it('shows the first configured fallback and its default model', () => {
    expect(effectiveRoute(route, providers)).toEqual({ provider_id: fallback, model: 'fallback-model', fallback: true });
  });
  it('requires a valid configured model route only for model-backed evaluation', () => {
    expect(evaluationRouteReadiness('checks_only', route, [])).toEqual([]);
    expect(evaluationRouteReadiness('reference', route, [])).toEqual([]);
    expect(evaluationRouteReadiness('rubric', route, [])).toContain('Configure credentials for the selected evaluator provider or an allowed fallback.');
    expect(evaluationRouteReadiness('rubric', { ...route, model: '' }, providers)).toContain('Review invalid evaluator model settings.');
    expect(evaluationRouteReadiness('rubric', route, providers)).toEqual([]);
  });
});
