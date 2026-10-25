/** @vitest-environment jsdom */
/** Evidence context remains available without AI; decisions preserve review boundaries. */
import { expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { IdeationBoard } from "@/components/tactic-ideation/ideation-board";
import { buildPlanWorkspace } from "@/lib/iegp/engine";
import { renderToStaticMarkup } from "react-dom/server";
import { buildSeed } from "@/lib/iegp/seed";
import { buildIdeationGapBrief } from "@/modules/stages/s9-ideation/context";
import { IdeationBrief, IdeationOutcome, AcceptedIdeationContext } from "@/components/ideation/evidence-context";
import { ProposalCard, type ProposalCardModel } from "@/components/ideation/proposal-card";
import { proposalFields } from "@/components/ideation/proposal-fields";
import FinalPlanPage from "@/app/plan/final/page";
import type { FinalPackage } from "@/modules/stages/s10-timeline/final-package";
const dialogs = vi.hoisted(() => [] as Record<string, unknown>[]);
const finalPlanView = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/components/platform/action-dialog", () => ({ ActionDialog: (props: Record<string, unknown>) => { dialogs.push(props); return createElement("button", null, String(props.label)); } }));
vi.mock("@/components/tactic-ideation/tactic-panel", () => ({ TacticEditPanel: () => null, TacticRecordLink: ({ children }: { children: string }) => createElement("a", null, children) }));
vi.mock("next/navigation", () => ({useRouter:()=>({refresh:vi.fn()}),usePathname:()=>"/tactics",useSearchParams:()=>new URLSearchParams()}));
vi.mock("next/link", () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => createElement("a", { href }, children) }));
vi.mock("@/components/app-shell", () => ({ AppShell: ({ children }: { children: React.ReactNode }) => createElement("main", null, children), PageIntro: ({ children }: { children: React.ReactNode }) => createElement("div", null, children) }));
vi.mock("@/modules/stages/s10-timeline/module", () => ({ planHistory: async () => [], planVersion: async () => ({ id: "plan" }) }));
vi.mock("@/modules/stages/s10-timeline/final-view", () => ({ finalPlanView: () => finalPlanView.current }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const identity = { signed_in: true, actor_name: "Reviewer", actor_function: "medical_affairs" as const };
function brief() { const state = buildSeed(); return buildIdeationGapBrief(state, state.gaps[0]!.id, [{gap_id:state.gaps[0]!.id,band:"high",validated:true,rationale:"Blocks the treatment decision"}]); }
function proposal(): ProposalCardModel { return { id:"idea",version:"v1",gap_id:"gap",name:"Review existing output",proposal_kind:"reuse",target_tactic_id:"TAC-1",expansion_scope:null,reviewed_parent:null,comparative_rationale:"Use recorded output before commissioning more work",type:"rwe_study",evidence_question:"Does the output answer the gap?",rationale:"Original reasoning remains",design:{population:"Adults",comparator:"Unknown",outcomes:"OS",data_source:"Existing",study_design:"Cohort",duration_months:null,readout_lag_months:null,timing_rationale:""},status:"proposed",judge_score:72,rank:1,critic_note:"",created_at:"2026-10-25",decided_by:null,decision_rationale:null,tactic_id:null,expansion_id:null,origin:"ai",edited_by:null,edited_at:null,recommendation:{remaining_need:"Comparative evidence remains unknown",incremental_contribution:"Review the unchanged output",alternatives_rationale:"New analysis requires compatibility checks",feasibility:{status:"conditional",required_checks:["Confirm comparator availability"]},coverage_discrepancy:"Recorded Partial remains authoritative",deadline:{status:"late",explanation:"Useful later, misses decision deadline"}},current_context:brief(),current_context_basis:"b".repeat(64),supporting_context_basis:"a".repeat(64),context_stale:true }; }
it("shows sourced unknowns, priority and lifecycle without implying evidence delivery", () => {
  const html = renderToStaticMarkup(createElement(IdeationBrief, { brief: brief() }));
  expect(html).toContain("Blocks the treatment decision"); expect(html).toContain("Comparator"); expect(html).toContain("Unknown"); expect(html).toContain("Planned output is not delivered evidence"); expect(html).toContain("Coverage");
});
it("explains an unresolved missed deadline even without a proposal", () => {
  const html=renderToStaticMarkup(createElement(IdeationOutcome,{outcome:{gap_id:"gap",status:"no_timely_option",explanation:"All credible options miss the evidence deadline"}}));
  expect(html).toContain("No timely option"); expect(html).toContain("All credible options miss"); expect(html).toContain("Recorded coverage is unchanged");
});
it("puts need and checks before a secondary non-probabilistic Judge rating", () => {
  const html=renderToStaticMarkup(createElement(ProposalCard,{proposal:proposal(),identity,mayIdeate:true}));
  expect(html.indexOf("Comparative evidence remains unknown")).toBeLessThan(html.indexOf("Judge rating"));
  expect(html).toContain("not a probability"); expect(html).toContain("Confirm comparator availability"); expect(html).toContain("misses decision deadline"); expect(html).toContain("Reuse existing tactic");
});
it("shows manual contribution, alternatives and checks before design details without a Judge rating", () => {
  const manual = {...proposal(), origin: "human" as const, recommendation: undefined,
    rationale: "Review the existing output before adding work",
    comparative_rationale: "A new study would duplicate the available output",
    conditions: ["Confirm the output is available"]};
  const html = renderToStaticMarkup(createElement(ProposalCard, {proposal: manual, identity, mayIdeate: true}));
  const firstDetail = html.indexOf("Evidence question");
  for (const explanation of [manual.rationale, manual.comparative_rationale, manual.conditions[0]]) {
    expect(html).toContain(explanation);
    expect(html.indexOf(explanation)).toBeLessThan(firstDetail);
  }
  expect(html).not.toContain("Judge rating");
});
it("requires deliberate current-context manual review for stale acceptance and preserves original reasoning", () => {
  dialogs.length=0; const html=renderToStaticMarkup(createElement(ProposalCard,{proposal:proposal(),identity,mayIdeate:true}));
  const acceptance=dialogs.find(row=>row.label==="Review current context and accept")!;
  expect(acceptance).toBeDefined(); expect(acceptance.payload).toMatchObject({reviewed_context_basis:"b".repeat(64),judgement_origin:"manual"});
  expect(acceptance.description).toContain("no new work"); expect(html).toContain("Original reasoning remains"); expect(html).toContain("Supporting context changed");
});
it("keeps unavailable historical current context read-only for acceptance", () => {
  dialogs.length=0; renderToStaticMarkup(createElement(ProposalCard,{proposal:{...proposal(),current_context:undefined,current_context_basis:undefined},identity,mayIdeate:true}));
  expect(dialogs.some(row=>String(row.label).includes("accept") || row.label==="Accept")).toBe(false);
});
it("keeps manual comparison and uncertainty optional", () => {
  const fields=proposalFields(); expect(fields.find(row=>row.name==="comparative_rationale")?.required).not.toBe(true); expect(fields.find(row=>row.name==="conditions")?.required).not.toBe(true);
  expect(fields.some(row=>row.name==="conditions")).toBe(true);
});
it("shows accepted source checks for the exact expansion and labels reuse as no additional work", () => {
 const html=renderToStaticMarkup(createElement(AcceptedIdeationContext,{contexts:[{proposal_id:"idea",gap_id:"gap",tactic_id:"TAC-1",expansion_id:"EXP-2",proposal_kind:"reuse",conditions:["Check access"],recommendation:undefined,supporting_context_basis:undefined,renewed_review:undefined,comparative_rationale:""}],tacticId:"TAC-1",expansionId:"EXP-2"}));
 expect(html).toContain("Check access"); expect(html).toContain("no additional work");
 const other=renderToStaticMarkup(createElement(AcceptedIdeationContext,{contexts:[{proposal_id:"idea",gap_id:"gap",tactic_id:"TAC-1",expansion_id:"EXP-2",proposal_kind:"expansion",conditions:["Check access"],recommendation:undefined,supporting_context_basis:undefined,renewed_review:undefined,comparative_rationale:""}],tacticId:"TAC-1"})); expect(other).not.toContain("Check access");
});

it("renders accepted expansion checks under their expansion without attributing them to the parent tactic", async () => {
 const pkg = {
  plan_context:{asset:{name:"Asset",inn:"A",indication:"Condition",geography:"US"},planning_context:null,objectives:[]},
  evidence_gap_inventory:[],
  evidence_tactics:[{id:"TAC-1",name:"Parent tactic",evidence_state:"planned_work",origin:"added_by_hand",owner:"Reviewer",objective:"",outputs:"",timing:{start_date:null,evidence_available:null},gap_ids:[],expansions:[{id:"EXP-1",name:"Child analysis",status:"planned",gap_ids:[]}] }],
  accepted_ideation_context:[
   {proposal_id:"parent-idea",gap_id:"gap-parent",tactic_id:"TAC-1",expansion_id:null,proposal_kind:"reuse",conditions:["Parent-only check"],recommendation:undefined,supporting_context_basis:undefined,renewed_review:undefined,comparative_rationale:""},
   {proposal_id:"child-idea",gap_id:"gap-child",tactic_id:"TAC-1",expansion_id:"EXP-1",proposal_kind:"expansion",conditions:["Child-only check"],recommendation:undefined,supporting_context_basis:undefined,renewed_review:undefined,comparative_rationale:""},
  ],
  prioritisation:{axes:[],x_axis:"",y_axis:"",placements:[]},roadmap:{activities:[],window:{start:"",end:""},lanes:[],fingerprint_code:""},open_items:{unaddressed:[],deferred:[],parked:[],excluded:[],unscheduled:[],limitations:[]},schema_version:"final-package/v1",built_at:"2026-10-25",workspace_id:null,workshop_outcomes:{status:"none",note:"Workshop outcomes: none (workshop not in use)"},
 } as unknown as FinalPackage;
 const view = {kind:"complete",version:1,status:"final",saved_by:"Reviewer",saved_at:"2026-10-25",note:null,schema_version:pkg.schema_version,package_fingerprint:"test",intact:true,package:pkg} as const;
 finalPlanView.current = view;
 const html = renderToStaticMarkup(await FinalPlanPage({searchParams:Promise.resolve({version:"1"})}));
 expect(html).toContain("Parent-only check"); expect(html).toContain("Child analysis"); expect(html).toContain("Child-only check");
 expect(html.indexOf("Child analysis")).toBeLessThan(html.indexOf("Child-only check"));
 expect(html.indexOf("Parent-only check")).toBeLessThan(html.indexOf("Child analysis"));
 const legacy = {...pkg} as {accepted_ideation_context?: unknown}; delete legacy.accepted_ideation_context;
 finalPlanView.current = {...view,package:legacy as FinalPackage};
 await expect(FinalPlanPage({searchParams:Promise.resolve({version:"1"})})).resolves.toBeDefined();
});

it("exposes evidence brief and manual routes on the AI-off board with no proposals", () => {
 const state=buildSeed(); const gap=state.gaps[0]!; gap.status="validated_open"; gap.computed_status="validated_open"; gap.status_override=null; gap.human_validated=true;
 const cards=buildPlanWorkspace(state).openGaps; const card=cards.find(row=>row.gap_id===gap.id)!;
 const host=document.createElement("div"); const root=createRoot(host); document.body.append(host);
 try {
   act(()=>root.render(createElement(IdeationBoard,{gaps:[card],proposals:[],library:[],identity,mayIdeate:true,briefs:{[gap.id]:buildIdeationGapBrief(state,gap.id,[])},outcomes:[{gap_id:gap.id,status:"no_timely_option",explanation:"No feasible evidence before deadline"}]})));
   act(()=>host.querySelector<HTMLButtonElement>('[data-testid="ideation-gap-toggle"]')!.click());
   expect(host.querySelector('[aria-label="Evidence brief"]')).not.toBeNull(); expect(host.textContent).toContain("No timely option"); expect(host.textContent).toContain("Add idea by hand"); expect(host.textContent).not.toContain("Suggest tactics");
 } finally {act(()=>root.unmount());host.remove();}
});


it.each([
  { comparator: "Child comparator", data_source: "Child data", date: "2028-09-01" },
  { comparator: "", data_source: "", date: null },
  { comparator: undefined, data_source: undefined, date: null },
])("shows exact expansion design and timing, including unknown child values: %j", ({comparator, data_source, date}) => {
  const context = brief();
  const mapped = context.mapped_tactics.find(row => row.tactic)!;
  mapped.tactic = {...mapped.tactic!, comparator: "Parent comparator", data_source: "Parent data", evidence_available: "2026-01-01", study_design: "Parent design", evidence_question: "Parent question", population: "Parent population", outcomes: "Parent outcomes"};
  mapped.expansion = {
    id: "child", tactic_id: mapped.tactic.id, gap_ids: [context.gap_id], proposal_id: "idea", version: "1", status: "planned", history: [], actor: {name: "Reviewer", function: "medical_affairs"}, created_at: "2026-10-25", updated_at: "2026-10-25",
    scope: {name: "Child work", evidence_question: "", population: "", outcomes: "", geography: "", data_cut: "", analysis: "", instrument: "", study_design: "", gap_coverage: "", cost_effort: "", timing: "", feasibility_risks: "", post_hoc: true, prospective_enrolment: false, protocol_amendment: false, start_date: null, comparator, data_source, evidence_available: date},
  };
  context.mapped_tactics = [mapped];
  const html = renderToStaticMarkup(createElement(IdeationBrief, {brief: context}));
  expect(html).toContain(`Comparator: ${comparator === undefined ? "Parent comparator" : comparator || "Unknown"}`);
  expect(html).toContain(`Data source: ${data_source === undefined ? "Parent data" : data_source || "Unknown"}`);
  expect(html).toContain(`Evidence available: ${date || "Not documented"}`);
  expect(html).not.toContain("2026-01-01");
  for (const parentField of ["Parent design", "Parent question", "Parent population", "Parent outcomes"]) expect(html).not.toContain(parentField);
});
