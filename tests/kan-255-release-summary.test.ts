/** Verify deterministic, saved-evidence-only release summary accounting. */
import { expect, it } from 'vitest';
import { summarizePairedReleaseEvidence, type PairedReleaseEvidence } from '@/modules/development/release-summary';

const pair = (id: string, controlled = true, standardFinishedAt = '2026-01-01T00:00:05Z'): PairedReleaseEvidence => ({
  trial_id: id,
  comparison: {
    compatibility: { controlled, blockers: controlled ? [] : ['sources'], missing_evidence: [], varying_factors: [] },
    sections: [{
      section: 'gap_extraction',
      compatibility: { controlled, blockers: [], missing_evidence: [], varying_factors: [] },
      evaluation_pairs: [{ left_evaluation_id: 'single-eval', right_evaluation_id: 'standard-eval', quality_available: controlled, compatibility: { controlled, blockers: [], missing_evidence: [], varying_factors: [] } }],
    }],
    left: { execution: {
      id: 'single', experiment_id: 'experiment', manifest: { config: { mode: 'single_pass' } }, sections: [{ id: 'single-section', section: 'gap_extraction', started_at: '2026-01-01T00:00:00Z', finished_at: '2026-01-01T00:00:02Z' }],
      calls: [{ section_id: 'single-section', receipt: { cost_usd: 0 } }],
    }, evaluations: [{ id: 'single-eval', result: { reference: { status: 'scored', matches: [{ output_id: 'o1', reference_id: 'r1' }], unmatched_output_ids: ['o2'], unmatched_reference_ids: ['r2'] } } }] },
    right: { execution: {
      id: 'standard', experiment_id: 'experiment', manifest: { config: { mode: 'standard' } }, sections: [{ id: 'standard-section', section: 'gap_extraction', started_at: '2026-01-01T00:00:00Z', finished_at: standardFinishedAt }],
      calls: [{ section_id: 'standard-section', receipt: { cost_usd: null } }],
    }, evaluations: [{ id: 'standard-eval', result: { reference: { status: 'scored', matches: [{ output_id: 'o1', reference_id: 'r1' }, { output_id: 'o2', reference_id: 'r2' }], unmatched_output_ids: [], unmatched_reference_ids: [] } } }] },
    trial_note: 'One trial.',
  },
} as unknown as PairedReleaseEvidence);

it('reports repeated per-mode/stage variation, known zero and unknown costs, misses, and false positives', () => {
  expect(summarizePairedReleaseEvidence([pair('repeat-1'), pair('repeat-2', true, '2026-01-01T00:00:07Z')])).toEqual({
    controlled: true,
    refusal_reasons: [],
    trials_total: 2,
    modes: {
      single_pass: { gap_extraction: { trials: 2, latency_ms: { min: 2000, max: 2000, range: 0 }, cost_usd: { known_total: 0, known_call_count: 2, zero_cost_call_count: 2, unknown_call_count: 0 }, reference: { matches: 2, false_positives: 2, misses: 2 } } },
      standard: { gap_extraction: { trials: 2, latency_ms: { min: 5000, max: 7000, range: 2000 }, cost_usd: { known_total: null, known_call_count: 0, zero_cost_call_count: 0, unknown_call_count: 2 }, reference: { matches: 4, false_positives: 0, misses: 0 } } },
    },
  });
});

it('refuses incomplete or incomparable saved pairs rather than averaging them', () => {
  expect(summarizePairedReleaseEvidence([pair('repeat-1', false)])).toMatchObject({
    controlled: false,
    refusal_reasons: ['repeat-1: sources'],
    trials_total: 1,
    modes: {},
  });
});

it('refuses pairs with different stage coverage rather than reporting a partial repeat as complete', () => {
  const incomplete = pair('repeat-2');
  incomplete.comparison.sections = [];
  expect(summarizePairedReleaseEvidence([pair('repeat-1'), incomplete])).toMatchObject({
    controlled: false,
    refusal_reasons: ['repeat-2: section set differs from the other controlled pairs'],
    modes: {},
  });
});
