import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import "@/modules";
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

type Call = { purpose: string; body: Record<string, unknown> };
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

function context(script: Script, connected = true): { ctx: ModuleContext; calls: Call[] } {
  const calls: Call[] = [];
  const ctx: ModuleContext = {
    ai: true,
    workspace_id: "default",
    actor: ACTOR,
    role: "medical_affairs",
    route: route(connected),
    run: { id: "test", step: async (_name, fn) => fn(), note: () => {}, steps: () => [] },
    complete: async ({ purpose, user }) => {
      const call = { purpose, body: JSON.parse(user) as Record<string, unknown> };
      calls.push(call);
      return script(call);
    },
  };
  return { ctx, calls };
}

type PromptGap = { id: string; revise?: { id: string; objection: string }[]; problems?: string[] };
type PromptTactic = { id: string; gap_id: string; name: string };
type JudgeGap = { id: string; problem?: string; candidates: { id: string; name: string }[] };

const gapsOf = (call: Call) => call.body.gaps as PromptGap[];
const tacticsOf = (call: Call) => call.body.tactics as PromptTactic[];
const judgeGapsOf = (call: Call) => call.body.gaps as JudgeGap[];

function tactic(gap_id: string, name: string, overrides: Record<string, unknown> = {}) {
  return {
    gap_id,
    name,
    type: "rwe_study",
    evidence_question: `Question for ${name}`,
    rationale: `Why ${name}`,
    comparative_rationale: "New study adds data unavailable from existing scope; more time/cost but credible quality and feasibility",
    population: "Adults on therapy",
    comparator: "Standard of care",
    outcomes: "OS",
    data_source: "Claims",
    study_design: "Retrospective cohort",
    duration_months: 11,
    readout_lag_months: 4,
    timing_rationale: `Timing for ${name}`,
    ...overrides,
  };
}

const keepAll = (call: Call) => ({
  reviews: tacticsOf(call).map((row) => ({ id: row.id, verdict: "keep", confidence: 70, note: `holds: ${row.name}` })),
});

/** Accepts the first `take` candidates of each gap, ranked in order. */
const judgeFirst = (call: Call, take: number) => ({
  gaps: judgeGapsOf(call).map((gap) => ({
    gap_id: gap.id,
    decisions: gap.candidates.map((candidate, index) => ({
      id: candidate.id,
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
    for (const gap_id of ids) await validatePlacement({gap_id,band:"high",rationale:"Blocks dossier",actor:ACTOR});
    libraryId = state.tactics[0]!.id;
  }, 60_000);

  beforeEach(() => {
    savedStub = process.env.SYNAPSE_TEST_STUB_LLM;
    delete process.env.SYNAPSE_TEST_STUB_LLM;
  });
  afterEach(() => {
    if (savedStub === undefined) delete process.env.SYNAPSE_TEST_STUB_LLM;
    else process.env.SYNAPSE_TEST_STUB_LLM = savedStub;
  });

  const input = (per_gap = 1) => ideationModule.inputSchema.parse({ gap_ids: ids, per_gap, dry_run: true });

  it("explicit IDs cannot bypass human-validated High priority", async () => {
    await validatePlacement({gap_id:ids[0]!,band:"medium",rationale:"Later cycle",actor:ACTOR});
    const {ctx} = context(call => call.purpose === "ideation-proposer" ? {tactics:gapsOf(call).map(g=>tactic(g.id,"Eligible"))} : call.purpose === "ideation-critic" ? keepAll(call) : judgeFirst(call,1));
    const {output} = await ideationModule.run(input(),ctx);
    expect(output.gaps_considered).toBe(1); expect(output.proposals.map(p=>p.gap_id)).toEqual([ids[1]]);
    await validatePlacement({gap_id:ids[0]!,band:"high",rationale:"Blocks dossier",actor:ACTOR});
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
              ? { id: row.id, verdict: "revise", confidence: 40, note: "comparator should be physician's choice", issues: ["comparator"] }
              : row.name === "A2"
                ? { id: row.id, verdict: "drop", confidence: 10, note: "library already has this", duplicate_of: libraryId }
                : { id: row.id, verdict: "keep", confidence: 75, note: `holds: ${row.name}` },
          ),
        };
      }
      // Judge: prefer B2 over B1 to show rank comes from the model.
      return {
        gaps: judgeGapsOf(call).map((gap) => ({
          gap_id: gap.id,
          decisions: gap.candidates.map((candidate) => ({
            id: candidate.id,
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
    const revision = calls.filter((call) => call.purpose === "ideation-proposer")[1]!;
    expect(gapsOf(revision).map((gap) => gap.id)).toEqual([a]);
    expect(gapsOf(revision)[0]!.revise![0]!.objection).toBe("comparator should be physician's choice");

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
    const script:Script=call=>call.purpose === "ideation-proposer" ? {tactics:gapsOf(call).map(g=>tactic(g.id,"Baseline expansion",{proposal_kind:"expansion",target_tactic_id:target,expansion_scope:scope}))} : call.purpose === "ideation-critic" ? keepAll(call) : judgeFirst(call,1);
    const recorder=new RunRecorder({workspace_id:"default",stage:"S9",module_id:ideationModule.manifest.id,module_version:ideationModule.manifest.version,actor:ACTOR,input:{gap_ids:ids}});
    await openRun(recorder); const {ctx}=context(script); ctx.run=recorder;
    const generated=await ideationModule.run({...input(),dry_run:false},ctx); await closeRun({recorder,status:"ok",output:generated.output,route:ctx.route});
    const p=(await listIdeationProposals()).find(p=>p.target_tactic_id===target && p.gap_id===ids[0])!;
    await decideIdeationProposal({id:p.id,decision:"reject",rationale:"Feasibility pending",actor:ACTOR});
    const rerun=await ideationModule.run(input(),context(script).ctx); expect(rerun.output.proposals.some(p=>p.gap_id===ids[0])).toBe(false);
    await restoreIdeationProposal({id:p.id,rationale:"New feasibility information",actor:ACTOR});
    const restored=await ideationModule.run(input(),context(script).ctx); expect(restored.output.proposals.some(p=>p.gap_id===ids[0])).toBe(true);
    const editedScope={...scope,cost_effort:"One analyst month"};
    await editIdeationProposal({id:p.id,fields:{expansion_scope:editedScope},rationale:"Human budget refinement",actor:ACTOR});
    await ideationModule.run({...input(),dry_run:false},context(script).ctx);
    expect((await listIdeationProposals()).find(r=>r.id===p.id)?.expansion_scope).toEqual(editedScope);
    await decideIdeationProposal({id:p.id,decision:"accept",rationale:"Credible existing data",actor:ACTOR});
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
  it("asks again for a gap whose tactic has an invalid type or no duration", async () => {
    const [a, b] = ids as [string, string];
    let firstProposal = true;
    const { ctx, calls } = context((call) => {
      if (call.purpose === "ideation-critic") return keepAll(call);
      if (call.purpose === "ideation-judge") return judgeFirst(call, 1);
      if (firstProposal) {
        firstProposal = false;
        const broken = tactic(b, "B broken", { type: "moonshot" }) as Record<string, unknown>;
        delete broken.duration_months;
        return { tactics: [tactic(a, "A1"), broken] };
      }
      return { tactics: gapsOf(call).map((gap) => tactic(gap.id, "B fixed", { duration_months: 7, readout_lag_months: 2 })) };
    });

    const { output } = await ideationModule.run(input(1), ctx);

    const retry = calls.filter((call) => call.purpose === "ideation-proposer")[1]!;
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
      return judgeFirst(call, judgeCalls === 1 ? 3 : 2);
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
            reviews: tacticsOf(call).map((row) => ({ id: row.id, verdict: "drop", confidence: 5, note: "dup", duplicate_of: "not-a-tactic" })),
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
    const original = { proposal_kind: row.proposal_kind, comparative_rationale: row.comparative_rationale, name: row.name, type: row.type, evidence_question: row.evidence_question, rationale: row.rationale, design: (row.design as { original_ai: { design: unknown } }).original_ai.design };
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
    const post = (body: Record<string, unknown>) => POST(new Request("http://localhost/api/plan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ actor_name: ACTOR.name, actor_function: ACTOR.function, id: row.id, rationale: "Review rationale", ...body }) }));
    if (flow === "saved-edit") expect((await post({ action: "edit_proposal", name: "Human idea", population: "Human population" })).status).toBe(200);
    const humanComparison = "Human comparison: existing analyses cannot measure this outcome; the new registry costs more but has feasible recruitment.";
    if (flow === "comparison-edit") expect((await post({ action: "edit_proposal", comparative_rationale: humanComparison })).status).toBe(200);
    expect((await post({ action: "decide_proposal", decision: "accept", ...(flow === "inline-edit" ? { name: "Human idea", population: "Human population" } : {}) })).status).toBe(200);
    const examples = await sharedDb().execute(sql`select ai_output, ai_input, final, outcome, run_id, actor from decision_examples where run_id = ${recorder.id}`);
    if (flow.includes("missing-comparison")) {
      expect(examples).toHaveLength(0);
      return;
    }
    expect(examples).toHaveLength(1); expect(examples[0].ai_output).toEqual(original);
    expect(examples[0].ai_input).toMatchObject({ slot_id: slot });
    expect(examples[0].outcome).toBe(flow === "unchanged" ? "accepted" : "edited");
    expect(examples[0].run_id).toBe(recorder.id); expect(examples[0].actor).toEqual(ACTOR);
    if (flow === "comparison-edit") {
      expect(examples[0].final).toEqual({ ...original, comparative_rationale: humanComparison });
      const saved = (await db().select().from(ideationProposals)).find(p => p.id === row.id)!;
      expect((saved.design as { original_ai: unknown }).original_ai).toEqual(original);
      expect(saved.design).toMatchObject({ slot_id: slot, run_id: recorder.id });
      expect((await post({ action: "decide_proposal", decision: "accept" })).status).toBe(400);
      expect(await sharedDb().execute(sql`select id from decision_examples where run_id = ${recorder.id}`)).toHaveLength(1);
    } else if (flow !== "unchanged") expect(examples[0].final).toMatchObject({ name: "Human idea", design: { population: "Human population" } });
    else expect(examples[0].final).toBeNull();
  });

});
