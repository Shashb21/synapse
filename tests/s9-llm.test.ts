import { priorityDecision } from "./support/priority-decision";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "@/modules";
import * as routing from '@/modules/kernel/routing';
import {listDecisionExamples,getDecisionExample} from '@/modules/kernel/decision-examples';
import { wipePlatform } from "@/modules/kernel/db";
import type { ModuleContext, ResolvedRoute } from "@/modules/kernel/contracts";
import { NoRouteError } from "@/modules/llm/provider";
import { displayedGapStatus, isLiveGap } from "@/lib/iegp/engine";
import { createGap, createProposedTactic, loadState, resetDemoSetup } from "@/lib/iegp/store";
import { validatePlacement } from "@/modules/stages/s8-prioritization/module";
import { ideationModule } from "@/modules/stages/s9-ideation/module";

/**
 * The model path of S9, with a scripted model in place of a provider: the
 * designs (timing included), the critic and the judge are all the model, an
 * invalid answer is asked for again, and nothing is filled in by rule.
 */

const ACTOR = { name: "LLM Test", function: "medical_affairs" as const };

type Call = { purpose: string; system: string; body: Record<string, unknown> };
type Script = (call: Call) => unknown;

function route(connected: boolean): ResolvedRoute {
  return {
    stage: "S9",
    provider_id: "anthropic-claude",
    provider_label: "Claude",
    model: "claude-test",
    auth: connected ? "api_key" : "none",
    connected,
    params: { temperature: 0, max_tokens: 4096 },
    fallbacks: [],
    degraded: false,
    reason: connected ? null : "No LLM provider has an API key. Set one in the server environment (status in /admin/control).",
  };
}

function context(script: Script, connected = true, adaptProposer = true): { ctx: ModuleContext; calls: Call[] } {
  const calls: Call[] = [];
  const ctx: ModuleContext = {
    ai: true,
    workspace_id: "default",
    actor: ACTOR,
    role: "medical_affairs",
    route: route(connected),
    run: { id: "test", step: async (_name, fn) => fn(), note: () => {}, steps: () => [] },
    complete: async ({ purpose, system, user }) => {
      const call = { purpose, system, body: JSON.parse(user) as Record<string, unknown> };
      calls.push(call);
      const reply = await script(call);
      // A model answers the gaps it was asked about: the proposer asks one gap at a time (KAN-148).
      if (adaptProposer && purpose === "ideation-proposer" && reply && Array.isArray((reply as { tactics?: unknown }).tactics)) {
        const [gap] = gapsOf(call);
        const tactics = (reply as { tactics: { id?: string; gap_id?: string }[] }).tactics.filter(row => !row.gap_id || gap?.id === row.gap_id);
        return { ...reply, tactics: tactics.map((row, index) => ({ ...row, id: row.id ?? gap?.proposal_slots?.[index] })) };
      }
      return reply;
    },
  };
  return { ctx, calls };
}

type PromptGap = { id: string; proposal_slots?: string[]; revise?: { id: string; objection: string }[]; problems?: string[] };
type PromptTactic = { id: string; gap_id: string; name: string };
type JudgeGap = {
  id: string;
  problem?: string;
  outcome_requested?: boolean;
  candidates: { id: string; name: string }[];
  completed_candidates?: {
    id: string;
    name: string;
    recommendation: { deadline: { status: string; explanation: string } };
    decision: { verdict: string; rank: number | null; reason: string };
  }[];
};

const gapsOf = (call: Call) => call.body.gaps as PromptGap[];
const tacticsOf = (call: Call) => call.body.tactics as PromptTactic[];
const judgeGapsOf = (call: Call) => call.body.gaps as JudgeGap[];

const support = (gapId: string) => [{ entity_type: "gap", entity_id: gapId, reason: "The supplied gap identifies the evidence need considered by this judgement" }];

function tactic(gap_id: string, name: string, overrides: Record<string, unknown> = {}) {
  return {
    gap_id,
    references: support(gap_id),
    proposal_kind: "new",
    target_tactic_id: null,
    expansion_scope: null,
    name,
    type: "rwe_study",
    evidence_question: `Question for ${name}`,
    rationale: `Why ${name}`,
    comparative_rationale: "New study adds data unavailable from existing scope; more time/cost but credible quality and feasibility",
    contract_version: 2,
    recommendation: {
      remaining_need: "The supplied gap remains unresolved by the recorded evidence.",
      incremental_contribution: "Assess the proposed design's additional evidence against confirmed requirements.",
      alternatives_rationale: "Review existing output and added analysis before commissioning this separate activity.",
      feasibility: { status: "unknown", required_checks: ["Confirm required data, design compatibility and available resources before proceeding."] },
      coverage_discrepancy: null,
      deadline: { status: "unknown", explanation: "Compare the proposed evidence availability with the objective evidence deadline." },
    },
    population: "Adults on therapy",
    comparator: "Standard of care",
    outcomes: "OS",
    data_source: "Claims",
    study_design: "Retrospective cohort",
    duration_months: 11,
    readout_lag_months: 4,
    timing_rationale: `Timing for ${name}`,
    ...overrides,
    ...(overrides.expansion_scope ? Object.fromEntries(Object.entries(overrides.expansion_scope as Record<string,unknown>).filter(([key]) => ["name","evidence_question","population","outcomes","study_design"].includes(key))) : {}),
  };
}

const keepAll = (call: Call) => ({
  reviews: tacticsOf(call).map((row) => ({ id: row.id, references: support(row.gap_id), verdict: "keep", confidence: 70, note: `holds: ${row.name}` })),
});

/** Accepts the first `take` candidates of each gap, ranked in order. */
const judgeFirst = (call: Call, take: number) => ({
  gaps: judgeGapsOf(call).map((gap) => ({
    gap_id: gap.id,
    outcome: { status: "options", explanation: "Candidates were reviewed for this need." },
    decisions: gap.candidates.map((candidate, index) => ({
      id: candidate.id,
      references: support(gap.id),
      verdict: index < take ? "accept" : "reject",
      rank: index < take ? index + 1 : null,
      confidence: 90 - index * 10,
      reason: `judge on ${candidate.name}`,
    })),
  })),
});

describe("S9 on the model path", () => {
  let ids: string[] = [];
  let libraryId = "";
  let savedStub: string | undefined;
  let priorExamples = new Set<string>();

  beforeAll(async () => {
    await resetDemoSetup();
    await wipePlatform();
    for (const statement of [
      "No comparative effectiveness data versus standard of care for the payer dossier.",
      "Long-term safety in elderly patients is unknown.",
    ]) {
      await createGap({ statement, actor_name: ACTOR.name, actor_function: ACTOR.function });
    }
    await createProposedTactic({
      name: "Existing comparative cohort",
      type: "rwe_study",
      description: "Library tactic the critic can point a duplicate at.",
      evidence_question: "Comparative effectiveness versus standard of care",
      population: "Adults on therapy",
      intervention: "Asset",
      comparator: "Standard of care",
      outcomes: "OS",
      geography: "EU",
      owner: ACTOR.name,
      function: ACTOR.function,
      residual_ids: [],
      actor_name: ACTOR.name,
      actor_function: ACTOR.function,
    });
    const state = await loadState();
    ids = state.gaps
      .filter((gap) => isLiveGap(gap) && displayedGapStatus(gap) === "validated_open")
      .map((gap) => gap.id)
      .slice(0, 2);
    expect(ids).toHaveLength(2);
    for (const gap_id of ids) await validatePlacement({ ...await priorityDecision(gap_id, "Blocks dossier"),gap_id,band:"high",rationale:"Blocks dossier",actor:ACTOR});
    libraryId = state.tactics[0]!.id;
  }, 60_000);

  beforeEach(async () => {
    priorExamples = new Set((await listDecisionExamples({workspace_id:'default',stage:'S9',limit:null})).map(row=>row.id));
    vi.spyOn(routing,'resolveRoute').mockResolvedValue(route(true));
    vi.spyOn(routing,'completionFor').mockReturnValue(async () => ({lesson:'Reviewers require feasible added scope.'}));
    savedStub = process.env.SYNAPSE_TEST_STUB_LLM;
    delete process.env.SYNAPSE_TEST_STUB_LLM;
  });
  afterEach(async () => {
    const created=(await listDecisionExamples({workspace_id:'default',stage:'S9',limit:null})).filter(row=>!priorExamples.has(row.id));
    // Await test-owned background work before restoring its completion provider.
    for(const row of created) {
      if (process.env.SYNAPSE_TEST_STUB_LLM !== '1') await vi.waitFor(async()=>expect((await getDecisionExample(row.id))?.lesson_status).toBe('ok'));
    }
    vi.restoreAllMocks();
    if (savedStub === undefined) delete process.env.SYNAPSE_TEST_STUB_LLM;
    else process.env.SYNAPSE_TEST_STUB_LLM = savedStub;
  });

  const input = (per_gap = 1) => ideationModule.inputSchema.parse({ gap_ids: ids, per_gap, dry_run: true });

  it("explicit IDs cannot bypass human-validated High priority", async () => {
    await validatePlacement({ ...await priorityDecision(ids[0]!, "Later cycle"),gap_id:ids[0]!,band:"medium",rationale:"Later cycle",actor:ACTOR});
    const {ctx} = context(call => call.purpose === "ideation-proposer" ? {tactics:gapsOf(call).map(g=>tactic(g.id,"Eligible"))} : call.purpose === "ideation-critic" ? keepAll(call) : judgeFirst(call,1));
    const {output} = await ideationModule.run(input(),ctx);
    expect(output.gaps_considered).toBe(1); expect(output.proposals.map(p=>p.gap_id)).toEqual([ids[1]]);
    await validatePlacement({ ...await priorityDecision(ids[0]!, "Blocks dossier"),gap_id:ids[0]!,band:"high",rationale:"Blocks dossier",actor:ACTOR});
  });
  it("throws before doing anything when no LLM is connected", async () => {
    const { ctx, calls } = context(() => ({}), false);
    await expect(ideationModule.run(input(), ctx)).rejects.toBeInstanceOf(NoRouteError);
    expect(calls).toHaveLength(0);
  });

  it("takes designs, critique and judgement from the model", async () => {
    const [a, b] = ids as [string, string];
    let criticRounds = 0;
    const { ctx, calls } = context((call) => {
      if (call.purpose === "ideation-proposer") {
        const gaps = gapsOf(call);
        if (gaps.some((gap) => gap.revise?.length)) {
          return {
            tactics: gaps.flatMap((gap) =>
              (gap.revise ?? []).map((row) => ({
                ...tactic(gap.id, "A1 revised", { comparator: "Physician's choice", duration_months: 18 }),
                id: row.id,
              })),
            ),
          };
        }
        return {
          tactics: [tactic(a, "A1"), tactic(a, "A2"), tactic(b, "B1"), tactic(b, "B2", { type: "itc", readout_lag_months: 0 })],
        };
      }
      if (call.purpose === "ideation-critic") {
        criticRounds += 1;
        if (criticRounds > 1) return keepAll(call);
        return {
          reviews: tacticsOf(call).map((row) =>
            row.name === "A1"
              ? { id: row.id, references: support(row.gap_id), verdict: "revise", confidence: 40, note: "comparator should be physician's choice", issues: ["comparator"] }
              : row.name === "A2"
                ? { id: row.id, references: support(row.gap_id), verdict: "drop", confidence: 10, note: "library already has this", duplicate_of: libraryId }
                : { id: row.id, references: support(row.gap_id), verdict: "keep", confidence: 75, note: `holds: ${row.name}` },
          ),
        };
      }
      // Judge: prefer B2 over B1 to show rank comes from the model.
      return {
        gaps: judgeGapsOf(call).map((gap) => ({
          gap_id: gap.id,
          outcome: { status: "options", explanation: "Candidates were reviewed for this need." },
          decisions: gap.candidates.map((candidate) => ({
            id: candidate.id,
      references: support(gap.id),
            verdict: candidate.name === "B1" ? "reject" : "accept",
            rank: candidate.name === "B1" ? null : 1,
            confidence: candidate.name === "B1" ? 30 : 88,
            reason: `judge on ${candidate.name}`,
          })),
        })),
      };
    });

    const { output } = await ideationModule.run(input(1), ctx);

    expect(output.mode).toBe("llm");
    expect(calls.filter((call) => call.purpose === "ideation-critic")).toHaveLength(3);
    const judge = calls.filter((call) => call.purpose === "ideation-judge");
    expect(judge).toHaveLength(1);
    // The dropped duplicate never reaches the judge.
    expect(judgeGapsOf(judge[0]!).flatMap((gap) => gap.candidates.map((row) => row.name)).sort()).toEqual([
      "A1 revised",
      "B1",
      "B2",
    ]);
    const revision = calls.find((call) => call.purpose === "ideation-proposer" && gapsOf(call).some((gap) => gap.revise?.length))!;
    expect(gapsOf(revision).map((gap) => gap.id)).toEqual([a]);
    expect(gapsOf(revision)[0]!.revise![0]!.objection).toBe("comparator should be physician's choice");
    expect(gapsOf(revision)[0]!.proposal_slots).toBeUndefined();
    expect(revision.system).toMatch(/carries revise requests, answer each one/);
    expect(revision.system).toMatch(/"duration_months":[1-9]\d*/);
    expect(revision.system).toMatch(/When neither proposal_slots nor revise ids are supplied, return an empty tactics list/);

    expect(output.proposals.map((row) => row.name)).toEqual(["A1 revised", "B2"]);
    const [first, second] = output.proposals as [(typeof output.proposals)[0], (typeof output.proposals)[0]];
    expect(first.design).toMatchObject({ comparator: "Physician's choice", duration_months: 18, readout_lag_months: 4, timing_rationale: "Timing for A1 revised" });
    expect(first).toMatchObject({ score: 88, rank: 1, judge_note: "judge on A1 revised" });
    expect(second).toMatchObject({ type: "itc", design: { duration_months: 11, readout_lag_months: 0 } });
    expect(output.rejected.map((row) => row.name)).toEqual(["B1"]);
    expect(output.rejected[0]).toMatchObject({ judge_note: "judge on B1", rank: null, score: 30 });
  });

  it("compares expansions and new options with the full library design/status for proposer, critic and judge", async () => {
    const target = await createProposedTactic({name:"Completed safety trial",type:"phase3_trial",description:"Locked trial dataset",evidence_question:"Overall safety",population:"Adults",intervention:"Asset",comparator:"SOC",outcomes:"AE",study_design:"Randomized trial",data_source:"Trial dataset",owner:ACTOR.name,function:ACTOR.function,residual_ids:[],status:"completed",actor_name:ACTOR.name,actor_function:ACTOR.function});
    const scope = {name:"Elderly analysis",evidence_question:"Safety in 75+?",population:"Age 75+",outcomes:"AESI",geography:"",data_cut:"Locked trial data",analysis:"Post-hoc subgroup",instrument:"",study_design:"Retrospective subgroup analysis",gap_coverage:"Elderly safety",cost_effort:"Two analyst months",timing:"3 months",feasibility_risks:"Small subgroup",post_hoc:true,prospective_enrolment:false,protocol_amendment:false,start_date:null,evidence_available:null};
    const {ctx,calls}=context(call => {
      if (call.purpose === "ideation-proposer") return {tactics:gapsOf(call).flatMap(gap=>[tactic(gap.id,"Expand safety",{proposal_kind:"expansion",target_tactic_id:target,expansion_scope:scope,comparative_rationale:"Existing data is faster and cheaper; small sample reduces quality"}),tactic(gap.id,"New safety cohort")])};
      if (call.purpose === "ideation-critic") return keepAll(call);
      return judgeFirst(call,2);
    });
    const {output}=await ideationModule.run(input(2),ctx);
    expect(output.proposals.filter(p=>p.proposal_kind === "expansion")).toHaveLength(2);
    for (const purpose of ["ideation-proposer","ideation-critic","ideation-judge"]) {
      const lib=calls.find(c=>c.purpose === purpose)!.body.library as Record<string,unknown>[];
      expect(lib.find(t=>t.id===target)).toMatchObject({status:"completed",study_design:"Randomized trial",data_source:"Trial dataset",description:"Locked trial dataset"});
    }
  });
  it("preserves expansion AI baseline, rejection memory across reruns and explicit restore", async () => {
    const {RunRecorder,openRun,closeRun}=await import("@/modules/kernel/observability");
    const {listIdeationProposals,decideIdeationProposal,restoreIdeationProposal,editIdeationProposal}=await import("@/modules/stages/s9-ideation/module");
    const {sharedDb}=await import("@/modules/kernel/db"); const {sql}=await import("drizzle-orm");
    const target=await createProposedTactic({name:"Completed baseline trial",type:"phase3_trial",description:"Existing data",evidence_question:"Overall safety",population:"Adults",intervention:"Asset",comparator:"SOC",outcomes:"AE",owner:ACTOR.name,function:ACTOR.function,residual_ids:[],status:"completed",actor_name:ACTOR.name,actor_function:ACTOR.function});
    const scope={name:"Elderly analysis",evidence_question:"Safety in 75+?",population:"Age 75+",outcomes:"AESI",geography:"",data_cut:"Locked data",analysis:"Post-hoc subgroup",instrument:"",study_design:"Retrospective analysis",gap_coverage:"Elderly safety",cost_effort:"Two analyst months",timing:"3 months",feasibility_risks:"Small sample",post_hoc:true,prospective_enrolment:false,protocol_amendment:false,start_date:null,evidence_available:null};
    const script:Script=call=>call.purpose === "ideation-proposer" ? {tactics:gapsOf(call).map(g=>tactic(g.id,"Baseline expansion",{proposal_kind:"expansion",target_tactic_id:target,expansion_scope:scope}))} : call.purpose === "ideation-critic" ? keepAll(call) : {gaps:judgeFirst(call,1).gaps.map(gap=>({...gap,outcome:{status:"options",explanation:"Candidate expansion available for review."}}))};
    const recorder=new RunRecorder({workspace_id:"default",stage:"S9",module_id:ideationModule.manifest.id,module_version:ideationModule.manifest.version,actor:ACTOR,input:{gap_ids:ids}});
    await openRun(recorder); const {ctx}=context(script); ctx.run=recorder;
    const generated=await ideationModule.run({...input(),dry_run:false},ctx); await closeRun({recorder,status:"ok",output:generated.output,route:ctx.route});
    const p=(await listIdeationProposals()).find(p=>p.target_tactic_id===target && p.gap_id===ids[0])!;
    await decideIdeationProposal({id:p.id,decision:"reject",rationale:"Feasibility pending",actor:ACTOR});
    const rerun=await ideationModule.run(input(),context(script).ctx); expect(rerun.output.proposals.some(p=>p.gap_id===ids[0])).toBe(false);
    expect(rerun.output.gap_outcomes.find(gap=>gap.gap_id===ids[0])).toMatchObject({status:"no_credible_option",explanation:expect.stringContaining("unresolved")});
    await restoreIdeationProposal({id:p.id,rationale:"New feasibility information",actor:ACTOR});
    const restored=await ideationModule.run(input(),context(script).ctx); expect(restored.output.proposals.some(p=>p.gap_id===ids[0])).toBe(true);
    const editedScope={...scope,cost_effort:"One analyst month"};
    await editIdeationProposal({id:p.id,fields:{expansion_scope:editedScope,comparator:"Active comparator cohort",data_source:"Linked registry"},rationale:"Human budget refinement",actor:ACTOR});
    await ideationModule.run({...input(),dry_run:false},context(script).ctx);
    expect((await listIdeationProposals()).find(r=>r.id===p.id)?.expansion_scope).toEqual(editedScope);
    await decideIdeationProposal({id:p.id,decision:"accept",rationale:"Credible existing data",actor:ACTOR});
    const acceptedState=await loadState();
    const acceptedChild=acceptedState.expansions.find(child=>child.proposal_id===p.id)!;
    expect(acceptedChild.scope).toMatchObject({type:'rwe_study',comparator:'Active comparator cohort',data_source:'Linked registry'});
    const {buildTimeline}=await import('@/modules/stages/s10-timeline/build');
    const timelineArgs={state:acceptedState,placements:[]};
    expect(buildTimeline(timelineArgs).pending.find(row=>row.expansion_id===acceptedChild.id)).toMatchObject({tactic_type:'rwe_study',meta:{comparator:'Active comparator cohort',data_source:'Linked registry'}});
    expect(buildTimeline({...timelineArgs,overrides:[{id:`ACT-EXP-${acceptedChild.id}`,start_date:'2026-11-01',end_date:'2027-02-01',readout_date:null,lane:'high',depends_on:[],meta:{manual:true}}]}).activities.find(row=>row.expansion_id===acceptedChild.id)).toMatchObject({tactic_type:'rwe_study',meta:{comparator:'Active comparator cohort',data_source:'Linked registry'}});
    const observations=await sharedDb().execute(sql`select ai_output, final, outcome from decision_examples where run_id=${recorder.id} and subject_id=${p.id}`);
    expect(observations).toHaveLength(2);
    const accepted=observations.find(row=>row.outcome==='edited')!;
    expect(accepted.ai_output).toMatchObject({proposal_kind:"expansion",target_tactic_id:target,expansion_scope:scope});
    expect(accepted.final).toMatchObject({proposal_kind:"expansion",target_tactic_id:target,expansion_scope:editedScope});
    await expect(decideIdeationProposal({id:p.id,decision:"accept",rationale:"Duplicate decision",actor:ACTOR})).rejects.toThrow(/already accepted/);
    expect(await sharedDb().execute(sql`select id from decision_examples where run_id=${recorder.id} and subject_id=${p.id}`)).toHaveLength(2);
  });
  it.each(["unknown-target", "incomplete-scope", "completed-prospective", "unmarked-posthoc"])("fails closed on invalid model expansion: %s", async defect => {
    const target=await createProposedTactic({name:"Completed validation trial",type:"phase3_trial",description:"Existing data",evidence_question:"Overall safety",population:"Adults",intervention:"Asset",comparator:"SOC",outcomes:"AE",owner:ACTOR.name,function:ACTOR.function,residual_ids:[],status:"completed",actor_name:ACTOR.name,actor_function:ACTOR.function});
    const scope={name:"Elderly analysis",evidence_question:"Safety in 75+?",population:"Age 75+",outcomes:"AESI",geography:"",data_cut:"Locked data",analysis:"Post-hoc subgroup",instrument:"",study_design:"Retrospective analysis",gap_coverage:"Elderly safety",cost_effort:defect === "incomplete-scope" ? "" : "Two analyst months",timing:"3 months",feasibility_risks:"Small sample",post_hoc:defect !== "unmarked-posthoc",prospective_enrolment:defect === "completed-prospective",protocol_amendment:false,start_date:null,evidence_available:null};
    const {ctx}=context(call=>({tactics:gapsOf(call).map(g=>tactic(g.id,"Invalid expansion",{proposal_kind:"expansion",target_tactic_id:defect === "unknown-target" ? "TAC-unknown" : target,expansion_scope:scope}))}));
    await expect(ideationModule.run(input(),ctx)).rejects.toThrow(/did not return a complete set of tactic designs/);
  });
  it('repairs contradictory common and added scope designs rather than dropping either',async()=>{
    const target=await createProposedTactic({name:'Completed conflict trial',type:'phase3_trial',description:'Dataset',evidence_question:'Safety',population:'Adults',intervention:'Asset',comparator:'SOC',outcomes:'AE',owner:ACTOR.name,function:ACTOR.function,residual_ids:[],status:'completed',actor_name:ACTOR.name,actor_function:ACTOR.function});
    const scope={name:'Child',evidence_question:'Added Q',population:'Older adults',outcomes:'Safety',geography:'',data_cut:'',analysis:'Post-hoc subgroup',instrument:'',study_design:'Analysis',gap_coverage:'Safety',cost_effort:'Low',timing:'Soon',feasibility_risks:'Small sample',post_hoc:true,prospective_enrolment:false,protocol_amendment:false,start_date:null,evidence_available:null};
    let attempts=0;
    const {ctx,calls}=context(call=>{
      if(call.purpose === 'ideation-critic')return keepAll(call);
      if(call.purpose === 'ideation-judge')return judgeFirst(call,1);
      attempts++;
      return {tactics:gapsOf(call).map(g=>({...tactic(g.id,'Child',{proposal_kind:'expansion',target_tactic_id:target,expansion_scope:scope}),population:attempts===1?'Conflicting adults':scope.population}))};
    });
    const {output}=await ideationModule.run(input(),ctx);
    expect(calls.filter(c=>c.purpose==='ideation-proposer').length).toBeGreaterThan(1);
    expect(output.proposals.every(p=>p.design.population===scope.population)).toBe(true);
  });
  it.each([
    {proposal_kind:undefined}, {proposal_kind:null}, {target_tactic_id:undefined}, {target_tactic_id:123},
    {target_tactic_id:{id:'TAC-001'}}, {proposal_kind:'unknown'},
    {proposal_kind:'new',target_tactic_id:'TAC-001'}, {proposal_kind:'expansion',target_tactic_id:null},
  ])('repairs malformed current discriminator/target %j before persistence', async defect => {
    const {listIdeationProposals}=await import('@/modules/stages/s9-ideation/module');
    let attempts=0;
    const {ctx,calls}=context(call => {
      if(call.purpose === 'ideation-critic') return keepAll(call);
      if(call.purpose === 'ideation-judge') return judgeFirst(call,1);
      attempts++;
      return {tactics:gapsOf(call).map(g=>tactic(g.id,attempts === 1 ? 'Invalid current contract' : 'Repaired explicit kind',attempts === 1 ? defect : {}))};
    });
    const before=(await listIdeationProposals()).map(p=>p.id);
    const {output}=await ideationModule.run({...input(),dry_run:false},ctx);
    expect(calls.filter(c=>c.purpose === 'ideation-proposer').length).toBeGreaterThan(1);
    expect(output.proposals.every(p=>p.name === 'Repaired explicit kind' && p.proposal_kind === 'new' && p.target_tactic_id === null)).toBe(true);
    expect((await listIdeationProposals()).filter(p=>!before.includes(p.id)).every(p=>p.name === 'Repaired explicit kind')).toBe(true);
  });
  it('fails without persistence when an absent kind is never repaired',async()=>{
    const {listIdeationProposals}=await import('@/modules/stages/s9-ideation/module');
    const before=await listIdeationProposals();
    const {ctx}=context(call=>call.purpose === 'ideation-proposer' ? {tactics:gapsOf(call).map(g=>tactic(g.id,'Never valid',{proposal_kind:undefined}))} : call.purpose === 'ideation-critic' ? keepAll(call) : judgeFirst(call,1));
    await expect(ideationModule.run({...input(),dry_run:false},ctx)).rejects.toThrow(/complete set of tactic designs/);
    expect(await listIdeationProposals()).toEqual(before);
  });
  it.each(["proposer", "critic", "judge"])("refuses unsupported %s output without persisting an option", async stage => {
    const { listIdeationProposals } = await import("@/modules/stages/s9-ideation/module");
    const before = await listIdeationProposals();
    const { ctx } = context(call => {
      if (call.purpose === "ideation-proposer") return { tactics: gapsOf(call).map(g => tactic(g.id, "Unsupported fixture", stage === "proposer" ? { references: [{ entity_type: "gap", entity_id: "foreign-gap", reason: "An inaccessible record is not supplied support" }] } : {})) };
      if (call.purpose === "ideation-critic") {
        const result = keepAll(call);
        return stage === "critic" ? { reviews: result.reviews.map(row => ({ ...row, references: [] })) } : result;
      }
      const result = judgeFirst(call, 1);
      return stage === "judge" ? { gaps: result.gaps.map(gap => ({ ...gap, decisions: gap.decisions.map(row => ({ ...row, references: [] })) })) } : result;
    });
    await expect(ideationModule.run({ ...input(), dry_run: false }, ctx)).rejects.toThrow(/did not return a complete/);
    expect(await listIdeationProposals()).toEqual(before);
  });

  it("asks again for a gap whose tactic has an invalid type or no duration", async () => {
    const [a, b] = ids as [string, string];
    let firstForB = true;
    const { ctx, calls } = context((call) => {
      if (call.purpose === "ideation-critic") return keepAll(call);
      if (call.purpose === "ideation-judge") return judgeFirst(call, 1);
      // One gap per proposer call (KAN-148): A is fine; B's first answer is broken.
      if (gapsOf(call).some((gap) => gap.id === a)) return { tactics: [tactic(a, "A1")] };
      if (firstForB) {
        firstForB = false;
        const broken = tactic(b, "B broken", { type: "moonshot" }) as Record<string, unknown>;
        delete broken.duration_months;
        return { tactics: [broken] };
      }
      return { tactics: gapsOf(call).map((gap) => tactic(gap.id, "B fixed", { duration_months: 7, readout_lag_months: 2 })) };
    });

    const { output } = await ideationModule.run(input(1), ctx);

    const retry = calls.find((call) => call.purpose === "ideation-proposer" && gapsOf(call).some((gap) => gap.problems?.length))!;
    expect(gapsOf(retry).map((gap) => gap.id)).toEqual([b]);
    const problems = gapsOf(retry)[0]!.problems!.join(" ");
    expect(problems).toMatch(/moonshot/);
    expect(problems).toMatch(/duration_months/);
    const fixed = output.proposals.find((row) => row.gap_id === b)!;
    expect(fixed).toMatchObject({ name: "B fixed", design: { duration_months: 7, readout_lag_months: 2 } });
  });

  it("fails the run when the model never returns a valid design", async () => {
    const [a, b] = ids as [string, string];
    const { ctx } = context((call) => {
      if (call.purpose === "ideation-critic") return keepAll(call);
      if (call.purpose === "ideation-judge") return judgeFirst(call, 1);
      return { tactics: [tactic(a, "A1"), tactic(b, "B1", { duration_months: 0 })] };
    });
    await expect(ideationModule.run(input(1), ctx)).rejects.toThrow(/did not return a complete set of tactic designs/);
  });

  it("re-asks a judge that keeps more than per_gap, and fails if it never complies", async () => {
    const [a, b] = ids as [string, string];
    const proposer = () => ({ tactics: [tactic(a, "A1"), tactic(a, "A2"), tactic(a, "A3"), tactic(b, "B1")] });
    let judgeCalls = 0;
    const { ctx, calls } = context((call) => {
      if (call.purpose === "ideation-proposer") return proposer();
      if (call.purpose === "ideation-critic") return keepAll(call);
      judgeCalls += 1;
      return judgeFirst(call, judgeCalls === 1 ? 3 : 0);
    });

    const { output } = await ideationModule.run(input(2), ctx);

    const judge = calls.filter((call) => call.purpose === "ideation-judge");
    expect(judge).toHaveLength(2);
    expect(judgeGapsOf(judge[1]!).map((gap) => gap.id)).toEqual([a]);
    expect(judgeGapsOf(judge[1]!)[0]!.problem).toMatch(/at most 2/);
    expect(output.proposals.filter((row) => row.gap_id === a).map((row) => row.rank)).toEqual([1, 2]);
    expect(output.rejected.map((row) => row.name)).toEqual(["A3"]);

    const always = context((call) => {
      if (call.purpose === "ideation-proposer") return proposer();
      if (call.purpose === "ideation-critic") return keepAll(call);
      return judgeFirst(call, 3);
    });
    await expect(ideationModule.run(input(2), always.ctx)).rejects.toThrow(/did not return a complete judgement/);
  });

  it("preserves valid sibling rows while repairing only invalid proposals, reviews and judgements", async () => {
    const gapId = ids[0]!;
    let propose = 0;
    let critic = 0;
    let judge = 0;
    const { ctx, calls } = context(call => {
      if (call.purpose === "ideation-proposer") {
        const gap = gapsOf(call)[0]!;
        const slots = gap.proposal_slots ?? [`${gapId}:proposal:1`, `${gapId}:proposal:2`];
        propose++;
        if (propose > 1) return { tactics: [tactic(gapId, "Repaired", { id: slots.at(-1) })] };
        return { tactics: [
          tactic(gapId, "Preserved", { id: slots[0] }),
          tactic(gapId, "Invalid", { id: slots[1], references: support(ids[1]!) }),
        ] };
      }
      if (call.purpose === "ideation-critic") {
        const answer = keepAll(call);
        if (++critic > 1) return answer;
        return { reviews: [answer.reviews[0], answer.reviews[1], answer.reviews[1]] };
      }
      const answer = judgeFirst(call, 1);
      if (++judge > 1) {
        return { gaps: answer.gaps.map(gap => ({ ...gap, decisions: gap.decisions.map(row => ({ ...row, verdict: "reject", rank: null })) })) };
      }
      return { gaps: answer.gaps.map(gap => ({ ...gap, decisions: gap.decisions.slice(0, 1) })) };
    });
    const request = { ...input(2), gap_ids: [gapId] };
    ctx.replay = { evaluation: true, input: request, facts: await ideationModule.freeze!(request), module_id: ideationModule.manifest.id, module_version: ideationModule.manifest.version, prompt_version: "base" };

    const { output } = await ideationModule.run(request, ctx);

    const proposer = calls.filter(call => call.purpose === "ideation-proposer");
    expect(gapsOf(proposer[1]!)[0]!.proposal_slots).toEqual([`${gapId}:proposal:2`]);
    expect(tacticsOf(calls.filter(call => call.purpose === "ideation-critic")[1]!).map(row => row.name)).toEqual(["Repaired"]);
    expect(judgeGapsOf(calls.filter(call => call.purpose === "ideation-judge")[1]!)[0]!.candidates.map(row => row.name)).toEqual(["Repaired"]);
    expect(output.proposals.map(row => row.name)).toEqual(["Preserved"]);
    expect(output.rejected.map(row => row.name)).toEqual(["Repaired"]);
  });

  it("preserves a deadline outcome across partial retries when the final candidates are withdrawn", async () => {
    const [gapId, otherId] = ids as [string, string];
    const deadline = { gap_id: gapId, status: "no_timely_option", explanation: "Claims and registry readouts both fall after the evidence deadline." };
    const otherOutcome = { gap_id: otherId, status: "no_credible_option", explanation: "No design can answer the separate comparative question." };
    const { ctx, calls } = context(call => {
      if (call.purpose === "ideation-critic") {
        return { reviews: keepAll(call).reviews.map(row => ({ ...row, verdict: "revise", note: "The proposed readout misses the evidence deadline." })) };
      }
      if (call.purpose === "ideation-judge") return judgeFirst(call, 1);
      const [gap] = gapsOf(call);
      if (!gap!.revise?.length) {
        if (gap!.id === otherId) return { tactics: [], gap_outcomes: [otherOutcome] };
        return { tactics: [tactic(gapId, "Late claims study"), tactic(gapId, "Late registry")] };
      }
      const withdrawal = { id: gap!.revise[0]!.id, gap_id: gapId, withdraw: true, withdraw_reason: "Readout cannot move before the deadline." };
      return gap!.revise.length === 2
        ? { tactics: [withdrawal], gap_outcomes: [deadline] }
        : { tactics: [withdrawal], gap_outcomes: [
          { ...deadline, explanation: "Conflicting explanation supplied during the tactic repair." },
          { ...deadline, gap_id: otherId, explanation: "Unrequested change to another gap." },
        ] };
    });

    const { output } = await ideationModule.run(input(2), ctx);

    const revisions = calls.filter(call => call.purpose === "ideation-proposer" && gapsOf(call)[0]!.revise?.length);
    expect(revisions.map(call => gapsOf(call)[0]!.revise!.map(row => row.id))).toEqual([
      [`${gapId}:proposal:1`, `${gapId}:proposal:2`],
      [`${gapId}:proposal:2`],
    ]);
    expect(calls.some(call => call.purpose === "ideation-judge")).toBe(false);
    expect(output.proposals).toEqual([]);
    expect(output.gap_outcomes).toEqual(expect.arrayContaining([deadline, otherOutcome]));
  });

  it("ignores an outcome for a different gap when accepting the final withdrawal", async () => {
    const [gapId, otherId] = ids as [string, string];
    const { ctx, calls } = context(call => {
      if (call.purpose === "ideation-critic") {
        return { reviews: keepAll(call).reviews.map(row => ({ ...row, verdict: "revise", note: "Validate the comparator data availability." })) };
      }
      if (call.purpose === "ideation-judge") return judgeFirst(call, 1);
      const [gap] = gapsOf(call);
      if (!gap!.revise?.length) return { tactics: [tactic(gap!.id, "Feasibility study")] };
      return {
        tactics: [{ id: gap!.revise[0]!.id, gap_id: gap!.id, withdraw: true, withdraw_reason: "No matching comparator records are available." }],
        gap_outcomes: gap!.id === gapId
          ? [{ gap_id: otherId, status: "no_timely_option", explanation: "Unrequested deadline judgement for a different gap." }]
          : [],
      };
    });

    const { output } = await ideationModule.run(input(), ctx);

    const revisions = calls.filter(call => call.purpose === "ideation-proposer" && gapsOf(call)[0]!.revise?.length);
    expect(revisions).toHaveLength(2);
    expect(revisions[0]!.body.exchange).toBe(revisions[1]!.body.exchange);
    expect(revisions.map(call => gapsOf(call).map(gap => gap.id))).toEqual(expect.arrayContaining([[gapId], [otherId]]));
    expect(output.proposals).toEqual([]);
    expect(output.gap_outcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({ gap_id: gapId, status: "no_credible_option" }),
      expect.objectContaining({ gap_id: otherId, status: "no_credible_option" }),
    ]));
  });

  it.each(["candidate decision", "gap outcome"])("includes completed decisions when repairing a missing %s", async (missing) => {
    const gapId = ids[0]!;
    const conditional = "The deadline can be met if claims access is confirmed by March.";
    let firstJudgeCall = true;
    const { ctx, calls } = context(call => {
      if (call.purpose === "ideation-proposer") {
        const existing = tactic(gapId, "Conditional claims analysis");
        const late = tactic(gapId, "Late registry");
        return { tactics: [
          { ...existing, recommendation: { ...existing.recommendation, deadline: { status: "conditional", explanation: conditional } } },
          { ...late, recommendation: { ...late.recommendation, deadline: { status: "late", explanation: "The registry readout is after the deadline." } } },
        ] };
      }
      if (call.purpose === "ideation-critic") return keepAll(call);

      if (firstJudgeCall) {
        firstJudgeCall = false;
        const [answer] = judgeFirst(call, 1).gaps;
        return { gaps: [{
          ...answer,
          decisions: missing === "candidate decision" ? answer!.decisions.slice(0, 1) : answer!.decisions,
          outcome: missing === "gap outcome" ? undefined : answer!.outcome,
        }] };
      }

      const [gap] = judgeGapsOf(call);
      const [answer] = judgeFirst(call, 0).gaps;
      const completed = gap?.completed_candidates?.find(candidate =>
        candidate.decision.verdict === "accept" && candidate.recommendation.deadline.status === "conditional");
      return { gaps: [{
        ...answer,
        outcome: completed
          ? { status: "options", explanation: completed.recommendation.deadline.explanation }
          : { status: "no_timely_option", explanation: "The visible options do not meet the deadline." },
      }] };
    });

    const { output } = await ideationModule.run({ ...input(2), gap_ids: [gapId] }, ctx);

    const judgeCalls = calls.filter(call => call.purpose === "ideation-judge");
    expect(judgeCalls).toHaveLength(2);
    const [firstGap] = judgeGapsOf(judgeCalls[0]!);
    const [repair] = judgeGapsOf(judgeCalls[1]!);
    expect(repair?.outcome_requested).toBe(true);
    expect(repair?.candidates.map(row => row.name)).toEqual(missing === "candidate decision" ? ["Late registry"] : []);
    expect(repair?.completed_candidates).toHaveLength(missing === "candidate decision" ? 1 : 2);
    expect(repair?.completed_candidates?.[0]).toMatchObject({
      id: firstGap?.candidates[0]?.id,
      name: "Conditional claims analysis",
      recommendation: { deadline: { status: "conditional", explanation: conditional } },
      decision: { verdict: "accept", rank: 1, reason: "judge on Conditional claims analysis" },
    });
    expect(output.proposals.map(row => row.name)).toEqual(["Conditional claims analysis"]);
    expect(output.rejected.map(row => row.name)).toEqual(["Late registry"]);
    expect(output.gap_outcomes).toEqual([{ gap_id: gapId, status: "options", explanation: conditional }]);
  });

  it.each([
    ["a missing id", (gapId: string) => tactic(gapId, "Missing id"), /missing id/i],
    ["a foreign id", (gapId: string) => tactic(gapId, "Foreign id", { id: "unrequested-slot" }), /unrequested.slot|not requested/i],
    ["a null row", () => null, /missing id|invalid.*row/i],
  ] as const)("repairs %s without resending the valid proposal", async (_case, invalidRow, problem) => {
    const gapId = ids[0]!;
    let proposals = 0;
    const { ctx, calls } = context(call => {
      if (call.purpose === "ideation-proposer") {
        const slots = gapsOf(call)[0]!.proposal_slots!;
        if (++proposals > 1) return { tactics: [tactic(gapId, "Repaired", { id: slots[0] })] };
        return { tactics: [tactic(gapId, "Preserved", { id: slots[0] }), invalidRow(gapId)] };
      }
      return call.purpose === "ideation-critic" ? keepAll(call) : judgeFirst(call, 2);
    }, true, false);
    const { output } = await ideationModule.run({ ...input(2), gap_ids: [gapId] }, ctx);
    const retry = calls.filter(call => call.purpose === "ideation-proposer")[1];
    expect(retry && gapsOf(retry)[0]).toMatchObject({
      proposal_slots: [`${gapId}:proposal:2`],
      problems: [expect.stringMatching(problem)],
    });
    expect(output.proposals.map(row => row.name)).toEqual(["Preserved", "Repaired"]);
  });

  it("repairs a malformed outcome separately from an accepted proposal slot", async () => {
    const gapId = ids[0]!;
    let proposals = 0;
    const { ctx, calls } = context(call => {
      if (call.purpose === "ideation-proposer") {
        const slots = gapsOf(call)[0]!.proposal_slots!;
        if (++proposals === 1) return { tactics: [tactic(gapId, "Preserved", { id: slots[0] })], gap_outcomes: [{ gap_id: gapId, status: "invented" }] };
        return { tactics: [], gap_outcomes: [{ gap_id: gapId, status: "options", explanation: "One design can address the remaining question." }] };
      }
      return call.purpose === "ideation-critic" ? keepAll(call) : judgeFirst(call, 1);
    }, true, false);
    const { output } = await ideationModule.run({ ...input(1), gap_ids: [gapId] }, ctx);
    const retry = calls.filter(call => call.purpose === "ideation-proposer")[1];
    expect(retry && gapsOf(retry)[0]).toMatchObject({
      proposal_slots: [], outcome_requested: true, problems: [expect.stringMatching(/outcome/i)],
    });
    expect(output.proposals.map(row => row.name)).toEqual(["Preserved"]);
  });

  it("repairs an invalid tactics envelope even when a valid gap outcome is present", async () => {
    const gapId = ids[0]!;
    const outcome = { gap_id: gapId, status: "no_credible_option", explanation: "No supplied design can answer the required comparison." };
    let proposals = 0;
    const { ctx, calls } = context(call => {
      if (call.purpose === "ideation-proposer") {
        if (++proposals === 1) return { tactics: null, gap_outcomes: [outcome] };
        return { tactics: [] };
      }
      return { gaps: [{ gap_id: gapId, outcome, decisions: [] }] };
    }, true, false);
    const { output } = await ideationModule.run({ ...input(1), gap_ids: [gapId] }, ctx);
    const retry = calls.filter(call => call.purpose === "ideation-proposer")[1];
    expect(retry && gapsOf(retry)[0]).toMatchObject({ problems: [expect.stringMatching(/tactics.*list/i)] });
    expect(output.proposals).toEqual([]);
    expect(output.gap_outcomes).toEqual([outcome]);
  });

  it("fails visibly when a malformed sibling cannot be repaired", async () => {
    const gapId = ids[0]!;
    const { ctx, calls } = context(call => {
      if (call.purpose !== "ideation-proposer") return call.purpose === "ideation-critic" ? keepAll(call) : judgeFirst(call, 1);
      const slots = gapsOf(call)[0]!.proposal_slots!;
      return { tactics: slots.includes(`${gapId}:proposal:1`) ? [tactic(gapId, "Preserved", { id: slots[0] }), null] : [null] };
    }, true, false);
    await expect(ideationModule.run({ ...input(1), gap_ids: [gapId] }, ctx)).rejects.toThrow(/missing id/i);
    const repairs = calls.filter(call => call.purpose === "ideation-proposer").slice(1);
    expect(repairs.length).toBeGreaterThan(0);
    for (const repair of repairs) expect(gapsOf(repair)[0]!.proposal_slots).toEqual([`${gapId}:proposal:2`]);
  });

  it("fails the run when the model critic never reviews a tactic", async () => {
    const [a, b] = ids as [string, string];
    const { ctx } = context((call) => {
      if (call.purpose === "ideation-proposer") return { tactics: [tactic(a, "A1"), tactic(b, "B1")] };
      if (call.purpose === "ideation-critic") return { reviews: [] };
      return judgeFirst(call, 1);
    });
    await expect(ideationModule.run(input(1), ctx)).rejects.toThrow(/did not return a complete review/);
  });

  it("rejects a critic duplicate that names no library tactic", async () => {
    const [a, b] = ids as [string, string];
    let criticCalls = 0;
    const { ctx, calls } = context((call) => {
      if (call.purpose === "ideation-proposer") return { tactics: [tactic(a, "A1"), tactic(b, "B1")] };
      if (call.purpose === "ideation-critic") {
        criticCalls += 1;
        if (criticCalls === 1) {
          return {
            reviews: tacticsOf(call).map((row) => ({ id: row.id, references: support(row.gap_id), verdict: "drop", confidence: 5, note: "dup", duplicate_of: "not-a-tactic" })),
          };
        }
        return keepAll(call);
      }
      return judgeFirst(call, 1);
    });
    const { output } = await ideationModule.run(input(1), ctx);
    // The invalid review was asked for again, not taken.
    expect(calls.filter((call) => call.purpose === "ideation-critic").length).toBe(4);
    expect(output.proposals).toHaveLength(2);
  });
  it("persists reuse recommendation evidence and no-option run outcomes without changing recorded coverage", async () => {
    // Arrange: use the recorded accepted design unchanged, with explicit unresolved checks.
    const { RunRecorder, openRun, closeRun } = await import("@/modules/kernel/observability");
    const { db } = await import("@/modules/kernel/db");
    const { ideationProposals, moduleRuns } = await import("@/modules/kernel/schema");
    const { eq } = await import("drizzle-orm");
    const state = await loadState();
    const target = state.tactics.find(row => row.id === libraryId)!;
    const recommendation = {
      remaining_need: "Recorded partial coverage still needs human review.",
      incremental_contribution: "Review the unchanged planned output against this gap without additional work.",
      alternatives_rationale: "Check existing relevant output before adding analysis or commissioning a separate study.",
      feasibility: { status: "conditional", required_checks: ["Confirm output availability and assess recorded coverage against the gap requirements."] },
      coverage_discrepancy: "Potential relevance requires review; existing S4 assessments remain authoritative.",
      deadline: { status: "unknown", explanation: "Output availability against the evidence deadline needs confirmation." },
    };
    const generationInput = { ...input(1), gap_ids: [ids[0]!], dry_run: false };
    const persistedRun = async (noOption: boolean) => {
      const recorder = new RunRecorder({ workspace_id: "default", stage: "S9", module_id: ideationModule.manifest.id, module_version: ideationModule.manifest.version, actor: ACTOR, input: generationInput });
      await openRun(recorder);
      const { ctx } = context(call => {
        if (call.purpose !== "ideation-proposer") return call.purpose === "ideation-critic" ? keepAll(call) : judgeFirst(call, 1);
        if (noOption) return { tactics: [], gap_outcomes: [{ gap_id: ids[0]!, status: "no_credible_option", explanation: "The available designs cannot answer the required comparison; confirm compatible comparator data first." }] };
        return { tactics: gapsOf(call).map(gap => tactic(gap.id, "Review unchanged recorded output", {
          id: `${gap.id}:proposal:1`, contract_version: 2, proposal_kind: "reuse", target_tactic_id: target.id,
          type: target.type, evidence_question: target.evidence_question, population: target.population,
          comparator: target.comparator, outcomes: target.outcomes, data_source: target.data_source, study_design: target.study_design,
          recommendation,
        })) };
      });
      ctx.run = recorder;
      ctx.replay = { evaluation: false, input: generationInput, facts: await ideationModule.freeze!(generationInput), module_id: ideationModule.manifest.id, module_version: ideationModule.manifest.version, prompt_version: "base" };
      const result = await ideationModule.run(generationInput, ctx);
      await closeRun({ recorder, status: "ok", output: result.output, route: ctx.route });
      return { recorder, result };
    };

    // Act: exercise generation and the actual run recorder for both result shapes.
    const reuse = await persistedRun(false);
    const noOption = await persistedRun(true);

    // Assert: proposal and immutable baseline retain evidence; no-row outcomes live in run output.
    const proposals = await db().select().from(ideationProposals);
    const row = proposals.find(row => (row.design as {run_id?: string}).run_id === reuse.recorder.id)!;
    expect(row.proposal_kind).toBe("reuse");
    expect(row.target_tactic_id).toBe(target.id);
    const basis = reuse.result.output.proposals[0]!.supporting_context_basis;
    expect(basis).toMatch(/^[a-f0-9]{64}$/);
    expect(row.design).toMatchObject({ recommendation, supporting_context_basis: basis, original_ai: { proposal_kind: "reuse", target_tactic_id: target.id, recommendation, supporting_context_basis: basis } });
    const run = (await db().select().from(moduleRuns).where(eq(moduleRuns.id, noOption.recorder.id)))[0]!;
    expect(run.output).toMatchObject({ proposals: [], gap_outcomes: [{ gap_id: ids[0], status: "no_credible_option", explanation: expect.stringContaining("compatible comparator data") }] });
    const after = await loadState();
    expect(after.coverages).toEqual(state.coverages);
    expect(after.tactics).toEqual(state.tactics);
  });

  it.each(["unchanged", "saved-edit", "inline-edit", "comparison-edit", "missing-comparison", "legacy-missing-comparison"])("retains creation-time AI baseline through the real S9 API flow: %s", async (flow) => {
    const { RunRecorder, openRun, closeRun } = await import("@/modules/kernel/observability");
    const { db, sharedDb } = await import("@/modules/kernel/db");
    const { ideationProposals } = await import("@/modules/kernel/schema");
    const { POST } = await import("@/app/api/plan/route");
    const { sql } = await import("drizzle-orm");
    const recorder = new RunRecorder({ workspace_id: "default", stage: "S9", module_id: ideationModule.manifest.id, module_version: ideationModule.manifest.version, actor: ACTOR, input: { gap_ids: ids } });
    await openRun(recorder);
    const { ctx } = context((call) => call.purpose === "ideation-proposer" ? { tactics: ids.map(id => tactic(id, `Original ${id}`, { id: `${id}:proposal:1` })) } : call.purpose === "ideation-critic" ? keepAll(call) : judgeFirst(call, 1));
    ctx.run = recorder;
    const generationInput = { ...input(), dry_run: false };
    ctx.replay = { evaluation: false, input: generationInput, facts: await ideationModule.freeze!(generationInput), module_id: ideationModule.manifest.id, module_version: ideationModule.manifest.version, prompt_version: "base" };
    const result = await ideationModule.run({ ...input(), dry_run: false }, ctx);
    await closeRun({ recorder, status: "ok", output: result.output, route: ctx.route });
    const rows = await db().select().from(ideationProposals);
    const row = rows.find(row => (row.design as { run_id?: string }).run_id === recorder.id)!;
    const originalAi = (row.design as { original_ai: { design: unknown; recommendation?: unknown; supporting_context_basis?: unknown } }).original_ai;
    // The immutable creation baseline includes the reasoning that informed the
    // original recommendation, not only the tactic design fields.
    const original = { proposal_kind: row.proposal_kind, comparative_rationale: row.comparative_rationale, name: row.name, type: row.type, evidence_question: row.evidence_question, rationale: row.rationale, design: originalAi.design, recommendation: originalAi.recommendation, supporting_context_basis: originalAi.supporting_context_basis };
    const slot = (row.design as { slot_id: string }).slot_id;
    expect(slot).toBe(`${row.gap_id}:proposal:1`);
    if (flow.includes("missing-comparison")) {
      const stored = structuredClone(row.design) as Record<string, unknown> & { original_ai: Record<string, unknown> };
      delete stored.original_ai.comparative_rationale;
      if (flow === "legacy-missing-comparison") delete stored.original_ai.proposal_kind;
      // Simulate incomplete historical evidence; the current source row still has a comparison.
      await db().update(ideationProposals).set({ design: stored }).where(sql`${ideationProposals.id} = ${row.id}`);
    }
    process.env.SYNAPSE_TEST_STUB_LLM = "1";
    const post = async (body: Record<string, unknown>) => {
      const current = (await (await import("@/modules/stages/s9-ideation/module")).listIdeationProposals()).find(p => p.id === row.id)!;
      return POST(new Request("http://localhost/api/plan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ actor_name: ACTOR.name, actor_function: ACTOR.function, id: row.id, expected_version: current.version, rationale: "Review rationale", ...body }) }));
    };
    if (flow === "saved-edit") expect((await post({ action: "edit_proposal", name: "Human idea", population: "Human population" })).status).toBe(200);
    const humanComparison = "Human comparison: existing analyses cannot measure this outcome; the new registry costs more but has feasible recruitment.";
    if (flow === "comparison-edit") expect((await post({ action: "edit_proposal", comparative_rationale: humanComparison })).status).toBe(200);
    const omitted = flow.includes("missing-comparison") ? vi.spyOn(console,"warn").mockImplementation(() => {}) : null;
    expect((await post({ action: "decide_proposal", decision: "accept", ...(flow === "inline-edit" ? { name: "Human idea", population: "Human population" } : {}) })).status).toBe(200);
    const examples = await sharedDb().execute(sql`select ai_output, ai_input, final, outcome, run_id, actor from decision_examples where run_id = ${recorder.id}`);
    if (flow.includes("missing-comparison")) {
      expect(examples).toHaveLength(0);
      expect(omitted).toHaveBeenCalledExactlyOnceWith("[learning] S9 decision omitted: immutable original AI baseline unavailable",row.id);
      omitted!.mockRestore();
      return;
    }
    expect(examples).toHaveLength(1); expect(examples[0].ai_output).toEqual(original);
    expect(examples[0].ai_input).toMatchObject({ slot_id: slot });
    expect(examples[0].outcome).toBe(flow === "unchanged" ? "accepted" : "edited");
    expect(examples[0].run_id).toBe(recorder.id); expect(examples[0].actor).toEqual(ACTOR);
    if (flow === "comparison-edit") {
      expect(examples[0].final).toEqual({ ...original, comparative_rationale: humanComparison, recommendation: { ...(original.recommendation as Record<string, unknown>), alternatives_rationale: humanComparison } });
      const saved = (await db().select().from(ideationProposals)).find(p => p.id === row.id)!;
      expect((saved.design as { original_ai: unknown }).original_ai).toEqual(original);
      expect(saved.design).toMatchObject({ slot_id: slot, run_id: recorder.id });
      expect((await post({ action: "decide_proposal", decision: "accept" })).status).toBe(400);
      expect(await sharedDb().execute(sql`select id from decision_examples where run_id = ${recorder.id}`)).toHaveLength(1);
    } else if (flow !== "unchanged") expect(examples[0].final).toMatchObject({ name: "Human idea", design: { population: "Human population" } });
    else expect(examples[0].final).toBeNull();
  });

});
