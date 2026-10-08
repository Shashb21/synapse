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

const newFields = { proposal_kind: 'new', rationale: 'Addresses missing safety evidence', comparative_rationale: 'Existing studies lack these data; the new registry costs more but can recruit.', name: 'Registry', type: 'rwe_study', evidence_question: 'Compare outcomes', design: { population: 'Adults', comparator: 'SOC', outcomes: 'Survival', data_source: 'Registry', study_design: 'Cohort', duration_months: 12, readout_lag_months: 2, timing_rationale: 'Annual cycle' } };
const newExample = { kind: 's9_proposal', subject_id: 'idea-new', outcome: 'accepted', ai_output: newFields } as unknown as DecisionExample;
const replayNew = (fields: Record<string, unknown>) => ({ kind: 's9_proposal', subject_id: 'idea-new', decision: 'accept', fields });
describe('new S9 comparison replay', () => {
    it('scores an exact comparison and penalizes changed or absent comparison', () => {
        expect(scoreDecisionReplay(newExample, replayNew(newFields)).metrics.every(m => m.value === 1)).toBe(true);
        for (const comparison of ['Contradicts the human comparison', undefined]) {
            const score = scoreDecisionReplay(newExample, replayNew({ ...newFields, comparative_rationale: comparison }));
            expect(score.reason).toBeNull();
            expect(score.metrics.find(m => m.name === 'comparative_rationale_literal_agreement')?.value).toBe(0);
        }
    });
    it.each(['new', undefined])('excludes missing original comparison with current or legacy kind %s', kind => {
        const incomplete = { ...newFields, proposal_kind: kind, comparative_rationale: undefined };
        for (const outcome of ['accepted', 'edited'] as const) {
            const score = scoreDecisionReplay({ ...newExample, outcome, ai_output: incomplete, final: newFields }, replayNew(newFields));
            expect(score.metrics).toEqual([]);
            expect(score.reason).toMatch(/original.*comparison/i);
        }
    });
    it('excludes an incomplete edited target even with a complete original comparison', () => {
        const score = scoreDecisionReplay({ ...newExample, outcome: 'edited', final: { ...newFields, comparative_rationale: '' } }, replayNew(newFields));
        expect(score.metrics).toEqual([]);
        expect(score.reason).toMatch(/target.*comparison/i);
    });
    it('defaults legacy absent kind to new only when the saved comparison is complete', () => {
        const legacy = { ...newFields, proposal_kind: undefined };
        const score = scoreDecisionReplay({ ...newExample, ai_output: legacy }, replayNew(legacy));
        expect(score.reason).toBeNull();
        expect(score.metrics).toHaveLength(15);
        expect(score.metrics.every(m => m.value === 1)).toBe(true);
    });
});


describe('S9 proposal rationale evidence', () => {
    it.each(['new', 'expansion'])('scores original and edited proposal rationale for %s without scoring human decision reason', kind => {
        const scope = {name:'Child',evidence_question:'Q',population:'Older adults',outcomes:'Safety',geography:'',data_cut:'',analysis:'Subgroup',instrument:'',study_design:'Analysis',gap_coverage:'Safety',cost_effort:'Low',timing:'Soon',feasibility_risks:'Small sample',post_hoc:true,prospective_enrolment:false,protocol_amendment:false,start_date:null,evidence_available:null};
        const fields = {...newFields, proposal_kind:kind, ...(kind === 'expansion' ? {target_tactic_id:'TAC-001',expansion_scope:scope} : {})};
        for (const outcome of ['accepted','edited'] as const) {
            const final = {...fields,rationale:'Human corrected proposal explanation'};
            const example = {...newExample,outcome,ai_output:fields,final,rationale:'Separate private decision reason'};
            const target = outcome === 'accepted' ? fields : final;
            for (const rationale of [target.rationale,'Wrong explanation',undefined]) {
                const score = scoreDecisionReplay(example,replayNew({...target,rationale}));
                expect(score.reason).toBeNull();
                expect(score.metrics.find(m => m.name === 'rationale_literal_agreement')?.value).toBe(rationale === target.rationale ? 1 : 0);
            }
            for (const incomplete of [{...example,ai_output:{...fields,rationale:undefined}}, {...example,outcome:'edited' as const,final:{...final,rationale:undefined}}]) {
                const score = scoreDecisionReplay(incomplete,replayNew(target));
                expect(score.metrics).toEqual([]);
                expect(score.reason).toMatch(/rationale/i);
            }
        }
    });
});
