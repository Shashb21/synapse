/** Independent accepted scopes use the existing schedule and coverage owners. */
import { describe, expect, it } from "vitest";
import { buildSeed } from "@/lib/iegp/seed";
import type { TacticExpansion } from "@/lib/iegp/types";
import { buildTimeline, type SavedActivity } from "@/modules/stages/s10-timeline/build";
import { gapTimelineView } from "@/modules/stages/s10-timeline/gap-view";

function fixture() {
  const state = buildSeed();
  const parent = {...state.tactics[0]!, status: "ongoing" as const};
  const gap = state.gaps[0]!;
  gap.status = "validated_open";
  gap.status_override = null;
  gap.computed_status = "validated_open";
  state.tactics = [parent];
  state.expansions = ["A", "B"].map(id => ({id, tactic_id: parent.id, gap_ids: [gap.id], status: "proposed", version: id, proposal_id: `proposal-${id}`, history: [], created_at: "2026-10-07", updated_at: "2026-10-07", actor: {name: "Reviewer", function: "heor"},
    scope: {name: `Added scope ${id}`, evidence_question: `Question ${id}`, population: "Added cohort", outcomes: "QoL", study_design: "Post-hoc", geography: "US", data_cut: "2026", analysis: "Subgroup analysis", instrument: "", gap_coverage: "Added cohort", cost_effort: "Two weeks", timing: "Q4", feasibility_risks: "Small sample", post_hoc: true, prospective_enrolment: false, protocol_amendment: false, start_date: null, evidence_available: null},
  }) as TacticExpansion);
  state.coverages = state.expansions.map(child => ({...state.coverages[0]!, id: `C-${child.id}`, gap_id: gap.id, tactic_id: parent.id, expansion_id: child.id, overall: "full" as const}));
  const overrides: SavedActivity[] = [
    {id: `ACT-${parent.id}`, start_date: "2026-01-01", end_date: "2026-02-01", readout_date: null, lane: "high", depends_on: [], meta: {manual: true, depends_locked: true}},
    ...state.expansions.map((child, i) => ({id: `ACT-EXP-${child.id}`, start_date: `2026-0${i+3}-01`, end_date: `2026-0${i+4}-01`, readout_date: null, lane: "high", depends_on: [`ACT-${parent.id}`], meta: {depends_locked: true, schedule_basis: {start: "human" as const, end: "human" as const, readout: null}}})),
  ];
  return {state, parent, gap, overrides, placements: []};
}

describe("independent expansion timeline", () => {
  it('uses recorded child type/comparator/data source in dated and undated details and leaves missing history unknown',()=>{
    const args=fixture(), before=structuredClone(args.state.tactics);
    Object.assign(args.state.expansions[0].scope,{type:'subgroup_analysis',comparator:'Active cohort',data_source:'Linked registry'});
    const dated=buildTimeline(args);
    expect(dated.activities.find(a=>a.expansion_id==='A')).toMatchObject({tactic_type:'subgroup_analysis',tactic_custom_type:null,meta:{comparator:'Active cohort',data_source:'Linked registry'}});
    expect(dated.activities.find(a=>a.expansion_id==='B')).toMatchObject({tactic_type:'not_recorded',tactic_custom_type:null,meta:{comparator:'',data_source:''}});
    args.overrides=[];
    const undated=buildTimeline(args);
    expect(undated.pending.find(a=>a.expansion_id==='A')).toMatchObject({tactic_type:'subgroup_analysis',meta:{comparator:'Active cohort',data_source:'Linked registry'}});
    expect(undated.pending.find(a=>a.expansion_id==='B')).toMatchObject({tactic_type:'not_recorded',meta:{comparator:'',data_source:''}});
    expect(args.state.tactics).toEqual(before);
  });
  it("shows parent context for child-only mappings without inventing parent coverage or a schedule", () => {
    const args = fixture();
    args.overrides = [];
    const model = buildTimeline(args);
    const view = gapTimelineView({...args, model});
    const items = view.not_prioritized.find(group => group.gap_id === args.gap.id)!.items;
    expect(items.map(item => item.activity_id)).toEqual([`ACT-${args.parent.id}`, "ACT-EXP-A", "ACT-EXP-B"]);
    expect(items[0]).toMatchObject({context_only: true, activity: null, pending: null});
    expect(model.activities).toEqual([]);
    expect(model.pending.map(item => item.activity_id)).toEqual(["ACT-EXP-A", "ACT-EXP-B"]);
    // Parent grouping also survives when its children appear in Other activities.
    args.gap.computed_status = "validated_addressed";
    expect(gapTimelineView({...args, model: buildTimeline(args)}).other.map(item => item.activity_id))
      .toEqual([`ACT-${args.parent.id}`, "ACT-EXP-A", "ACT-EXP-B"]);
  });
  it("keeps a removed parent as context only without restoring its schedule or copying child coverage", () => {
    const args = fixture();
    args.overrides[0]!.meta!.removed = true;
    const before = structuredClone(args.overrides);
    const model = buildTimeline(args);
    const items = gapTimelineView({...args, model}).not_prioritized.find(group => group.gap_id === args.gap.id)!.items;
    expect(items[0]).toMatchObject({activity_id: `ACT-${args.parent.id}`, context_only: true, activity: null, pending: null});
    expect(model.removed.map(row => row.activity_id)).toEqual([`ACT-${args.parent.id}`]);
    expect(model.activities.map(row => row.id)).toEqual(["ACT-EXP-A", "ACT-EXP-B"]);
    expect(model.pending).toEqual([]);
    expect(args.overrides).toEqual(before);
    expect(JSON.parse(JSON.stringify(model)).activities).toHaveLength(2);
  });
  it("carries independent status and coverage eligibility before child dates exist", () => {
    const args = fixture();
    args.overrides = args.overrides.filter(row => row.id !== "ACT-EXP-A");
    const parentAndSibling = buildTimeline(args).activities;
    const scope = structuredClone(args.state.expansions[0]!.scope);
    expect(buildTimeline(args).pending[0]).toMatchObject({activity_id: "ACT-EXP-A", tactic_status: "proposed", parent_activity_id: `ACT-${args.parent.id}`, meta: {counts_toward_addressing: false}});
    args.state.expansions[0]!.status = "planned";
    const planned = buildTimeline(args);
    expect(planned.pending[0]).toMatchObject({tactic_status: "planned", expansion_scope: scope, meta: {counts_toward_addressing: true}});
    expect(planned.activities).toEqual(parentAndSibling);
    expect(args.state.expansions[0]!.scope).toEqual(scope);
  });
  it("keeps distinct parent and children with child-only status, scope and eligibility", () => {
    const args = fixture();
    const model = buildTimeline(args);
    expect(model.activities).toHaveLength(3);
    expect(model.activities.find(a => a.id === "ACT-EXP-A")).toHaveProperty("expansion_scope", args.state.expansions[0]!.scope);
    expect(model.activities.find(a => a.id === "ACT-EXP-A")).toMatchObject({expansion_id: "A", parent_activity_id: `ACT-${args.parent.id}`, tactic_status: "proposed", meta: {population: "Added cohort", counts_toward_addressing: false}});
    args.state.expansions[0]!.status = "planned";
    const planned = buildTimeline(args);
    expect(planned.activities.find(a => a.id === "ACT-EXP-A")?.meta.counts_toward_addressing).toBe(true);
    expect(planned.activities.find(a => a.id === `ACT-${args.parent.id}`)?.meta.counts_toward_addressing).toBe(false);
    expect(planned.activities.find(a => a.id === "ACT-EXP-B")?.tactic_status).toBe("proposed");
  });
  it("retains each human schedule and dependency through removal and restoration", () => {
    const args = fixture();
    const original = buildTimeline(args);
    args.overrides[1]!.meta!.removed = true;
    const removed = buildTimeline(args);
    expect(removed.activities.map(a => a.id)).toEqual([`ACT-${args.parent.id}`, "ACT-EXP-B"]);
    expect(removed.removed[0]).toMatchObject({expansion_id: "A", tactic_id: args.parent.id});
    args.overrides[1]!.meta!.removed = false;
    expect(buildTimeline(args)).toEqual(original);
  });
  it("keeps children under their parent even when other activities start earlier", () => {
    const args = fixture();
    args.gap.computed_status = "validated_addressed";
    args.overrides[0]!.start_date = "2028-01-01";
    args.overrides[0]!.end_date = "2028-02-01";
    const view = gapTimelineView({...args, model: buildTimeline(args)});
    expect(view.other.map(item => item.activity_id)).toEqual([`ACT-${args.parent.id}`, "ACT-EXP-A", "ACT-EXP-B"]);
  });
  it("groups children under their parent with identities retained in serializable exports", () => {
    const args = fixture();
    const model = buildTimeline(args);
    const view = gapTimelineView({...args, model});
    const items = [...view.prioritized, ...view.not_prioritized, ...view.deferred].find(g => g.gap_id === args.gap.id)!.items;
    expect(items.map(i => i.activity_id)).toEqual([`ACT-${args.parent.id}`, "ACT-EXP-A", "ACT-EXP-B"]);
    expect(JSON.parse(JSON.stringify(model)).activities[1]).toMatchObject({expansion_id: "A", parent_activity_id: `ACT-${args.parent.id}`});
  });
});

import "@/modules";
import { db, ensurePlatformSchema, wipePlatform } from "@/modules/kernel/db";
import * as tables from "@/modules/kernel/schema";
import { persistState, loadState } from "@/lib/iegp/store";
import { addTimelineActivity, removeTimelineActivity, updateTimelineActivity, setTimelineDependencies, timelineModel, tacticDesigns, savePlan, timelineModule } from "@/modules/stages/s10-timeline/module";
import type { ModuleContext } from "@/modules/kernel/contracts";

it("persists independent dates and human dependency locks through rebuild, child restore and plan export", async () => {
  const args = fixture();
  await persistState(args.state);
  await wipePlatform();
  await ensurePlatformSchema();
  const actor = {name: "Timeline reviewer", function: "heor" as const};
  for (const row of args.overrides) {
    await addTimelineActivity({tactic_id: row.id === "ACT-EXP-B" ? "" : args.parent.id, activity_id: row.id === "ACT-EXP-B" ? row.id : undefined, expansion_id: row.id.startsWith("ACT-EXP-") && row.id !== "ACT-EXP-B" ? row.id.slice(8) : undefined,
      start_date: row.start_date, end_date: row.end_date, rationale: "Team agreed dates", actor});
    await setTimelineDependencies({id: row.id, depends_on: row.depends_on, rationale: "Team agreed sequence", actor});
  }
  const scopeBefore = (await loadState()).expansions;
  const before = await timelineModel();
  await updateTimelineActivity({id: "ACT-EXP-A", start_date: "2027-01-01", end_date: "2027-03-01", rationale: "Child funding moved", actor});
  await setTimelineDependencies({id: "ACT-EXP-B", depends_on: ["ACT-EXP-A"], rationale: "Wait for child analysis", actor});
  await removeTimelineActivity({id: "ACT-EXP-A", rationale: "Temporarily removed", actor});
  const ctx = {ai: false, actor, workspace_id: "default", run: {step: async (_name: string, fn: () => Promise<unknown>) => fn(), note: () => {}}} as unknown as ModuleContext;
  await timelineModule.run(timelineModule.inputSchema.parse({persist: true}), ctx);
  expect((await timelineModel()).removed).toEqual([expect.objectContaining({expansion_id: "A", tactic_id: args.parent.id})]);
  await addTimelineActivity({tactic_id: args.parent.id, expansion_id: "A", rationale: "Back in cycle", actor});
  await timelineModule.run(timelineModule.inputSchema.parse({persist: true}), ctx);
  const restored = await timelineModel();
  expect(restored.activities.find(a => a.id === "ACT-EXP-A")).toMatchObject({start_date: "2027-01-01", end_date: "2027-03-01", depends_on: [`ACT-${args.parent.id}`]});
  expect(restored.activities.find(a => a.id === "ACT-EXP-B")).toMatchObject({start_date: "2026-04-01", depends_on: ["ACT-EXP-A"]});
  expect(restored.activities.find(a => a.id === `ACT-${args.parent.id}`)).toEqual(before.activities.find(a => a.id === `ACT-${args.parent.id}`));
  expect((await loadState()).expansions).toEqual(scopeBefore);
  const plan = await savePlan({status: "final", note: "Reviewed separate child activities", actor});
  expect(plan.snapshot.activities.find(a => a.id === "ACT-EXP-A")).toMatchObject({expansion_id: "A", parent_activity_id: `ACT-${args.parent.id}`});
  await expect(addTimelineActivity({tactic_id: args.parent.id, expansion_id: "missing", rationale: "Wrong child", actor})).rejects.toThrow(/expansion/i);
});

it("uses expansion design timing only for its activity, never for the parent", async () => {
  await wipePlatform(); await ensurePlatformSchema();
  const common = {gap_id: "G", type: "rwe_study", rationale: "Reviewed", evidence_question: "Question", status: "accepted", created_at: "2026-10-07", tactic_id: "P"};
  await db().insert(tables.ideationProposals).values([
    {...common, id: "parent-design", name: "Parent", design: {duration_months: 12}},
    {...common, id: "child-design", name: "Child", proposal_kind: "expansion", expansion_id: "A", design: {duration_months: 3}},
  ]);
  const designs = await tacticDesigns();
  expect(designs.get("P")).toEqual({duration_months: 12});
  expect(designs.get("ACT-EXP-A")).toEqual({duration_months: 3});
});
