import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import "@/modules";
import { db, ensurePlatformSchema, wipePlatform } from "@/modules/kernel/db";
import * as t from "@/modules/kernel/schema";
import type { ModuleContext, ResolvedRoute } from "@/modules/kernel/contracts";
import { listEdits } from "@/modules/kernel/edit-records";
import { NoRouteError } from "@/modules/llm/provider";
import { loadState, persistState, resetWorkedExample } from "@/lib/iegp/store";
import {
  addTimelineActivity,
  removeTimelineActivity,
  savePlan,
  setTimelineDependencies,
  timelineModel,
  timelineModule,
  updateTimelineActivity,
} from "@/modules/stages/s10-timeline/module";

/**
 * S10 by hand: a user can date, add, remove, re-lane, re-sequence and explain
 * any activity with no model, and every one of those edits survives a rebuild.
 */

const ACTOR = { name: "Manual Tester", function: "medical_affairs" as const };
const ANCHOR = "2026-01-01";
const MANUAL_TACTIC = "TAC-MANUAL-TL";

type Call = { purpose: string; body: Record<string, unknown> };

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

function context(script: (call: Call) => unknown, connected = true): { ctx: ModuleContext; calls: Call[] } {
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

const input = () => timelineModule.inputSchema.parse({ persist: true, anchor: ANCHOR });
const offline = () => context(() => ({}), false);

describe("S10 by hand", () => {
  let ids: string[] = [];
  let a: string;
  let b: string;
  let savedStub: string | undefined;

  beforeAll(async () => {
    await resetWorkedExample();
    await wipePlatform();
    await ensurePlatformSchema();
    // A tactic mapped to no gap: only a user can put it on the timeline.
    const state = await loadState();
    state.tactics.push({ ...state.tactics[0]!, id: MANUAL_TACTIC, name: "Hand-added KOL advisory board" });
    await persistState(state);
  }, 60_000);

  beforeEach(() => {
    savedStub = process.env.SYNAPSE_TEST_STUB_LLM;
    delete process.env.SYNAPSE_TEST_STUB_LLM;
  });
  afterEach(() => {
    if (savedStub === undefined) delete process.env.SYNAPSE_TEST_STUB_LLM;
    else process.env.SYNAPSE_TEST_STUB_LLM = savedStub;
  });

  it("dates every pending activity by hand, and removes and restores one, with no model", async () => {
    const before = await timelineModel(ANCHOR);
    expect(before.activities).toHaveLength(0);
    expect(before.pending.length).toBeGreaterThan(2);
    expect(before.pending[0]!.reason).toMatch(/by hand/);

    const first = before.pending[0]!;
    await expect(
      addTimelineActivity({ tactic_id: first.tactic_id, start_date: "2026-02-01", end_date: "2026-08-01", rationale: "", actor: ACTOR }),
    ).rejects.toThrow(/rationale/i);
    await expect(
      addTimelineActivity({ tactic_id: first.tactic_id, start_date: "2026-09-01", end_date: "2026-08-01", rationale: "backwards", actor: ACTOR }),
    ).rejects.toThrow(/cannot end before/);

    // Remove a pending one: it leaves the pending list and shows as removed.
    await removeTimelineActivity({ id: first.activity_id, rationale: "Not in scope this cycle", actor: ACTOR });
    const removed = await timelineModel(ANCHOR);
    expect(removed.pending.map((row) => row.activity_id)).not.toContain(first.activity_id);
    expect(removed.removed).toEqual([
      expect.objectContaining({ activity_id: first.activity_id, reason: "Not in scope this cycle" }),
    ]);
    // Adding back a never-dated activity needs dates.
    await expect(
      addTimelineActivity({ tactic_id: first.tactic_id, rationale: "Back in scope", actor: ACTOR }),
    ).rejects.toThrow(/start and an end/);

    for (const [index, row] of before.pending.entries()) {
      await addTimelineActivity({
        tactic_id: row.tactic_id,
        start_date: `2026-0${(index % 8) + 1}-01`,
        end_date: "2027-06-01",
        readout_date: "2027-09-01",
        rationale: "Dates from the study team",
        actor: ACTOR,
      });
    }
    await expect(
      addTimelineActivity({ tactic_id: first.tactic_id, start_date: "2026-01-01", end_date: "2026-02-01", rationale: "twice", actor: ACTOR }),
    ).rejects.toThrow(/already on the timeline/);

    const after = await timelineModel(ANCHOR);
    expect(after.pending).toHaveLength(0);
    expect(after.removed).toHaveLength(0);
    expect(after.activities).toHaveLength(before.pending.length);
    for (const activity of after.activities) {
      expect(activity.meta.schedule_basis).toEqual({ start: "human", end: "human", readout: "human" });
      expect(activity.meta.manual).toBe(false);
    }
    ids = after.activities.map((activity) => activity.id);
    [a, b] = ids as [string, string];
    const edits = await listEdits({ stage: "S10" });
    expect(edits.filter((edit) => edit.action === "add")).toHaveLength(before.pending.length);
  });

  it("needs a model only while something is left for it, and rebuilds offline once deps are set by hand", async () => {
    const blocked = offline();
    await expect(timelineModule.run(input(), blocked.ctx)).rejects.toBeInstanceOf(NoRouteError);
    expect(blocked.calls).toHaveLength(0);

    for (const id of ids) {
      await setTimelineDependencies({
        id,
        depends_on: id === b ? [a] : [],
        reasons: id === b ? { [a]: "Needs the registry cohort first" } : undefined,
        rationale: "Sequenced in the planning workshop",
        actor: ACTOR,
      });
    }
    const { ctx, calls } = offline();
    const { output } = await timelineModule.run(input(), ctx);
    expect(calls).toHaveLength(0);
    const dependent = output.activities.find((row) => row.id === b)!;
    expect(dependent.depends_on).toEqual([a]);
    expect(dependent.meta.depends_locked).toBe(true);
    expect(dependent.meta.dependency_note).toMatch(/Needs the registry cohort first/);
    for (const row of output.activities) expect(row.meta.schedule_basis.start).toBe("human");

    const plan = await savePlan({ status: "final", note: "Signed off without a model", actor: ACTOR });
    expect(plan.snapshot.pending).toHaveLength(0);
  });

  it("refuses self, unknown and cyclic dependencies, and edits without a rationale", async () => {
    const edit = (id: string, depends_on: string[], rationale = "resequence") =>
      setTimelineDependencies({ id, depends_on, rationale, actor: ACTOR });
    await expect(edit(a, [a])).rejects.toThrow(/itself/);
    await expect(edit(a, ["ACT-nope"])).rejects.toThrow(/Unknown activity/);
    await expect(edit(a, [b])).rejects.toThrow(/cycle/);
    await expect(edit(a, [], "x")).rejects.toThrow(/rationale/i);
    await expect(updateTimelineActivity({ id: a, lane: "sideways", rationale: "bad lane", actor: ACTOR })).rejects.toThrow(
      /Unknown lane/,
    );
  });

  it("keeps every human edit through a model rebuild and asks the model only about the rest", async () => {
    // A tactic mapped to no gap goes on the timeline by hand; its dependencies are still the model's.
    const manual = await addTimelineActivity({
      tactic_id: MANUAL_TACTIC,
      start_date: "2027-01-01",
      end_date: "2027-03-01",
      schedule_rationale: "Board meets after the first readout",
      rationale: "Advisory board agreed with brand",
      actor: ACTOR,
    });
    await updateTimelineActivity({
      id: a,
      start_date: "2026-03-01",
      lane: "low",
      schedule_rationale: "Hand-written timing",
      rationale: "Site contracts slip",
      actor: ACTOR,
    });

    const { ctx, calls } = context((call) => ({
      activities: (call.body.answer_for as string[]).map((id) => ({
        id,
        depends_on: [{ id: b, reason: "model: after the second study" }],
      })),
    }));
    const { output } = await timelineModule.run(input(), ctx);
    const dependencyCalls = calls.filter((call) => call.purpose === "timeline-dependencies");
    expect(dependencyCalls).toHaveLength(1);
    expect(dependencyCalls[0]!.body.answer_for).toEqual([manual.id]);
    expect(calls.filter((call) => call.purpose === "timeline-estimates")).toHaveLength(0);

    const rows = new Map(output.activities.map((row) => [row.id, row]));
    const edited = rows.get(a)!;
    expect(edited.start_date).toBe("2026-03-01");
    expect(edited.meta.schedule_basis.start).toBe("human");
    expect(edited.lane).toBe("low");
    expect(edited.meta.lane_locked).toBe(true);
    expect(edited.meta.schedule_rationale).toBe("Hand-written timing");
    expect(edited.meta.rationale_locked).toBe(true);
    expect(edited.depends_on).toEqual([]);
    expect(rows.get(b)!.depends_on).toEqual([a]);
    expect(rows.get(b)!.meta.dependency_note).toMatch(/Needs the registry cohort first/);

    const added = rows.get(manual.id)!;
    expect(added.meta.manual).toBe(true);
    expect(added.gap_ids).toEqual([]);
    expect(added.band).toBe("unprioritized");
    expect(added.depends_on).toEqual([b]);
    expect(added.meta.schedule_rationale).toBe("Board meets after the first readout");
    expect(added.meta.schedule_basis).toEqual({ start: "human", end: "human", readout: null });

    // The hand-written reasons are still on the row after the rebuild wrote it.
    const [stored] = await db().select().from(t.timelineActivities).where(eq(t.timelineActivities.id, b));
    expect((stored!.meta as { dependency_reasons?: Record<string, string> }).dependency_reasons).toEqual({
      [a]: "Needs the registry cohort first",
    });

    // "band" hands the lane back to the validated band.
    await updateTimelineActivity({ id: a, lane: "band", rationale: "Follow the band again", actor: ACTOR });
    const released = (await timelineModel(ANCHOR)).activities.find((row) => row.id === a)!;
    expect(released.lane).toBe(released.band);
    expect(released.meta.lane_locked).toBe(false);
    const fields = (await listEdits({ stage: "S10", entity_id: a })).map((edit) => edit.field);
    expect(fields).toEqual(expect.arrayContaining(["schedule", "lane", "schedule_rationale", "depends_on"]));
  });

  it("keeps a removed activity off every rebuild until it is added back", async () => {
    await removeTimelineActivity({ id: a, rationale: "Descoped by the brand team", actor: ACTOR });
    await expect(updateTimelineActivity({ id: a, start_date: "2026-05-01", rationale: "move", actor: ACTOR })).rejects.toThrow(
      /removed/,
    );
    await expect(removeTimelineActivity({ id: a, rationale: "again", actor: ACTOR })).rejects.toThrow(/already off/);

    const { ctx } = context((call) => ({
      activities: (call.body.answer_for as string[]).map((id) => ({ id, depends_on: [] })),
    }));
    const { output } = await timelineModule.run(input(), ctx);
    expect(output.activities.map((row) => row.id)).not.toContain(a);
    expect(output.removed.map((row) => row.activity_id)).toEqual([a]);
    // Its dependent no longer waits on it on the chart, but the hand-set list is kept.
    expect(output.activities.find((row) => row.id === b)!.depends_on).toEqual([]);

    const tacticId = a.replace(/^ACT-/, "");
    await addTimelineActivity({ tactic_id: tacticId, rationale: "Back in scope", actor: ACTOR });
    const restored = await timelineModel(ANCHOR);
    const back = restored.activities.find((row) => row.id === a)!;
    expect(back.start_date).toBe("2026-03-01");
    expect(back.meta.schedule_rationale).toBe("Hand-written timing");
    expect(restored.removed).toHaveLength(0);
    expect(restored.activities.find((row) => row.id === b)!.depends_on).toEqual([a]);
  });
});

describe("S10 overrides of model-estimated values", () => {
  beforeAll(async () => {
    await resetWorkedExample();
    await wipePlatform();
    await ensurePlatformSchema();
  }, 60_000);

  it("flips only the values a user changed to human, and a rebuild keeps them", async () => {
    // Vitest's stub stands in for the model, so every duration is a model estimate.
    const stub = context(() => ({}));
    const built = await timelineModule.run(input(), stub.ctx);
    const target = built.output.activities[0]!;
    expect(target.meta.schedule_basis.end).toBe("model");

    // The Reschedule dialog resends unchanged dates when only the lane is edited.
    await updateTimelineActivity({
      id: target.id,
      start_date: target.start_date,
      end_date: target.end_date,
      readout_date: target.readout_date,
      lane: "high",
      rationale: "Brand lead moved it up",
      actor: ACTOR,
    });
    let row = (await timelineModel(ANCHOR)).activities.find((activity) => activity.id === target.id)!;
    expect(row.meta.schedule_basis).toEqual(target.meta.schedule_basis);
    expect(row.lane).toBe("high");
    expect((await listEdits({ stage: "S10", entity_id: target.id })).map((edit) => edit.field)).toEqual(["lane"]);

    await updateTimelineActivity({
      id: target.id,
      end_date: "2030-01-01",
      schedule_rationale: "Enrolment is slower than the model assumed",
      rationale: "Feasibility came back",
      actor: ACTOR,
    });
    await timelineModule.run(input(), stub.ctx);
    row = (await timelineModel(ANCHOR)).activities.find((activity) => activity.id === target.id)!;
    expect(row.end_date).toBe("2030-01-01");
    expect(row.meta.schedule_basis.end).toBe("human");
    expect(row.meta.schedule_basis.start).toBe(target.meta.schedule_basis.start);
    expect(row.meta.schedule_rationale).toBe("Enrolment is slower than the model assumed");
    expect(row.meta.rationale_locked).toBe(true);
    expect(row.lane).toBe("high");
  });
});
