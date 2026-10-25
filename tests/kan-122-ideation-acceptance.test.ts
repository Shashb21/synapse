/** Acceptance keeps reuse separate from new work and requires renewed context review. */
import { beforeEach, expect, it } from 'vitest';
import '@/modules';
import { eq } from 'drizzle-orm';
import * as core from '@/lib/iegp/schema';
import * as tables from '@/modules/kernel/schema';
import { db, wipePlatform } from '@/modules/kernel/db';
import { assignTacticToGap, createGap, createProposedTactic, loadState, resetDemoSetup, unassignTacticFromGap } from '@/lib/iegp/store';
import { validatePlacement } from '@/modules/stages/s8-prioritization/module';
import { addIdeationProposal, decideIdeationProposal, editIdeationProposal, listIdeationProposals, acceptedIdeationContexts, listIdeationGapOutcomes, ideationProposalReadback } from '@/modules/stages/s9-ideation/module';
import { addTimelineActivity, planVersion, savePlan, tacticDesigns, timelineModel } from '@/modules/stages/s10-timeline/module';
import { emptyDimensions, unlocked } from '@/lib/iegp/engine';
import { priorityDecision } from './support/priority-decision';
import { makeFinalReady } from './support/final-ready';
import { buildFinalPackage } from '@/modules/stages/s10-timeline/final-package';
import { loadAxes } from '@/modules/stages/s8-prioritization/axes';
import { listPlacements } from '@/modules/stages/s8-prioritization/module';
import { POST as planPost } from '@/app/api/plan/route';
const actor = { name: 'Evidence reviewer', function: 'medical_affairs' as const };
const recommendation = { remaining_need: 'Comparative safety still unknown', incremental_contribution: 'Existing descriptive safety supports a partial answer', alternatives_rationale: 'Review existing evidence before funding added analysis', feasibility: { status: 'conditional' as const, required_checks: ['Confirm comparator compatibility'] }, coverage_discrepancy: null, deadline: { status: 'unknown' as const, explanation: 'Confirm when evidence is available' } };
let gapId: string, tacticId: string;
async function addReuse() { return addIdeationProposal({gap_id:gapId,fields:{proposal_kind:'reuse',target_tactic_id:tacticId,name:'Reuse existing evidence',type:'rwe_study',evidence_question:'Safety',recommendation},rationale:'Review existing evidence unchanged',actor}); }
beforeEach(async()=>{
 await resetDemoSetup(); await wipePlatform();
 gapId=await createGap({statement:'Comparative elderly safety remains unknown',actor_name:actor.name,actor_function:actor.function});
 await validatePlacement({...await priorityDecision(gapId,'Blocks decision'),gap_id:gapId,band:'high',rationale:'Blocks decision',actor});
 tacticId=await createProposedTactic({name:'Existing cohort',type:'rwe_study',description:'Existing evidence',evidence_question:'Safety',population:'Adults',intervention:'Asset',comparator:'SOC',outcomes:'AE',owner:actor.name,function:actor.function,residual_ids:[],status:'ongoing',actor_name:actor.name,actor_function:actor.function});
});
it('creates manual reuse through the API from only its target and preserves required fields for new work',async()=>{
 const request = (fields:Record<string,unknown>)=>new Request('http://localhost/api/plan',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'add_proposal',gap_id:gapId,rationale:'Review existing output before adding work',actor_name:actor.name,actor_function:actor.function,...fields})});
 const response=await planPost(request({proposal_kind:'reuse',target_tactic_id:tacticId,conditions:['Confirm existing output availability']}));
 expect(response.status).toBe(200);
 const {proposal}=await response.json();
 expect(proposal).toMatchObject({proposal_kind:'reuse',target_tactic_id:tacticId,name:'Existing cohort',type:'rwe_study',evidence_question:'Safety',conditions:['Confirm existing output availability']});
 const invalidNew=await planPost(request({proposal_kind:'new'}));
 expect(invalidNew.status).toBe(400);
 expect(await invalidNew.json()).toMatchObject({error:'Name is required.'});
});
it('accepts unchanged reuse once under concurrent acceptance with an unassessed relationship and no new work',async()=>{
 const p=await addReuse(); const before=await loadState();
 expect(p.recommendation).toEqual(recommendation);
 const results=await Promise.allSettled([1,2].map(()=>decideIdeationProposal({id:p.id,decision:'accept',rationale:'Review coverage of unchanged evidence',actor})));
 expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
 const after=await loadState(); expect(after.tactics).toEqual(before.tactics); expect(after.expansions).toEqual(before.expansions);
 expect(after.gaps.find(gap=>gap.id===gapId)?.status).toBe(before.gaps.find(gap=>gap.id===gapId)?.status);
 expect(after.coverages.filter(c=>c.tactic_id===tacticId&&c.gap_id===gapId)).toMatchObject([{overall:'unassessed',needs_review:true}]);
 expect((await listIdeationProposals()).find(r=>r.id===p.id)).toMatchObject({status:'accepted',tactic_id:tacticId,expansion_id:null,recommendation});
 expect((await tacticDesigns()).has(tacticId)).toBe(false);
});
it('preserves the existing assessment and locks while requesting review',async()=>{
 const lock = {locked:true,actor_name:actor.name,actor_function:actor.function,locked_at:'2026-10-25T00:00:00Z',note:'Human assessment'};
 const dimensions = emptyDimensions(); dimensions.population = {value:'yes',rationale:'Recorded population fit',lock};
 await db().insert(core.coverages).values({id:'COV-existing',gap_id:gapId,tactic_id:tacticId,dimensions,overall:'partial',overall_rationale:'Recorded partial evidence',overall_lock:lock,stale:false,needs_review:false});
 const p=await addReuse(); const before=(await loadState()).coverages.find(c=>c.tactic_id===tacticId&&c.gap_id===gapId)!;
 await decideIdeationProposal({id:p.id,decision:'accept',rationale:'Check fit without reassessment',actor});
 const after=(await loadState()).coverages.find(c=>c.id===before.id)!;
 expect({...after,needs_review:before.needs_review,review_version:before.review_version}).toEqual(before);
 expect(after.needs_review).toBe(true);
});
it('keeps one relationship across separately reviewed reuse proposals and refuses repeated decisions',async()=>{
 const first = await addReuse(); const second = await addReuse();
 await decideIdeationProposal({id:first.id,decision:'accept',rationale:'Review existing evidence',actor});
 await expect(decideIdeationProposal({id:first.id,decision:'accept',rationale:'Repeat decision',actor})).rejects.toThrow(/already accepted/i);
 const current = (await listIdeationProposals()).find(proposal=>proposal.id===second.id)!;
 expect(current.context_stale).toBe(true);
 await decideIdeationProposal({id:second.id,decision:'accept',judgement_origin:'manual',reviewed_context_basis:current.current_context_basis,rationale:'Reviewed the existing relationship',actor});
 expect((await loadState()).coverages.filter(coverage=>coverage.gap_id===gapId&&coverage.tactic_id===tacticId)).toHaveLength(1);
});
it('rejects added design work and cancelled reuse targets without saving a proposal',async()=>{
 await expect(addIdeationProposal({gap_id:gapId,fields:{proposal_kind:'reuse',target_tactic_id:tacticId,name:'Reuse existing evidence',type:'rwe_study',evidence_question:'Safety',population:'New patients'},rationale:'Attempt new study work',actor})).rejects.toThrow(/preserve existing population/i);
 await db().update(core.tactics).set({status:'cancelled'}).where(eq(core.tactics.id,tacticId));
 await expect(addReuse()).rejects.toThrow(/eligible target/i);
 expect(await listIdeationProposals()).toEqual([]);
});
it('preserves a rejected relationship and rolls back the source acceptance',async()=>{
 await assignTacticToGap({gap_id:gapId,tactic_id:tacticId,human:true,actor_name:actor.name,actor_function:actor.function,note:'Initial relationship'});
 await unassignTacticFromGap({gap_id:gapId,tactic_id:tacticId,rationale:'Evidence incompatible',actor_name:actor.name,actor_function:actor.function});
 const p=await addReuse();
 await expect(decideIdeationProposal({id:p.id,decision:'accept',rationale:'Try unchanged evidence',actor})).rejects.toThrow(/reject|removed/i);
 expect((await listIdeationProposals()).find(r=>r.id===p.id)?.status).toBe('proposed');
 expect((await loadState()).coverages.some(c=>c.tactic_id===tacticId&&c.gap_id===gapId)).toBe(false);
});
it.each(['requirements','coverage','priority','lifecycle'] as const)('blocks stale %s even manually, then audits explicit current review without changing original basis',async(change)=>{
 const p=await addReuse();
 if(change==='requirements') await db().update(core.gaps).set({statement:'New comparative requirement'}).where(eq(core.gaps.id,gapId));
 if(change==='coverage') await db().insert(core.coverages).values({id:'COV-new',gap_id:gapId,tactic_id:tacticId,dimensions:emptyDimensions(),overall:'unassessed',overall_rationale:'New relationship',overall_lock:unlocked(),stale:false,needs_review:false});
 if(change==='priority') await db().update(tables.priorityPlacements).set({rationale:'Revised decision rationale'}).where(eq(tables.priorityPlacements.gap_id,gapId));
 if(change==='lifecycle') await db().update(core.tactics).set({status:'completed'}).where(eq(core.tactics.id,tacticId));
 await expect(decideIdeationProposal({id:p.id,decision:'accept',judgement_origin:'manual',rationale:'Old review reason',actor,fields:{idea_rationale:'Must not save on failure'}})).rejects.toThrow(/context changed.*review/i);
 const current=(await listIdeationProposals()).find(r=>r.id===p.id)!;
 expect(current.context_stale).toBe(true); expect(current.rationale).toBe(p.rationale);
 await expect(decideIdeationProposal({id:p.id,decision:'accept',judgement_origin:'manual',reviewed_context_basis:p.supporting_context_basis!,rationale:'Still stale',actor})).rejects.toThrow(/context changed.*review/i);
 await decideIdeationProposal({id:p.id,decision:'accept',judgement_origin:'manual',reviewed_context_basis:current.current_context_basis,rationale:'Reviewed the changed evidence context',actor});
 const accepted=(await listIdeationProposals()).find(r=>r.id===p.id)!;
 expect(accepted.supporting_context_basis).toBe(p.supporting_context_basis);
 expect(accepted.recommendation).toEqual(recommendation);
 expect(accepted.renewed_review).toMatchObject({basis:current.current_context_basis,actor:actor.name,rationale:'Reviewed the changed evidence context'});
});
it('retains optional manual checks through edits and new acceptance',async()=>{
 const p=await addIdeationProposal({gap_id:gapId,fields:{name:'New study',type:'rwe_study',evidence_question:'New safety',recommendation},rationale:'Conditional new work',actor});
 await editIdeationProposal({id:p.id,fields:{comparative_rationale:'Existing evidence cannot answer this question'},rationale:'Save comparison independently',actor});
 const result=await decideIdeationProposal({id:p.id,decision:'accept',rationale:'Plan conditional work',actor});
 const state=await loadState(); expect(state.tactics.find(t=>t.id===result.tactic_id)?.status).toBe('proposed');
 expect(state.coverages.find(c=>c.tactic_id===result.tactic_id)?.overall).toBe('unassessed');
 expect((await listIdeationProposals()).find(r=>r.id===p.id)?.recommendation?.feasibility.required_checks).toEqual(['Confirm comparator compatibility']);
});

it('preserves structured reasoning for an unchanged comparison and updates it for a changed human alternative',async()=>{
 const p=await addIdeationProposal({gap_id:gapId,fields:{name:'Generated study',type:'rwe_study',evidence_question:'Safety',recommendation,comparative_rationale:'Legacy generated comparison'},rationale:'Generated proposal',actor});
 await editIdeationProposal({id:p.id,fields:{name:'Renamed generated study',comparative_rationale:'Legacy generated comparison'},rationale:'Rename only',actor});
 expect((await listIdeationProposals()).find(row=>row.id===p.id)?.recommendation?.alternatives_rationale).toBe(recommendation.alternatives_rationale);
 await editIdeationProposal({id:p.id,fields:{comparative_rationale:'Human review found the registry adds unavailable outcomes'},rationale:'Record current alternatives',actor});
 const edited=(await listIdeationProposals()).find(row=>row.id===p.id)!;
 expect(edited.recommendation?.alternatives_rationale).toBe('Human review found the registry adds unavailable outcomes');
});

it('exposes retained accepted conditions through the shared read model and rejects malformed saved recommendation metadata',async()=>{
 const p=await addIdeationProposal({gap_id:gapId,fields:{name:'Conditional study',type:'rwe_study',evidence_question:'Safety',conditions:['Confirm site capacity']},rationale:'Manual conditional plan',actor});
 await editIdeationProposal({id:p.id,fields:{conditions:['Confirm ethics approval'],comparative_rationale:'Prefer prospective data'},rationale:'Review conditions separately',actor});
 const result=await decideIdeationProposal({id:p.id,decision:'accept',rationale:'Plan contingent work',actor});
 const contexts=acceptedIdeationContexts(await listIdeationProposals());
 expect(contexts).toMatchObject([{proposal_id:p.id,tactic_id:result.tactic_id,expansion_id:null,conditions:['Confirm ethics approval'],comparative_rationale:'Prefer prospective data'}]);
 const [raw]=await db().select().from(tables.ideationProposals).where(eq(tables.ideationProposals.id,p.id));
 const state=await loadState();
 const malformed=ideationProposalReadback({...raw,design:{...(raw.design as object),recommendation:{feasibility:{status:'credible',required_checks:[]}},supporting_context_basis:'bogus'}},state);
 expect(malformed.recommendation).toBeUndefined(); expect(malformed.supporting_context_basis).toBeUndefined();
 const historical = ideationProposalReadback({...raw,gap_id:'missing-historical-gap'},state);
 expect(historical.id).toBe(p.id); expect(historical.current_context).toBeUndefined(); expect(historical.current_context_basis).toBeUndefined();
});
it('retains each gap outcome when a later run considers a different gap',async()=>{
 const base = {workspace_id:'demo',stage:'S9' as const,module_id:'s9-ideation.pcj',module_version:'test',status:'ok' as const,actor_name:actor.name,actor_function:actor.function,input:{},steps:[]};
 await db().insert(tables.moduleRuns).values([
  {...base,id:'run-prior-gap',started_at:'2026-10-24T20:00:00Z',output:{gap_outcomes:[{gap_id:gapId,status:'no_timely_option',explanation:'No evidence available by the decision date'}]}},
  {...base,id:'run-other-gap',started_at:'2026-10-24T21:00:00Z',output:{gap_outcomes:[{gap_id:'other-gap',status:'no_credible_option',explanation:'Clarify the comparator first'}]}},
 ]);
 expect(await listIdeationGapOutcomes()).toEqual(expect.arrayContaining([
  expect.objectContaining({gap_id:gapId,status:'no_timely_option'}),
  expect.objectContaining({gap_id:'other-gap',status:'no_credible_option'}),
 ]));
});
it('reads a successful no-row generation outcome from persisted module output',async()=>{
 await db().insert(tables.moduleRuns).values({id:'run-no-option',workspace_id:'demo',stage:'S9',module_id:'s9-ideation.pcj',module_version:'test',status:'ok',started_at:new Date().toISOString(),actor_name:actor.name,actor_function:actor.function,input:{},steps:[],output:{proposals:[],rejected:[],gaps_considered:1,gap_outcomes:[{gap_id:gapId,status:'no_timely_option',explanation:'No credible option meets the decision date'}]}});
 expect(await listIdeationGapOutcomes()).toMatchObject([{gap_id:gapId,status:'no_timely_option',explanation:'No credible option meets the decision date'}]);
});


it.each(['draft', 'final'] as const)('freezes accepted checks in a %s snapshot and final package without reading later edits', async status => {
  const p = await addReuse();
  await decideIdeationProposal({id:p.id, decision:'accept', rationale:'Use existing work subject to comparator checks', actor});
  await addTimelineActivity({tactic_id:tacticId, start_date:'2027-01-01', end_date:'2027-05-01', rationale:'Schedule existing work', actor});
  if (status === 'final') await makeFinalReady(actor);
  const saved = await savePlan({status, note:'Freeze reviewed option checks', actor});
  const expected = acceptedIdeationContexts(await listIdeationProposals());
  expect(saved.snapshot).toMatchObject({accepted_ideation_context: expected});
  if (status === 'final') expect(saved.snapshot.package).toMatchObject({accepted_ideation_context: expected});
  const [row] = await db().select().from(tables.ideationProposals).where(eq(tables.ideationProposals.id,p.id));
  await db().update(tables.ideationProposals).set({design:{...(row.design as object),conditions:['Later live check'],recommendation:{...recommendation,feasibility:{status:'conditional',required_checks:['Later compatibility check']}}}}).where(eq(tables.ideationProposals.id,p.id));
  expect(acceptedIdeationContexts(await listIdeationProposals())[0].conditions).toContain('Later live check');
  const reopened = await planVersion(saved.version);
  expect(reopened?.snapshot).toMatchObject({accepted_ideation_context: expected});
  if (status === 'final') expect(reopened?.snapshot.package).toMatchObject({accepted_ideation_context: expected});
});

it.each(['reuse', 'expansion', 'new'] as const)('preserves tactic creation provenance after accepted %s', async kind => {
 await db().update(core.tactics).set({lifecycle_stage:'extracted',source_quote:'Extracted study from the source document'}).where(eq(core.tactics.id,tacticId));
  // Exercise the final-package consumer with accepted historical source rows.
  // An expansion identifies its parent, but did not create that parent.
  await db().insert(tables.ideationProposals).values({id:'idea-origin',gap_id:gapId,proposal_kind:kind,target_tactic_id:kind==='new'?null:tacticId,tactic_id:tacticId,expansion_id:kind==='expansion'?'EXP-child':null,name:'Accepted option',type:'rwe_study',evidence_question:'Safety',rationale:'Reviewed option',design:{},status:'accepted',created_at:new Date().toISOString()});
  const pkg = await buildFinalPackage({state:await loadState(),model:await timelineModel(),placements:await listPlacements(),axes:await loadAxes(),workspace_id:null,fingerprint:'test',fingerprint_code:'test',built_at:new Date().toISOString()});
  expect(pkg.evidence_tactics.find(tactic=>tactic.id===tacticId)?.origin).toBe(kind==='new'?'ideation':'source_document');
});
it.each(['reuse', 'expansion'] as const)('keeps a manually recorded quoted tactic as recorded after accepted %s', async kind => {
 await db().update(core.tactics).set({lifecycle_stage:'recorded',source_quote:'Reviewer recorded this supporting quote by hand'}).where(eq(core.tactics.id,tacticId));
 await db().insert(tables.ideationProposals).values({id:`idea-recorded-${kind}`,gap_id:gapId,proposal_kind:kind,target_tactic_id:tacticId,tactic_id:tacticId,expansion_id:kind==='expansion'?'EXP-recorded':null,name:'Accepted option',type:'rwe_study',evidence_question:'Safety',rationale:'Reviewed option',design:{},status:'accepted',created_at:new Date().toISOString()});
 const pkg = await buildFinalPackage({state:await loadState(),model:await timelineModel(),placements:await listPlacements(),axes:await loadAxes(),workspace_id:null,fingerprint:'test',fingerprint_code:'test',built_at:new Date().toISOString()});
 expect(pkg.evidence_tactics.find(tactic=>tactic.id===tacticId)?.origin).toBe('recorded_missed');
});
