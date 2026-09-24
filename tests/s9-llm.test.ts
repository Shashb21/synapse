import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import "@/modules";
import { wipePlatform } from "@/modules/kernel/db";
import type { ModuleContext, ResolvedRoute } from "@/modules/kernel/contracts";
import { NoRouteError } from "@/modules/llm/provider";
import { displayedGapStatus, isLiveGap } from "@/lib/iegp/engine";
import { createGap, createProposedTactic, loadState, resetSeed } from "@/lib/iegp/store";
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
    reason: connected ? null : "No LLM provider is connected. Log in at /control.",
  };
}

function context(script: Script, connected = true): { ctx: ModuleContext; calls: Call[] } {
  const calls: Call[] = [];
  const ctx: ModuleContext = {
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
    await resetSeed();
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
});
