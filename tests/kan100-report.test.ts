import { describe, expect, it } from 'vitest';
import { renderBenchmarkReport } from '@/accuracy/eval/benchmark/report';
import { scoreStage, scoringIdentity } from '@/accuracy/eval/benchmark/scoring';
import type { FrozenReferencePack } from '@/accuracy/eval/benchmark/inputs';
import type { BatchResult, BatchRun } from '@/accuracy/eval/benchmark/batch';
import type { BenchmarkRoute } from '@/accuracy/eval/benchmark/contracts';
import type { ExtractFinding } from '@/accuracy/eval/benchmark/extract';
function fixture() {
  const packs: FrozenReferencePack[] = ['synthetic-a', 'synthetic-b'].map(packId => ({ packId, filename: `${packId}.txt`, sourceCodeVersion: 'code', parserVersion: 'parser', frozenAt: '2026-10-13T12:00:00Z', originalFileHash: 'original', sourceHash: 'source', referenceHash: 'reference', packHash: 'pack', referenceVersion: 'v1', source: { blocks: [{ id: 'b', text: 'Older patients; renal impairment.', kind: 'bullet', location: { kind: 'slide', ref: '1' } }] }, gold: Object.fromEntries(['needs', 'tactics'].map(stage => [stage, { items: [{ id: 'older', statement: 'Older patients', blockIds: ['b'] }, { id: 'renal', statement: 'Renal impairment', blockIds: ['b'] }, { id: 'chart', statement: 'Image-only evidence', blockIds: [], parsingLoss: { reason: 'Image not parsed', location: { kind: 'slide', ref: '2' } } }], parsingLossIds: ['chart'], review: { status: 'approved', reviewerId: 'human', reviewedAt: '2026-10-13T12:00:00Z', referenceVersion: 'v1' } }])) as FrozenReferencePack['gold'] }));
  const runs: BatchRun[] = [];
  for (const pack of packs) for (const stage of ['need_extract', 'inventory_extract'] as const) for (const configuration of ['baseline', 'extract'] as const) for (const repetition of [1, 2, 3]) {
    const route = { providerId: 'requested-provider', requestedModel: 'requested-model', version: '2.5', tier: 'cost_effective', settingsHash: 'settings' } as BenchmarkRoute;
    const finding: ExtractFinding = { id: 'f', statement: 'Older patient paraphrase', external_id: null, details: {}, provenance: [{ source_file_id: pack.packId, block_id: 'b', quote: 'Older patients' }], citation: { valid: true, reasons: [], locations: [], metadata: null } };
    const score = scoreStage(pack, stage, [finding], { identity: scoringIdentity(pack, stage, [finding]), records: [{ findingId: 'f', outcome: 'match', meanings: [{ goldId: 'older', essentialMeaning: 'Older patients' }], reviewerId: 'human', reviewedAt: '2026-10-13T12:00:00Z', signature: 'signed', rationale: 'Faithful paraphrase' }] });
    runs.push({ id: `${pack.packId}-${stage}-${configuration}-${repetition}`, packId: pack.packId, stage, configuration, repetition, route, auditRoute: route, extractionHistory: [], extractionElapsedMs: 5, retryUsed: false, polls: 0, auditAttempts: [], extraction: { status: 'completed', findings: [finding], actualRoute: { providerId: 'requested-provider', model: 'requested-model', version: '2.5', tier: 'cost_effective', label: 'verified' } } as BatchRun['extraction'], audit: { complete: true, chunks: [], verdicts: [], flags: [] }, score, auditScore: { genuineOmissionsFlagged: ['renal'], missedOmissions: ['chart'], incorrectFlags: [], provisional: false }, reviewVerified: true });
  }
  const result: BatchResult = { status: 'completed', batchId: 'synthetic', checkpointDigest: 'digest', artifactDirectory: '/private/synthetic', reasons: [], runs, elapsedMs: 100, costs: { overheadCharges: { setupUsd: 0, tuningUsd: 0 }, spentUsd: 1, reservedUsd: 0, remainingWorkUsd: 0, conservativeTotalUsd: 1, unknown: false, entries: [], jobs: [] } };
  return { result, packs, ceilingUsd: 10, evidenceKind: 'synthetic' as const };
}
describe('readable benchmark report', () => {
  it('reports complete software matrix separately from synthetic empirical evidence', () => { const r = renderBenchmarkReport(fixture()); expect(r.status).toBe('incomplete'); expect(r.markdown).toContain('Synthetic'); expect(r.markdown).toContain('1/3 (33.33%)'); expect(r.markdown).toContain('Citation validity'); expect(r.markdown).toContain('Content with valid citation'); expect(r.markdown).toContain('Human decides adoption'); });
  it('allows completed live evidence with all judgments and matrix retained', () => { const r = renderBenchmarkReport({ ...fixture(), evidenceKind: 'live' }); expect(r.status).toBe('completed'); expect(r.markdown).toContain('24/24'); expect(r.markdown).toContain('reference decks'); });
  it('preserves exact missing runs and provisional review blockers', () => { const f = fixture(); f.result.runs.pop(); f.result.runs[0].score!.provisional = true; const r = renderBenchmarkReport({ ...f, evidenceKind: 'live', blockers: ['Tislelizumab: manifest 59 versus XML 91; human completeness review pending'] }); expect(r.status).toBe('incomplete'); expect(r.blockers).toContain('Missing run: synthetic-b / inventory_extract / extract / repeat 3'); expect(r.markdown).toContain('human review pending'); expect(r.markdown).toContain('manifest 59 versus XML 91'); });
  it('keeps unknown costs reserved and reports failures and responding identities', () => { const f = fixture(); f.result.costs.unknown = true; f.result.costs.reservedUsd = 2; f.result.costs.entries.push({ id: 'attempt', runId: f.result.runs[0].id, operation: 'baseline', boundUsd: 2, costUsd: null, status: 'failed', usage: null }); f.result.runs[0].extraction!.status = 'failed'; f.result.runs[0].extraction!.actualRoute.model = 'fallback'; f.result.runs[0].extraction!.actualRoute.label = 'substituted'; const r = renderBenchmarkReport({ ...f, evidenceKind: 'live' }); expect(r.status).toBe('incomplete'); expect(r.markdown).toContain('unknown'); expect(r.markdown).toContain('reserved $2'); expect(r.markdown).toContain('fallback'); expect(r.markdown).toContain('failed'); expect(r.markdown).toContain('requested-model'); });
  it('shows source-linked omissions, losses, specificity, additions, duplicates and unsupported examples', () => { const f = fixture(); const r = f.result.runs[0]; r.score!.specificityFailures = [{ findingId: 'f', outcome: 'specificity_failure', goldIds: ['older', 'renal'], reviewerId: 'h', reviewedAt: '2026-10-13T12:00:00Z', signature: 's', rationale: 'Broad special populations loses distinct needs' }]; r.score!.additions = ['f']; r.score!.duplicates = ['f']; r.score!.unsupported = ['f']; const report = renderBenchmarkReport(f).markdown; for (const text of ['Renal impairment', 'Image not parsed', '#source-', 'specificity_failure', 'addition', 'duplicate', 'unsupported', 'Broad special populations', 'Older patients']) expect(report).toContain(text); });
  it('reports variation and recurring misses separately by stage and configuration', () => { const f = fixture(); f.result.runs[1].score!.contentRecall = { numerator: 2, denominator: 3, percent: 200 / 3 }; const report = renderBenchmarkReport(f).markdown; expect(report).toContain('33.33–66.67%'); expect(report).toContain('renal: 3/3'); expect(report).toContain('inventory_extract / extract'); expect(report).toContain('Audit'); });
  it('rejects ambiguous input rather than mixing decks or repetitions', () => { const f = fixture(); f.result.runs.push(f.result.runs[0]); expect(() => renderBenchmarkReport(f)).toThrow('Duplicate'); const other = fixture(); other.result.runs[0].packId = 'absent'; expect(() => renderBenchmarkReport(other)).toThrow('Unknown'); });
  it('does not claim empirical completion by default or when citations/budget are invalid', () => { const f = fixture(); expect(renderBenchmarkReport({ ...f, evidenceKind: undefined }).status).toBe('incomplete'); f.result.runs[0].score!.citationValidity.numerator = 0; f.result.costs.conservativeTotalUsd = 11; const r = renderBenchmarkReport({ ...f, evidenceKind: 'live' }); expect(r.status).toBe('incomplete'); expect(r.markdown).toContain('invalid source citations'); expect(r.markdown).toContain('budget'); });
  it('persists readable zero-run preparation blockers and undefined denominators', () => {
    const f = fixture(); f.result.runs = []; f.result.status = 'incomplete';
    const report = renderBenchmarkReport({ ...f, blockers: ['Authorization and approved atomic gold pending'] });
    expect(report.markdown).toContain('0/24'); expect(report.blockers).toHaveLength(27);
    const empty = fixture(); empty.result.runs[0].score!.contentRecall = { numerator: 0, denominator: 0, percent: null };
    expect(renderBenchmarkReport(empty).markdown).toContain('0/0 (undefined)');
  });
  it('rejects invalid ceilings and duplicated packs without changing inputs', () => {
    const f = fixture(); const before = JSON.stringify(f);
    expect(() => renderBenchmarkReport({ ...f, ceilingUsd: NaN })).toThrow('Invalid budget');
    expect(() => renderBenchmarkReport({ ...f, packs: [f.packs[0], f.packs[0]] })).toThrow('Duplicate pack');
    renderBenchmarkReport(f); expect(JSON.stringify(f)).toBe(before);
  });
  it('keeps provisional audit outcomes and unsafe markdown explicit', () => {
    const f = fixture(); f.result.runs[0].auditScore!.provisional = true;
    f.result.runs[0].extraction!.findings[0].statement = '<script>unsafe</script> | **claim**';
    const report = renderBenchmarkReport({ ...f, evidenceKind: 'live' });
    expect(report.status).toBe('incomplete'); expect(report.markdown).toContain('&lt;script&gt;'); expect(report.markdown).not.toContain('<script>');
  });

});
