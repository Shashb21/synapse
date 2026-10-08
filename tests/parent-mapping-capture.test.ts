/** Parent-row saves preserve child evidence and capture only the reviewed parent selection. */
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import '@/modules';
import {POST} from '@/app/api/iegp/route';
import {buildSeed} from '@/lib/iegp/seed';
import {persistState,loadState} from '@/lib/iegp/store';
import {acceptTacticExpansion,tacticVersion} from '@/lib/iegp/tactic-expansions';
import * as mapping from '@/lib/iegp/mapping-table';
import {listDecisionExamples} from '@/modules/kernel/decision-examples';
import {projectReplayDecision,scoreDecisionReplay} from '@/modules/kernel/decision-replay';
const actor={name:'Parent reviewer',function:'medical_affairs' as const};
beforeEach(async()=>{await persistState(buildSeed());});
afterEach(()=>vi.restoreAllMocks());
it('captures unchanged and changed parent selections without claiming a child decision',async()=>{
 const before=await loadState(),parent=before.tactics[0],gap=before.gaps[0];
 const scope={name:'Child',evidence_question:'Additional Q',population:'Older adults',outcomes:'Safety',geography:'',data_cut:'',analysis:'Analysis',instrument:'',study_design:'Analysis',gap_coverage:'Safety',cost_effort:'Low',timing:'Soon',feasibility_risks:'Small sample',post_hoc:true,prospective_enrolment:false,protocol_amendment:false,start_date:null,evidence_available:null};
 const child=await acceptTacticExpansion({proposal_id:`mapping-${crypto.randomUUID()}`,tactic_id:parent.id,gap_id:gap.id,scope,actor,rationale:'Additional scope',expected_tactic_version:tacticVersion(parent)});
 const childCoverage=(await loadState()).coverages.filter(c=>c.expansion_id===child.id);
 vi.spyOn(mapping,'latestS4MappingRows').mockResolvedValue([{gap_id:gap.id,mapping_status:'partially_addressed',tactic_ids:[parent.id,child.id],gap_name:gap.name,tactic_names:[parent.name,child.scope.name],confidence:90,rationale:['Fixture model row'],mappings:[],review:null}] as Awaited<ReturnType<typeof mapping.latestS4MappingRows>>);
 const save=async(ids:string[])=>POST(new Request('http://localhost/api/iegp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'save_mapping_row',gap_id:gap.id,tactic_ids:ids.join(','),mapping_status:'partially_addressed',rationale:'Review parent selection',actor_name:actor.name,actor_function:actor.function})}));
 for (const ids of [[parent.id],[before.tactics[1].id]]) {
  const response=await save(ids);expect(response.status).toBe(200);
  expect((await loadState()).coverages.filter(c=>c.expansion_id===child.id)).toEqual(childCoverage);
  const example=(await listDecisionExamples({workspace_id:'default',stage:'S4',limit:null})).find(e=>e.subject_id===gap.id)!;
  expect(example.ai_input).toMatchObject({mapping_scope:'parents'});
  expect(example.ai_output.tactic_ids).toEqual([parent.id]);
  expect(example.outcome).toBe(ids[0]===parent.id?'accepted':'edited');
  if(example.final)expect(example.final.tactic_ids).toEqual(ids);
  const projected=projectReplayDecision(example,{accepted:[{gap_id:gap.id,mapping_status:'partially_addressed',tactic_ids:[...ids,child.id]}]});
  expect(projected?.tactic_ids).toEqual(ids);
  expect(scoreDecisionReplay(example,projected).metrics.every(m=>m.value===1)).toBe(true);
 }
});
