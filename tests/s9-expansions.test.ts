/** Behavioral S9 expansion source gate: edits, acceptance, stale targets and priority. */
import { beforeEach, describe, expect, it } from 'vitest';
import '@/modules';
import { eq } from 'drizzle-orm';
import * as core from '@/lib/iegp/schema';
import { db, wipePlatform } from '@/modules/kernel/db';
import { createGap, createProposedTactic, loadState, resetDemoSetup } from '@/lib/iegp/store';
import { validatePlacement } from '@/modules/stages/s8-prioritization/module';
import { ideationModule, addIdeationProposal, decideIdeationProposal, editIdeationProposal, listIdeationProposals, restoreIdeationProposal } from '@/modules/stages/s9-ideation/module';
const actor = { name: 'Expansion reviewer', function: 'medical_affairs' as const };
const scope = { name: 'Elderly analysis', evidence_question: 'What is safety in 75+?', population: 'Age 75+', outcomes: 'AESI', geography: '', data_cut: 'Locked trial data', analysis: 'Post-hoc subgroup', instrument: '', study_design: 'Retrospective subgroup analysis', gap_coverage: 'Estimates elderly safety', cost_effort: 'Two analyst months', timing: '3 months analysis + 1 month review', feasibility_risks: 'Small subgroup; descriptive', post_hoc: true, prospective_enrolment: false, protocol_amendment: false, start_date: null, evidence_available: null };
let gapId: string, targetId: string;
async function add() { return addIdeationProposal({ gap_id: gapId, fields: { name: scope.name, type: 'subgroup_analysis', evidence_question: scope.evidence_question, proposal_kind: 'expansion', target_tactic_id: targetId, expansion_scope: scope, comparative_rationale: 'Uses existing data faster and cheaper than a new cohort', duration_months: 3, readout_lag_months: 1 }, rationale: 'Review existing data', actor }); }
beforeEach(async () => {
    await resetDemoSetup();
    await wipePlatform();
    gapId = await createGap({ statement: 'Long-term safety in elderly patients is unknown.', actor_name: actor.name, actor_function: actor.function });
    await validatePlacement({ gap_id: gapId, band: 'high', rationale: 'Blocks dossier', actor });
    targetId = await createProposedTactic({ name: 'Completed trial', type: 'phase3_trial', description: 'Original trial', evidence_question: 'Overall safety', population: 'Adults', intervention: 'Asset', comparator: 'SOC', outcomes: 'AE', owner: actor.name, function: actor.function, residual_ids: [], status: 'completed', actor_name: actor.name, actor_function: actor.function });
});
describe('S9 expansion source gate', () => {
    it('retains typed target and edits, atomically accepts one proposed noncounting child with unchanged parent', async () => {
        const proposal = await add();
        const before = await loadState();
        expect(proposal).toMatchObject({ proposal_kind: 'expansion', target_tactic_id: targetId, tactic_id: null, expansion_id: null });
        await editIdeationProposal({ id: proposal.id, fields: { expansion_scope: { ...scope, cost_effort: 'One analyst month' } }, rationale: 'Refined budget', actor });
        const results = await Promise.allSettled([1, 2].map(() => decideIdeationProposal({ id: proposal.id, decision: 'accept', rationale: 'Suitable existing data', actor })));
        expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
        const after = await loadState();
        expect(after.tactics).toEqual(before.tactics);
        expect(after.expansions).toHaveLength(1);
        expect(after.expansions[0]).toMatchObject({ tactic_id: targetId, status: 'proposed', scope: { cost_effort: 'One analyst month' } });
        expect(after.coverages.find(c => c.expansion_id === after.expansions[0].id)?.overall).toBe('unassessed');
        expect((await listIdeationProposals()).find(p => p.id === proposal.id)).toMatchObject({ status: 'accepted', tactic_id: targetId, expansion_id: after.expansions[0].id });
    });
    it('keeps rejection memory and restores the same editable target', async () => {
        const proposal = await add();
        await decideIdeationProposal({ id: proposal.id, decision: 'reject', rationale: 'Sample too small', actor });
        const restored = await restoreIdeationProposal({ id: proposal.id, rationale: 'New feasibility information', actor });
        expect(restored).toMatchObject({ status: 'proposed', target_tactic_id: targetId, expansion_scope: scope });
    });
    it('rejects prospective enrolment on a completed target and invalid timing', async () => {
        await expect(addIdeationProposal({ gap_id: gapId, fields: { name: 'Impossible', type: 'subgroup_analysis', evidence_question: 'Q', proposal_kind: 'expansion', target_tactic_id: targetId, expansion_scope: { ...scope, prospective_enrolment: true }, comparative_rationale: 'Comparison', duration_months: 1, readout_lag_months: 0 }, rationale: 'Review', actor })).rejects.toThrow(/completed/i);
        const p = await add();
        await expect(editIdeationProposal({ id: p.id, fields: { duration_months: 0 }, rationale: 'Bad timing', actor })).rejects.toThrow(/positive/);
    });
    it('rejects a stale reviewed target without saving a child or decision', async () => {
        const p = await add();
        await db().update(core.tactics).set({ outcomes: 'Changed primary endpoint' }).where(eq(core.tactics.id, targetId));
        await expect(decideIdeationProposal({ id: p.id, decision: 'accept', rationale: 'Reviewed original', actor })).rejects.toThrow(/changed.*stale/i);
        expect((await loadState()).expansions).toHaveLength(0);
        expect((await listIdeationProposals()).find(r => r.id === p.id)?.status).toBe('proposed');
    });
    it('rejects deleted or unknown targets, incomplete scope and hidden prospective protocol claims', async () => {
        const p = await add();
        await db().delete(core.tactics).where(eq(core.tactics.id, targetId));
        await expect(decideIdeationProposal({ id: p.id, decision: 'accept', rationale: 'Reviewed original', actor })).rejects.toThrow(/target not found/i);
        await expect(add()).rejects.toThrow(/target not found/i);
        await expect(addIdeationProposal({ gap_id: gapId, fields: { name: 'Incomplete', type: 'subgroup_analysis', evidence_question: 'Q', proposal_kind: 'expansion', target_tactic_id: targetId, expansion_scope: { ...scope, cost_effort: '' } }, rationale: 'Review', actor })).rejects.toThrow();
    });
    it('cannot change target identity or kind through an edit', async () => {
        const p = await add();
        await expect(editIdeationProposal({ id: p.id, fields: { target_tactic_id: 'other' }, rationale: 'Different study', actor })).rejects.toThrow(/identity.*fixed/i);
        await expect(editIdeationProposal({ id: p.id, fields: { proposal_kind: 'new' }, rationale: 'Different study', actor })).rejects.toThrow(/identity.*fixed/i);
    });
    it('requires an explicit credible amendment for prospective additions to an ongoing target',async()=>{
        await db().update(core.tactics).set({status:'ongoing'}).where(eq(core.tactics.id,targetId));
        const fields={name:'Prospective elderly instrument',type:'pro_study',evidence_question:'QoL in 75+?',proposal_kind:'expansion' as const,target_tactic_id:targetId,comparative_rationale:'Uses existing sites; approval and extra recruitment needed',duration_months:12,readout_lag_months:2,expansion_scope:{...scope,analysis:'Prospective PRO collection',post_hoc:false,prospective_enrolment:true}};
        await expect(addIdeationProposal({gap_id:gapId,fields,rationale:'Review prospective scope',actor})).rejects.toThrow(/credible protocol amendment/);
        fields.expansion_scope={...fields.expansion_scope,protocol_amendment:true,study_design:'Prospective protocol amendment',feasibility_risks:'Requires ethics approval and instrument validation'};
        const p=await addIdeationProposal({gap_id:gapId,fields,rationale:'Review contingent amendment',actor});
        await decideIdeationProposal({id:p.id,decision:'accept',rationale:'Plan review before activation',actor});
        expect((await loadState()).expansions[0]).toMatchObject({status:'proposed',scope:{prospective_enrolment:true,protocol_amendment:true}});
    });
    it('rejects manual ideas for Medium or unvalidated gaps', async () => {
        await validatePlacement({ gap_id: gapId, band: 'medium', rationale: 'Later cycle', actor });
        await expect(add()).rejects.toThrow(/High/);
    });
});
import { scoreDecisionReplay } from '@/modules/kernel/decision-replay';
import type { DecisionExample } from '@/modules/kernel/decision-examples';
it('scores expansion kind, parent and full scope even when common new-tactic fields match', () => {
    const fields = { proposal_kind: 'expansion', target_tactic_id: 'TAC-known', expansion_scope: scope, comparative_rationale: 'Existing data saves time', name: 'Analysis', type: 'subgroup_analysis', evidence_question: 'Q', design: { population: 'Adults', comparator: 'SOC', outcomes: 'AE', data_source: 'Trial', study_design: 'Analysis', duration_months: 3, readout_lag_months: 1, timing_rationale: 'Analyst capacity' } };
    const example = { kind: 's9_proposal', subject_id: 'idea-test', outcome: 'accepted', ai_output: fields } as unknown as DecisionExample;
    const score = (actual: Record<string, unknown>) => scoreDecisionReplay(example, { kind: example.kind, subject_id: example.subject_id, decision: 'accept', fields: actual });
    expect(score(fields).metrics.every(m => m.value === 1)).toBe(true);
    expect(score({ ...fields, proposal_kind: 'new' }).metrics.find(m => m.name === 'proposal_kind_agreement')?.value).toBe(0);
    expect(score({ ...fields, target_tactic_id: 'TAC-wrong' }).metrics.find(m => m.name === 'target_tactic_id_agreement')?.value).toBe(0);
    expect(score({ ...fields, expansion_scope: { ...scope, cost_effort: 'Different budget' } }).metrics.find(m => m.name === 'expansion_cost_effort_literal_agreement')?.value).toBe(0);
    expect(scoreDecisionReplay({ ...example, ai_output: { ...fields, expansion_scope: null } }, { kind: example.kind, subject_id: example.subject_id, decision: 'accept', fields }).reason).toMatch(/complete target/);
});
