import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import "@/modules";
import { db, ensurePlatformSchema, wipePlatform } from "@/modules/kernel/db";
import * as t from "@/modules/kernel/schema";
import type { ModuleContext, ResolvedRoute } from "@/modules/kernel/contracts";
import { NoRouteError } from "@/modules/llm/provider";
import { displayedGapStatus, isLiveGap } from "@/lib/iegp/engine";
import { assignTacticToGap, createGap, createProposedTactic, loadState, resetWorkedExample } from "@/lib/iegp/store";
import { listPlacements } from "@/modules/stages/s8-prioritization/module";
import { addMonths, timelineCandidates, type TimelineCandidate } from "@/modules/stages/s10-timeline/build";
import { tacticDesigns, timelineModule } from "@/modules/stages/s10-timeline/module";

/**
 * S10 with a scripted model in place of a provider: dates a tactic's own design
 * or the team fixed are used as they are, the model estimates only what is
 * missing and infers the dependencies, a suggested band never places an
 * activity, and the stage fails rather than fill anything in.
 */

const ACTOR = { name: "LLM Test", function: "medical_affairs" as const };
const ANCHOR = "2026-01-01";

type Call = { purpose: string; body: Record<string, unknown> };
type Script = (call: Call) => unknown;

function route(connected: boolean): ResolvedRoute {
  return {
    stage: "S10",
    provider_id: "anthropic-claude",
    provider_label: "Claude",
    model: "claude-test",
    auth: connected ? "api_key" : "none",
    connected,
    params: { temperature: 0, max_tokens: 4096 },
    fallbacks: [],
    degraded: !connected,
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

type AskedActivity = { id: string; estimate: string[]; priority: string };
const asked = (call: Call) => call.body.activities as AskedActivity[];
const answerFor = (call: Call) => call.body.answer_for as string[];
const noDependencies = (call: Call) => ({ activities: answerFor(call).map((id) => ({ id, depends_on: [] })) });
const estimated = (call: Call, skip: string[] = []) => ({
  activities: asked(call)
    .filter((row) => !skip.includes(row.id))
    .map((row) => ({
      id: row.id,
      start_offset_months: 4,
      duration_months: 10,
      readout_lag_months: 2,
      rationale: `model timing for ${row.id}`,
    })),
});

describe("S10 on the model path", () => {
  let candidates: TimelineCandidate[] = [];
  let designed: TimelineCandidate;
  let fresh: TimelineCandidate;
  let unprioritized: TimelineCandidate;
  let savedStub: string | undefined;

  beforeAll(async () => {
    await resetWorkedExample();
    await wipePlatform();
    await ensurePlatformSchema();
    await createGap({
      statement: "No real-world persistence data in routine care.",
      actor_name: ACTOR.name,
      actor_function: ACTOR.function,
    });
    let state = await loadState();
    const openGap = state.gaps.find((gap) => isLiveGap(gap) && displayedGapStatus(gap) === "validated_open")!;

    // A tactic with no dates of its own: every schedule field is the model's.
    const before = new Set(state.tactics.map((tactic) => tactic.id));
    await createProposedTactic({
      name: "Model-dated registry",
      type: "registry",
      description: "Test tactic with no dates",
      evidence_question: "What happens in routine care?",
      population: "Adults",
      intervention: state.asset.name,
      comparator: "Standard of care",
      outcomes: "Persistence",
      geography: state.asset.geography,
      owner: ACTOR.name,
      function: ACTOR.function,
      residual_ids: [],
      gap_id: openGap.id,
      actor_name: ACTOR.name,
      actor_function: ACTOR.function,
    });
    state = await loadState();
    const freshTactic = state.tactics.find((tactic) => !before.has(tactic.id))!;
    try {
      await assignTacticToGap({
        gap_id: openGap.id,
        tactic_id: freshTactic.id,
        actor_name: ACTOR.name,
        actor_function: ACTOR.function,
        note: "test",
      });
    } catch {
      // createProposedTactic may already have joined the pair.
    }
    state = await loadState();

    // A suggested High that nobody validated.
    await db().insert(t.priorityPlacements).values({
      gap_id: openGap.id,
      axis_scores: { decision_impact: 90 },
      suggested_band: "high",
      suggested_rationale: "model suggestion",
      band: "high",
      validated: false,
      rationale: null,
      actor_name: null,
      actor_function: null,
      at: "2026-01-01T00:00:00.000Z",
    });

    const all = timelineCandidates({ state, placements: await listPlacements() });
    fresh = all.find((candidate) => candidate.tactic.id === freshTactic.id)!;
    expect(fresh).toBeTruthy();
    expect(fresh.tactic.start_date).toBeNull();
    unprioritized = fresh;
    designed = all.find((candidate) => candidate.id !== fresh.id && candidate.tactic.start_date)!;

    // The accepted S9 idea behind `designed` carries its model-proposed timing.
    await db().insert(t.ideationProposals).values({
      id: "idea-s10-test",
      gap_id: designed.gap_ids[0]!,
      name: designed.tactic.name,
      type: designed.tactic.type,
      rationale: "test",
      evidence_question: designed.tactic.evidence_question,
      design: {
        population: "",
        comparator: "",
        outcomes: "",
        data_source: "",
        study_design: "",
        duration_months: 11,
        readout_lag_months: 3,
        timing_rationale: "Eleven months to enrol and follow up.",
      },
      status: "accepted",
      created_at: "2026-01-01T00:00:00.000Z",
      tactic_id: designed.tactic.id,
    });
    candidates = timelineCandidates({ state, placements: await listPlacements(), designs: await tacticDesigns() });
    expect(candidates.length).toBeGreaterThan(2);
  }, 60_000);

  beforeEach(() => {
    savedStub = process.env.SYNAPSE_TEST_STUB_LLM;
    delete process.env.SYNAPSE_TEST_STUB_LLM;
  });
  afterEach(() => {
    if (savedStub === undefined) delete process.env.SYNAPSE_TEST_STUB_LLM;
    else process.env.SYNAPSE_TEST_STUB_LLM = savedStub;
  });

  const input = () => timelineModule.inputSchema.parse({ persist: false, anchor: ANCHOR });

  it("throws before doing anything when no LLM is connected", async () => {
    const { ctx, calls } = context(() => ({}), false);
    await expect(timelineModule.run(input(), ctx)).rejects.toBeInstanceOf(NoRouteError);
    expect(calls).toHaveLength(0);
  });

  it("uses a tactic's designed timing as it is and asks the model only for what is missing", async () => {
    const { ctx, calls } = context((call) =>
      call.purpose === "timeline-dependencies" ? noDependencies(call) : estimated(call),
    );
    const { output } = await timelineModule.run(input(), ctx);

    const estimateCalls = calls.filter((call) => call.purpose === "timeline-estimates");
    expect(estimateCalls).toHaveLength(1);
    const rows = asked(estimateCalls[0]!);
    // The designed tactic has its start, duration and lag, so it is not asked about.
    expect(rows.map((row) => row.id)).not.toContain(designed.id);
    expect(rows.find((row) => row.id === fresh.id)!.estimate).toEqual([
      "start_offset_months",
      "duration_months",
      "readout_lag_months",
    ]);
    const seeded = rows.find((row) => row.id !== fresh.id)!;
    expect(seeded.estimate).toContain("duration_months");
    expect(seeded.estimate).not.toContain("start_offset_months");

    const design = output.activities.find((row) => row.id === designed.id)!;
    expect(design.start_date).toBe(designed.tactic.start_date);
    expect(design.end_date).toBe(addMonths(designed.tactic.start_date!, 11));
    expect(design.readout_date).toBe(designed.tactic.evidence_available ?? addMonths(design.end_date, 3));
    expect(design.meta.schedule_basis.end).toBe("design");
    expect(design.meta.schedule_rationale).toBe("Eleven months to enrol and follow up.");

    const dated = output.activities.find((row) => row.id === fresh.id)!;
    expect(dated.start_date).toBe(addMonths(ANCHOR, 4));
    expect(dated.end_date).toBe(addMonths(dated.start_date, 10));
    expect(dated.readout_date).toBe(addMonths(dated.end_date, 2));
    expect(dated.meta.schedule_basis).toEqual({ start: "model", end: "model", readout: "model" });
    expect(dated.meta.schedule_rationale).toBe(`model timing for ${fresh.id}`);
    expect(output.pending).toHaveLength(0);
  });

  it("asks again for an activity the model left undated instead of filling it in", async () => {
    let first = true;
    const { ctx, calls } = context((call) => {
      if (call.purpose === "timeline-dependencies") return noDependencies(call);
      if (first) {
        first = false;
        return estimated(call, [fresh.id]);
      }
      return estimated(call);
    });
    const { output } = await timelineModule.run(input(), ctx);
    const retry = calls.filter((call) => call.purpose === "timeline-estimates")[1]!;
    expect(asked(retry).map((row) => row.id)).toEqual([fresh.id]);
    expect(retry.body.note).toMatch(/left these activities out/);
    expect(output.activities.find((row) => row.id === fresh.id)!.start_date).toBe(addMonths(ANCHOR, 4));
  });

  it("fails the run when the model never dates an activity", async () => {
    const { ctx } = context((call) =>
      call.purpose === "timeline-dependencies" ? noDependencies(call) : estimated(call, [fresh.id]),
    );
    await expect(timelineModule.run(input(), ctx)).rejects.toThrow(/did not return a complete schedule estimate/);
  });

  it("takes dependencies from the model, re-asking when one names an unknown activity", async () => {
    const upstream = designed.id;
    let dependencyCalls = 0;
    const { ctx, calls } = context((call) => {
      if (call.purpose === "timeline-estimates") return estimated(call);
      dependencyCalls += 1;
      return {
        activities: answerFor(call).map((id) =>
          id === fresh.id
            ? {
                id,
                depends_on: [
                  { id: dependencyCalls === 1 ? "ACT-nope" : upstream, reason: "needs its readout first" },
                ],
              }
            : { id, depends_on: [] },
        ),
      };
    });
    const { output } = await timelineModule.run(input(), ctx);

    const dependencies = calls.filter((call) => call.purpose === "timeline-dependencies");
    expect(dependencies).toHaveLength(2);
    expect(answerFor(dependencies[1]!)).toEqual([fresh.id]);
    // The estimate prompt carries the model's dependency so it can sequence.
    const estimate = calls.find((call) => call.purpose === "timeline-estimates")!;
    expect(
      (estimate.body.activities as { id: string; depends_on: { id: string }[] }[]).find((row) => row.id === fresh.id)!
        .depends_on,
    ).toEqual([{ id: upstream, reason: "needs its readout first" }]);

    const upstreamRow = output.activities.find((row) => row.id === upstream)!;
    const dependent = output.activities.find((row) => row.id === fresh.id)!;
    expect(dependent.depends_on).toEqual([upstream]);
    expect(dependent.meta.dependency_note).toMatch(/needs its readout first/);
    expect(dependent.start_date >= (upstreamRow.readout_date ?? upstreamRow.end_date)).toBe(true);
    for (const row of output.activities.filter((activity) => activity.id !== fresh.id)) {
      expect(row.depends_on).toEqual([]);
    }
  });

  it("rejects a dependency cycle and asks again", async () => {
    const [a, b] = [designed.id, fresh.id];
    let round = 0;
    const { ctx, calls } = context((call) => {
      if (call.purpose === "timeline-estimates") return estimated(call);
      round += 1;
      // Round one names a loop; asked again, the model drops the edge that closed it.
      if (round > 1) return noDependencies(call);
      return {
        activities: answerFor(call).map((id) => {
          if (id === a) return { id, depends_on: [{ id: b, reason: "loop" }] };
          if (id === b) return { id, depends_on: [{ id: a, reason: "waits on a" }] };
          return { id, depends_on: [] };
        }),
      };
    });
    const { output } = await timelineModule.run(input(), ctx);
    const dependencyCalls = calls.filter((call) => call.purpose === "timeline-dependencies");
    expect(dependencyCalls).toHaveLength(2);
    expect(answerFor(dependencyCalls[1]!)).toHaveLength(1);
    expect(dependencyCalls[1]!.body.note).toMatch(/cycle/);
    const rows = new Map(output.activities.map((row) => [row.id, row]));
    const edges = [rows.get(a)!.depends_on, rows.get(b)!.depends_on];
    // One direction survives; never both.
    expect(edges.filter((list) => list.length > 0)).toHaveLength(1);
  });

  it("never places an activity by a band nobody validated", async () => {
    const { ctx, calls } = context((call) =>
      call.purpose === "timeline-dependencies" ? noDependencies(call) : estimated(call),
    );
    const { output } = await timelineModule.run(input(), ctx);
    const activity = output.activities.find((row) => row.id === unprioritized.id)!;
    expect(activity.band).toBe("unprioritized");
    expect(activity.lane).toBe("unprioritized");
    expect(output.lanes.find((lane) => lane.id === "high")!.count).toBe(
      output.activities.filter((row) => row.band === "high").length,
    );
    const prompt = asked(calls.find((call) => call.purpose === "timeline-estimates")!);
    expect(prompt.find((row) => row.id === unprioritized.id)!.priority).toBe("not yet prioritized");
  });
});
