/** Results retain readable evidence and fail closed for malformed historical payloads. */
import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { CallEvidence, DevelopmentResults } from '@/components/development/development-results';
import { EvaluationDetail } from '@/components/development/development-evaluation';
import type { Evaluation } from '@/modules/development/evaluation-store';
import { ComparisonEvidence } from '@/components/development/development-comparison';
import type { ExecutionCall, SectionAttempt } from '@/modules/development/execution-store';
import type { ComparisonResult } from '@/modules/development/comparison';
const attempt = (section: string, output: unknown, candidates: unknown[] = [], status = 'succeeded') => ({ id: 'attempt', section, status, result: { output, candidates, output_id: 'hash' } }) as SectionAttempt;
describe('section evidence', () => {
  it('renders extraction citations and rejected evidence as escaped text', () => {
    const html = renderToStaticMarkup(<DevelopmentResults attempt={attempt('gap_extraction', { accepted: [], rejected: [{ name: '<script>alert(1)</script>', source_quote: 'Source quotation', duplicate_of: 'gap-1' }] })} />);
    expect(html).toContain('Source quotation'); expect(html).toContain('Rejected'); expect(html).toContain('&lt;script&gt;'); expect(html).not.toContain('<script>');
  });
  it('separates relevance, design fit and delivered evidence coverage without inventing assessments', () => {
    const html = renderToStaticMarkup(<DevelopmentResults attempt={attempt('matching_coverage', { rows: [{ gap_id: 'g1', mappings: [{ tactic_id: 't1', coverage: 'partial', rationale: 'Planned work', dimensions: { population: 'partial' } }] }] })} />);
    for (const label of ['Relevance', 'Design fit', 'Delivered evidence coverage', 'Planned work']) expect(html).toContain(label);
    expect(html).toContain('unavailable');
  });
  it.each([null, 'bad', { accepted: [null, 8] }])('keeps malformed output available without crashing: %j', (output) => {
    expect(renderToStaticMarkup(<DevelopmentResults attempt={attempt('gap_extraction', output)} />)).toContain('unavailable');
  });
  it('treats no eligible splitting as not applicable rather than a perfect score', () => {
    const html = renderToStaticMarkup(<DevelopmentResults attempt={attempt('partial_splitting', { proposals: [] }, [], 'not_applicable')} />);
    expect(html).toContain('Not applicable'); expect(html).not.toContain('100%');
  });
  it('shows split scope and all five assessment subjects', () => {
    const html = renderToStaticMarkup(<DevelopmentResults attempt={attempt('partial_splitting', { proposals: [{ parent_gap_id: 'g1', addressed_statement: 'Addressed scope', open_statement: 'Remaining scope' }] })} />);
    for (const label of ['Addressed scope', 'Remaining scope', 'non-overlap', 'parent-meaning preservation', 'valid references']) expect(html).toContain(label);
  });
  it('keeps malformed legacy evaluation inspectable without crashing', () => {
    expect(renderToStaticMarkup(<EvaluationDetail evaluation={{ id: 'legacy', manifest: {}, result: {} } as Evaluation} />)).toContain('Evaluation evidence unavailable');
  });
  it('retains unknown call accounting and derives send-to-settlement latency', () => {
    const call = { id: 'call', ordinal: 1, status: 'failed', sending_at: '2026-10-30T00:00:00Z', settled_at: '2026-10-30T00:00:02Z', receipt: null, failure_accounting: null } as ExecutionCall;
    const html = renderToStaticMarkup(<CallEvidence call={call} />);
    expect(html).toContain('2000 ms'); expect(html).toContain('Cost: unknown'); expect(html).toContain('Usage: unknown');
  });
  it('shows compatibility reasons and explicit one-trial warning', () => {
    const value = { compatibility: { controlled: false, blockers: ['source_content', 'profile_version'], missing_evidence: ['evaluator'], varying_factors: ['generation_mode'] }, sections: [], trial_note: 'One trial per execution.' } as unknown as ComparisonResult;
    const html = renderToStaticMarkup(<ComparisonEvidence comparison={value} />);
    for (const label of ['source_content', 'profile_version', 'evaluator', 'generation_mode', 'One trial', 'not controlled']) expect(html).toContain(label);
  });
});
