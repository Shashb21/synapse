import { describe, expect, it } from 'vitest';
import { scoreStage, scoringIdentity, type HumanJudgments } from '@/accuracy/eval/benchmark/scoring';
import type { FrozenReferencePack } from '@/accuracy/eval/benchmark/inputs';
import type { ExtractFinding } from '@/accuracy/eval/benchmark/extract';
const pack: FrozenReferencePack = { filename: 'synthetic.txt', sourceCodeVersion: 'code1', parserVersion: 'parser1', frozenAt: '2026-10-13T12:00:00Z', originalFileHash: 'original', packId: 'p', sourceHash: 's', referenceHash: 'r', packHash: 'p-hash', referenceVersion: 'v1', source: { blocks: [{ id: 'b', text: 'older patients renal impairment', kind: 'bullet', location: { kind: 'slide', ref: '1' } }] }, gold: { needs: { items: [{ id: 'older', statement: 'older patients', blockIds: ['b'] }, { id: 'renal', statement: 'renal impairment', blockIds: ['b'] }, { id: 'lost', statement: 'chart', blockIds: [], parsingLoss: { reason: 'chart', location: { kind: 'slide', ref: '2' } } }], parsingLossIds: ['lost'], review: { status: 'approved', reviewerId: 'gold-human', reviewedAt: '2026-10-13T12:00:00Z', referenceVersion: 'v1' } }, tactics: { items: [], parsingLossIds: [], review: { status: 'pending' } } } };
const finding = (id: string): ExtractFinding => ({ id, statement: 'paraphrase', external_id: null, details: {}, provenance: [{ source_file_id: 'p', block_id: 'b', quote: 'older patients' }], citation: { valid: true, reasons: [], locations: [], metadata: null } });
const signed = { reviewerId: 'human', reviewedAt: '2026-10-13T13:00:00Z', signature: 'attested', rationale: 'Reviewed meaning and evidence' };
function reviews(findings: ExtractFinding[], records: HumanJudgments['records']): HumanJudgments {
    return { identity: scoringIdentity(pack, 'need_extract', findings), records };
}
describe('human semantic scoring', () => {
    it('credits explicit paraphrases once, retains losses and duplicate citation counts', () => {
        const fs = [finding('a'), finding('dup')];
        const judgments = reviews(fs, [
            { ...signed, findingId: 'a', outcome: 'match', meanings: [
                { goldId: 'older', essentialMeaning: 'older patients' },
            ] },
            { ...signed, findingId: 'dup', outcome: 'duplicate', duplicateOf: 'a' },
        ]);

        const result = scoreStage(pack, 'need_extract', fs, judgments);

        expect(result.contentRecall).toEqual({ numerator: 1, denominator: 3, percent: 1 / 3 * 100 });
        expect(result.citationValidity.denominator).toBe(2);
        expect(result.duplicates).toEqual(['dup']);
        expect(result.omissions).toEqual(['renal', 'lost']);
        expect(result.provisional).toBe(false);
    });
    it('never infers recovery from IDs or broad special populations', () => {
        const fs = [{ ...finding('older'), statement: 'special populations', external_id: 'renal' }];
        const r = scoreStage(pack, 'need_extract', fs, reviews(fs, [{ ...signed, findingId: 'older', outcome: 'specificity_failure', goldIds: ['older', 'renal'] }]));
        expect(r.contentRecall.numerator).toBe(0);
        expect(r.specificityFailures).toHaveLength(1);
    });
    it('records distinct meanings explicitly and separates additions and unsupported outputs', () => {
        const fs = [finding('a'), finding('extra'), finding('bad')];
        const judgments = reviews(fs, [
            { ...signed, findingId: 'a', outcome: 'match', meanings: [
                { goldId: 'older', essentialMeaning: 'older patients' },
                { goldId: 'renal', essentialMeaning: 'renal impairment' },
            ] },
            { ...signed, findingId: 'extra', outcome: 'addition', evidence: [fs[1].provenance[0]] },
            { ...signed, findingId: 'bad', outcome: 'unsupported' },
        ]);

        const r = scoreStage(pack, 'need_extract', fs, judgments);
        expect(r.contentRecall.numerator).toBe(2);
        expect(r.additions).toEqual(['extra']);
        expect(r.unsupported).toEqual(['bad']);
    });
    it('keeps missing reviews provisional and empty denominators explicit', () => {
        const r = scoreStage(pack, 'inventory_extract', [], { identity: scoringIdentity(pack, 'inventory_extract', []), records: [] });
        expect(r.contentRecall).toEqual({ numerator: 0, denominator: 0, percent: null });
        expect(r.provisional).toBe(true);
        expect(scoreStage(pack, 'need_extract', [finding('a')], reviews([finding('a')], [])).pending).toEqual(['a']);
    });
    it('checks original source quotes independently of a valid flag', () => {
        const fs = [finding('a')];
        fs[0].provenance[0].block_id = 'wrong';
        const r = scoreStage(pack, 'need_extract', fs, reviews(fs, [{ ...signed, findingId: 'a', outcome: 'match', meanings: [{ goldId: 'older', essentialMeaning: 'older patients' }] }]));
        expect(r.contentRecall.numerator).toBe(1);
        expect(r.citationValidity.numerator).toBe(0);
        expect(r.contentWithCitation.numerator).toBe(0);
    });
    it.each(['identity', 'version', 'changed-output', 'unknown', 'unsigned', 'duplicate-review', 'double-credit', 'loss-match', 'duplicate-chain', 'bad-addition', 'empty-meaning', 'future'])('rejects %s', kind => {
        const fs = [finding('a'), finding('b')];
        const j = reviews(fs, [{ ...signed, findingId: 'a', outcome: 'match', meanings: [{ goldId: 'older', essentialMeaning: 'older patients' }] }]);
        if (kind === 'identity')
            j.identity.sourceHash = 'other';
        if (kind === 'version')
            j.identity.referenceVersion = 'v0';
        if (kind === 'changed-output')
            fs[0].statement = 'changed';
        if (kind === 'unknown')
            j.records[0].findingId = 'absent';
        if (kind === 'unsigned')
            j.records[0].signature = '';
        if (kind === 'duplicate-review')
            j.records.push(j.records[0]);
        if (kind === 'double-credit')
            j.records.push({ ...signed, findingId: 'b', outcome: 'match', meanings: [{ goldId: 'older', essentialMeaning: 'older patients' }] });
        if (kind === 'loss-match')
            j.records = [{ ...signed, findingId: 'a', outcome: 'match', meanings: [{ goldId: 'lost', essentialMeaning: 'chart' }] }];
        if (kind === 'duplicate-chain')
            j.records = [{ ...signed, findingId: 'a', outcome: 'duplicate', duplicateOf: 'b' }, { ...signed, findingId: 'b', outcome: 'duplicate', duplicateOf: 'a' }];
        if (kind === 'bad-addition')
            j.records = [{ ...signed, findingId: 'a', outcome: 'addition', evidence: [{ source_file_id: 'p', block_id: 'b', quote: 'invented' }] }];
        if (kind === 'empty-meaning')
            j.records = [{ ...signed, findingId: 'a', outcome: 'match', meanings: [{ goldId: 'older', essentialMeaning: '' }] }];
        if (kind === 'future')
            j.records[0].reviewedAt = '2999-01-01T00:00:00Z';
        expect(() => scoreStage(pack, 'need_extract', fs, j)).toThrow();
    });
    it('requires fresh judgments for every corrected reference and preserves old scores', () => {
        const fs = [finding('a')];
        const j = reviews(fs, [{ ...signed, findingId: 'a', outcome: 'unsupported' }]);
        const old = scoreStage(pack, 'need_extract', fs, j);
        const corrected = structuredClone(pack);
        corrected.referenceVersion = 'v2';
        corrected.referenceHash = 'r2';
        corrected.packHash = 'p2';
        corrected.gold.needs.review = { reviewerId: 'human', reviewedAt: corrected.frozenAt, status: 'approved', referenceVersion: 'v2' };
        expect(() => scoreStage(corrected, 'need_extract', fs, j)).toThrow();
        const fresh = { ...j, identity: scoringIdentity(corrected, 'need_extract', fs) };
        expect(scoreStage(corrected, 'need_extract', fs, fresh).identity.referenceVersion).toBe('v2');
        expect(old.identity.referenceVersion).toBe('v1');
    });
    it('retains valid additions without increasing recall and accepts rejected citation evidence', () => {
        const fs = [finding('a')];
        fs[0].citation.valid = false;
        const j = reviews(fs, [{ ...signed, findingId: 'a', outcome: 'addition', evidence: fs[0].provenance }]);
        const r = scoreStage(pack, 'need_extract', fs, j);
        expect(r.contentRecall.numerator).toBe(0);
        expect(r.additions).toEqual(['a']);
        expect(r.citationValidity.numerator).toBe(0);
    });
    it('rejects duplicate output IDs at identity boundary', () => {
        expect(() => scoringIdentity(pack, 'need_extract', [finding('a'), finding('a')])).toThrow();
    });
});
