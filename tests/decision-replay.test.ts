/** Human agreement scoring distinguishes explicit rejection from omitted output. */
import { describe, it, expect } from 'vitest';
import { scoreDecisionReplay } from '@/modules/kernel/decision-replay';
import type { DecisionExample } from '@/modules/kernel/decision-examples';
const example = (outcome: string) => ({ kind: 's8_band', stage: 'S8', subject_id: 'gap-1', outcome, ai_output: { suggested_band: 'high' }, final: { band: 'low' } }) as unknown as DecisionExample;
describe('decision replay scoring', () => {
    it('scores accepted original AI band and edited final human band', () => {
        expect(scoreDecisionReplay(example('accepted'), { kind: 's8_band', subject_id: 'gap-1', decision: 'accept', band: 'high' })).toMatchObject({ metrics: expect.arrayContaining([{ name: 'band_agreement', value: 1, numerator: 1, denominator: 1 }]) });
        expect(scoreDecisionReplay(example('edited'), { kind: 's8_band', subject_id: 'gap-1', decision: 'accept', band: 'high' })).toMatchObject({ metrics: expect.arrayContaining([{ name: 'band_agreement', value: 0, numerator: 0, denominator: 1 }]) });
    });
    it('only rewards an explicit subject-resolved rejection', () => {
        expect(scoreDecisionReplay(example('rejected'), { kind: 's8_band', subject_id: 'gap-1', decision: 'reject' })).toMatchObject({ metrics: [{ value: 1 }] });
        expect(scoreDecisionReplay(example('rejected'), null).reason).toBeTruthy();
    });
    it('excludes ambiguous legacy suggestion and unsupported split targets', () => {
        expect(scoreDecisionReplay({ ...example('edited'), kind: 'gap_suggestion', final: { decision: 'merge' } }, {}).reason).toBeTruthy();
        expect(scoreDecisionReplay({ ...example('edited'), kind: 'residual_split' }, {}).reason).toBeTruthy();
    });
});
