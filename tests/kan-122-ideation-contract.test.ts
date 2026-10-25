import { afterEach, describe, expect, it } from "vitest";
import { buildSeed } from "@/lib/iegp/seed";
import { emptyDimensions, unlocked } from "@/lib/iegp/engine";
import type { ModuleContext } from "@/modules/kernel/contracts";
import type { IdeationGapBrief } from "@/modules/stages/s9-ideation/context";
import { ideationModule } from "@/modules/stages/s9-ideation/module";

type PromptBody = {
  gaps: {id: string; brief: IdeationGapBrief; revise?: {id: string}[]; candidates: {id: string}[]}[];
  tactics: {id: string}[];
};

const savedStub = process.env.SYNAPSE_TEST_STUB_LLM;
afterEach(() => { if (savedStub === undefined) delete process.env.SYNAPSE_TEST_STUB_LLM; else process.env.SYNAPSE_TEST_STUB_LLM = savedStub; });

function setup(kind: "reuse" | "expansion" | "new" = "reuse") {
  delete process.env.SYNAPSE_TEST_STUB_LLM;
  const state = buildSeed();
  const gap = state.gaps[0]!;
  state.gaps = [{...gap, status: "validated_open", computed_status: "validated_open", human_validated: true, status_override: null, parked_at: null, retired: false}];
  const target = state.tactics[0]!;
  target.status = "planned";
  target.review_status = "accepted";
  state.coverages = [{id: "recorded", gap_id:gap.id, tactic_id:target.id, dimensions:emptyDimensions(), overall:"partial", overall_rationale:"Recorded partial coverage", overall_lock:unlocked(), stale:false, needs_review:false}];
  state.needs = [];
  state.need_gap_links = [];
  const recommendation = {
    remaining_need: "A methodologically valid comparison remains unconfirmed.",
    incremental_contribution: kind === "reuse" ? "Review the already planned output without additional work." : "Additional comparative analysis subject to compatible data.",
    alternatives_rationale: "Separate studies cannot establish a comparison without compatibility checks; an added analysis takes time and effort.",
    feasibility: {status:"conditional", required_checks:["Confirm comparator availability and design compatibility"]},
    coverage_discrepancy: "Planned output may be relevant; review the recorded partial assessment, preserving it.",
    deadline: {status:"conditional", explanation:"Confirm existing output availability against the evidence deadline."},
  };
  const scope = {name:"Added comparison",evidence_question:"Can compatible data support comparison?",population:"Adults",outcomes:"OS",geography:"",data_cut:"",analysis:"Post-hoc comparative analysis",instrument:"",study_design:"Post-hoc compatible cohort analysis",gap_coverage:"Added comparator analysis",cost_effort:"Analyst effort",timing:"After access approval",feasibility_risks:"Confirm comparator data compatibility",post_hoc:true,prospective_enrolment:false,protocol_amendment:false,start_date:null,evidence_available:null};
  const candidate = {id:"slot", gap_id:gap.id,references:[{entity_type:"gap",entity_id:gap.id,reason:"The supplied gap defines this remaining evidence question"}],contract_version:2,proposal_kind:kind,target_tactic_id:kind === "new" ? null : target.id,expansion_scope:kind === "expansion" ? scope : null,comparative_rationale:recommendation.alternatives_rationale,name:kind === "expansion" ? scope.name : "Use recorded output",type:"rwe_study",evidence_question:kind === "expansion" ? scope.evidence_question : "Use the unchanged planned evidence",rationale:"Request coverage review without claiming evidence is delivered.",population:"Adults",comparator:"Unconfirmed",outcomes:"OS",data_source:"Existing planned dataset",study_design:kind === "expansion" ? scope.study_design : "Existing recorded design",duration_months:6,readout_lag_months:1,timing_rationale:"Original planned timing remains authoritative",recommendation};
  if (kind === "reuse") Object.assign(candidate, {type:target.type,evidence_question:target.evidence_question,population:target.population,comparator:target.comparator,outcomes:target.outcomes,data_source:target.data_source,study_design:target.study_design});
  const calls: {purpose:string; body:PromptBody; system:string}[] = [];
  const ctx: ModuleContext = {ai:true,workspace_id:"default",actor:{name:"Test",function:"medical_affairs"},role:"medical_affairs",route:{stage:"S9",provider_id:"test",provider_label:"Test",model:"test",auth:"api_key",connected:true,params:{temperature:0,max_tokens:4096},fallbacks:[],degraded:false,reason:null},run:{id:"controlled",step:async(_name,fn)=>fn(),note:()=>{},steps:()=>[]},replay:{evaluation:true,input:{},facts:{state,placements:[{gap_id:gap.id,band:"high",validated:true,rationale:"Blocks decision"}]},module_id:"s9-ideation.pcj",module_version:"2.3.0",prompt_version:"test"},complete:async({purpose,user,system})=>{
    const body=JSON.parse(user) as PromptBody; calls.push({purpose,body,system});
    if(purpose==="ideation-proposer") return {tactics:[{...candidate,id:body.gaps[0]?.revise?.[0]?.id ?? candidate.id}]};
    if(purpose==="ideation-critic") return {reviews:body.tactics.map((p)=>({id:p.id,references:candidate.references,verdict:"keep",confidence:70,note:"Conditional on the specified compatibility and coverage checks",issues:[],duplicate_of:null}))};
    return {gaps:body.gaps.map((g)=>({gap_id:g.id,decisions:g.candidates.map((p)=>({id:p.id,references:candidate.references,verdict:"accept",confidence:70,rank:1,reason:"Review relevance without changing recorded coverage"}))}))};
  }};
  return {state,gap,target,candidate,recommendation,calls,ctx};
}

describe("KAN-122 controlled recommendation contract",()=>{
  it("carries reuse, remaining need, feasibility, coverage disagreement and per-gap context through every reviewer",async()=>{
    const {ctx,calls,recommendation,target} = setup();
    const {output} = await ideationModule.run(ideationModule.inputSchema.parse({per_gap:1,dry_run:true}),ctx);
    expect(output.proposals[0]).toMatchObject({proposal_kind:"reuse",target_tactic_id:target.id,recommendation,supporting_context_basis:expect.any(String)});
    expect(output.proposals[0]!.score).toBe(70);
    const proposer = calls.find(call=>call.purpose==="ideation-proposer")!;
    expect(proposer.body.gaps[0].brief.requirements.unknown_dimensions).toContain("comparator");
    expect(calls.find(call=>call.purpose==="ideation-critic")!.body.tactics[0]).toMatchObject({recommendation,gap:{brief:{priority:{rationale:"Blocks decision"}}}});
    expect(calls.find(call=>call.purpose==="ideation-judge")!.body.gaps[0].brief.mapped_tactics[0].coverage.overall).toBe("partial");
  });

  it("allows fewer useful candidates than frozen slots instead of filling a route quota", async () => {
    const {ctx,gap,candidate}=setup();
    ctx.replay!.facts = {...ctx.replay!.facts, proposal_slots: {[gap.id]: [candidate.id, "unused-slot"]}};
    const {output}=await ideationModule.run(ideationModule.inputSchema.parse({per_gap:2,dry_run:true}),ctx);
    expect(output.proposals).toHaveLength(1);
    expect(output.proposals[0]!.id).toBe(candidate.id);
  });

  it.each(["new", "expansion"] as const)("requires current %s reasoning even when the model omits its version", async kind => {
    const {ctx,candidate}=setup(kind);
    Reflect.deleteProperty(candidate, "contract_version");
    Reflect.deleteProperty(candidate, "recommendation");
    await expect(ideationModule.run(ideationModule.inputSchema.parse({dry_run:true}),ctx)).rejects.toThrow("complete set of tactic designs");
  });

  it("repairs missing current reasoning without treating an unversioned reply as historical", async () => {
    const {ctx,candidate,calls,recommendation}=setup("new");
    const complete=ctx.complete;
    let first=true;
    ctx.complete=async request=>{
      const reply=await complete(request);
      if(request.purpose === "ideation-proposer" && first) {
        first=false;
        const incomplete={...candidate};
        Reflect.deleteProperty(incomplete,"contract_version");
        Reflect.deleteProperty(incomplete,"recommendation");
        return {tactics:[incomplete]};
      }
      return reply;
    };
    const {output}=await ideationModule.run(ideationModule.inputSchema.parse({dry_run:true}),ctx);
    expect(calls.filter(call=>call.purpose === "ideation-proposer")).toHaveLength(2);
    expect(output.proposals[0]!.recommendation).toEqual(recommendation);
    // Historical saved output still parses: strictness belongs to current generation.
    const historical=structuredClone(output);
    Reflect.deleteProperty(historical.proposals[0]!,"recommendation");
    Reflect.deleteProperty(historical.proposals[0]!,"supporting_context_basis");
    expect(ideationModule.outputSchema.parse(historical).proposals).toHaveLength(1);
  });

  it("normalizes options to an unresolved outcome when the judge rejects every candidate", async () => {
    const {ctx}=setup("new");
    const complete=ctx.complete;
    ctx.complete=async request=>{
      const reply=await complete(request);
      if(request.purpose !== "ideation-judge") return reply;
      const judged=reply as {gaps:{gap_id:string; decisions:Record<string,unknown>[]}[]};
      return {gaps:judged.gaps.map(gap=>({...gap,outcome:{status:"options",explanation:"These options resolve the need."},decisions:gap.decisions.map(decision=>({...decision,verdict:"reject",rank:null}))}))};
    };
    const {output}=await ideationModule.run(ideationModule.inputSchema.parse({dry_run:true}),ctx);
    expect(output.proposals).toEqual([]);
    expect(output.gap_outcomes[0]).toMatchObject({status:"no_credible_option",explanation:expect.stringContaining("unresolved")});
  });

  it("does not retain a no-credible claim alongside a surviving credible option", async () => {
    const {ctx,candidate}=setup("new");
    candidate.recommendation.feasibility.status="credible";
    Reflect.set(candidate.recommendation,"coverage_discrepancy",null);
    candidate.recommendation.deadline.status="timely";
    const complete=ctx.complete;
    ctx.complete=async request=>{
      const reply=await complete(request);
      if(request.purpose !== "ideation-judge") return reply;
      const judged=reply as {gaps:{gap_id:string}[]};
      return {gaps:judged.gaps.map(gap=>({...gap,outcome:{status:"no_credible_option",explanation:"No credible option is available."}}))};
    };
    const {output}=await ideationModule.run(ideationModule.inputSchema.parse({dry_run:true}),ctx);
    expect(output.proposals).toHaveLength(1);
    expect(output.gap_outcomes[0]!.status).toBe("options");
  });

  it("discards an outcome from an incomplete judge answer before retrying", async () => {
    const {ctx}=setup("new");
    const complete=ctx.complete;
    let first=true;
    ctx.complete=async request=>{
      const reply=await complete(request);
      if(request.purpose !== "ideation-judge" || !first) return reply;
      first=false;
      const judged=reply as {gaps:{gap_id:string}[]};
      return {gaps:judged.gaps.map(gap=>({...gap,decisions:[],outcome:{status:"no_timely_option",explanation:"Discard this invalid response."}}))};
    };
    const {output}=await ideationModule.run(ideationModule.inputSchema.parse({dry_run:true}),ctx);
    expect(output.gap_outcomes[0]!.status).toBe("options");
  });

  it("retains conditional comparator expansion rather than inferring compatibility between separate studies",async()=>{
    const {ctx,recommendation} = setup("expansion");
    const {output}=await ideationModule.run(ideationModule.inputSchema.parse({dry_run:true}),ctx);
    expect(output.proposals[0]).toMatchObject({proposal_kind:"expansion",recommendation:{feasibility:{status:"conditional",required_checks:recommendation.feasibility.required_checks},alternatives_rationale:recommendation.alternatives_rationale}});
  });

  it("accepts an explicit no-timely-option outcome without demanding candidates or relaxing the deadline",async()=>{
    const {ctx,gap}=setup();
    ctx.complete=async()=>({tactics:[],gap_outcomes:[{gap_id:gap.id,status:"no_timely_option",explanation:"All credible designs miss January; later data may help but the deadline remains unresolved."}]});
    const {output}=await ideationModule.run(ideationModule.inputSchema.parse({dry_run:true}),ctx);
    expect(output.proposals).toEqual([]);
    expect(output.gap_outcomes).toEqual([{gap_id:gap.id,status:"no_timely_option",explanation:expect.stringContaining("deadline remains unresolved")}]);
  });

  it("reasks rather than accepting a reuse target with a cancelled lifecycle",async()=>{
    const {ctx,target}=setup(); target.status="cancelled";
    await expect(ideationModule.run(ideationModule.inputSchema.parse({dry_run:true}),ctx)).rejects.toThrow("complete set of tactic designs");
  });
  it("requires renewed reasoning on the v2 contract and visible checks for unknown feasibility",async()=>{
    const {ctx,candidate} = setup("new");
    candidate.recommendation.feasibility.required_checks=[];
    await expect(ideationModule.run(ideationModule.inputSchema.parse({dry_run:true}),ctx)).rejects.toThrow("complete set of tactic designs");
  });

  it("rejects a redesign disguised as unchanged reuse",async()=>{
    const {ctx,candidate} = setup();
    candidate.study_design="New comparative analysis";
    await expect(ideationModule.run(ideationModule.inputSchema.parse({dry_run:true}),ctx)).rejects.toThrow("complete set of tactic designs");
  });

  it("carries the full brief and reasoning into an actual revision",async()=>{
    const {ctx,calls,recommendation} = setup("expansion");
    const complete = ctx.complete;
    let initialReview = true;
    ctx.complete=async request=>{
      const reply=await complete(request);
      if(request.purpose==="ideation-critic" && initialReview) {
        initialReview=false;
        return {reviews:(reply as {reviews:Record<string,unknown>[]}).reviews.map(review=>({...review,verdict:"revise",note:"Retain the comparator-data check explicitly"}))};
      }
      return reply;
    };
    const {output}=await ideationModule.run(ideationModule.inputSchema.parse({dry_run:true}),ctx);
    const revision=calls.filter(call=>call.purpose==="ideation-proposer")[1]!;
    expect(revision.body.gaps[0]).toMatchObject({brief:{requirements:{unknown_dimensions:expect.arrayContaining(["comparator"])}},revise:[{previous:{recommendation},objection:"Retain the comparator-data check explicitly"}]});
    expect(output.proposals[0]!.recommendation).toEqual(recommendation);
  });

  it("preserves an explicit no-credible-option result for incompatible available studies",async()=>{
    const {ctx,gap}=setup();
    ctx.complete=async()=>({tactics:[],gap_outcomes:[{gap_id:gap.id,status:"no_credible_option",explanation:"Separate incompatible studies cannot answer the comparison; confirm comparator access and common outcome definitions first."}]});
    const {output}=await ideationModule.run(ideationModule.inputSchema.parse({dry_run:true}),ctx);
    expect(output.gap_outcomes).toEqual([{gap_id:gap.id,status:"no_credible_option",explanation:expect.stringContaining("incompatible studies")}]);
    expect(output.proposals).toEqual([]);
  });

  it("does not present a coverage discrepancy as established feasible work",async()=>{
    const {ctx,candidate}=setup("new");
    candidate.recommendation.feasibility.status="credible";
    await expect(ideationModule.run(ideationModule.inputSchema.parse({dry_run:true}),ctx)).rejects.toThrow("complete set of tactic designs");
  });

  it("keeps accepted longer-term work separate from a timely solution",async()=>{
    const {ctx,candidate}=setup("new");
    candidate.recommendation.deadline.status="late";
    candidate.recommendation.deadline.explanation="Useful later but misses the evidence deadline.";
    const {output}=await ideationModule.run(ideationModule.inputSchema.parse({dry_run:true}),ctx);
    expect(output.proposals).toHaveLength(1);
    expect(output.gap_outcomes[0]).toMatchObject({status:"no_timely_option",explanation:expect.stringContaining("deadline")});
  });

});
