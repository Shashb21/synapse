import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import "@/modules";
import { db, ensurePlatformSchema, wipePlatform } from "@/modules/kernel/db";
import * as t from "@/modules/kernel/schema";
import type { ModuleContext, ResolvedRoute } from "@/modules/kernel/contracts";
import { listEdits } from "@/modules/kernel/edit-records";
import { buildSeed } from "@/lib/iegp/seed";
import { resetDemo } from "@/lib/iegp/store";
import { buildTimeline, estimatedFields, inclusionOf } from "@/modules/stages/s10-timeline/build";
import { planIssues } from "@/modules/stages/s10-timeline/plan-checks";
import { fingerprintCode, planFingerprint } from "@/modules/stages/s10-timeline/plan-fingerprint";
import {
  acceptTimelineEstimates,
  addTimelineActivity,
  reviewTimelineDependency,
  savePlan,
  setTimelineDependencies,
  timelineModel,
  timelineModule,
  updateTimelineActivity,
} from "@/modules/stages/s10-timeline/module";

/**
 * KAN-85: the roadmap is a projection of the approved plan. A model's
 * dependencies are proposals a person reviews, its date estimates are marked
 * until accepted, and a final save explains everything still open.
 */

const ACTOR = { name: "Roadmap Tester", function: "medical_affairs" as const };
const ANCHOR = "2026-01-01";

type Call = { purpose: string; body: Record<string, unknown> };

const route: ResolvedRoute = {
  stage: "S10",
  provider_id: "anthropic-claude",
  provider_label: "Claude",
  model: "claude-test",
  auth: "api_key",
  connected: true,
  params: { temperature: 0, max_tokens: 4096 },
  fallbacks: [],
  degraded: false,
  reason: null,
};

function context(script: (call: Call) => unknown, ai = true): { ctx: ModuleContext; calls: Call[] } {
  const calls: Call[] = [];
  const ctx: ModuleContext = {
    ai,
    workspace_id: "default",
    actor: ACTOR,
    role: "medical_affairs",
    route,
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
const answerFor = (call: Call) => (call.body.answer_for as string[]) ?? [];

async function rowMeta(id: string) {
  const [row] = await db().select().from(t.timelineActivities).where(eq(t.timelineActivities.id, id));
  return { row: row!, meta: (row!.meta ?? {}) as Record<string, unknown> };
}

describe("KAN-85: dependencies are proposals a person reviews", () => {
  let ids: string[] = [];

  beforeAll(async () => {
    const saved = process.env.SYNAPSE_TEST_STUB_LLM;
    await resetDemo();
    await wipePlatform();
    await ensurePlatformSchema();
    // Date every activity by hand, a year apart, so no estimate is needed.
    const pending = (await timelineModel(ANCHOR)).pending;
    for (const [index, row] of pending.entries()) {
      await addTimelineActivity({
        tactic_id: row.tactic_id,
        expansion_id: row.expansion_id,
        start_date: `${2026 + index}-01-01`,
        end_date: `${2026 + index}-06-01`,
        rationale: "Dated in planning",
        actor: ACTOR,
      });
    }
    ids = (await timelineModel(ANCHOR)).activities.map((row) => row.id);
    expect(ids.length).toBeGreaterThanOrEqual(3);
    process.env.SYNAPSE_TEST_STUB_LLM = saved;
  }, 60_000);

  it("stores a model's dependencies as proposals that gate nothing, and a final save asks for a review", async () => {
    const [a, b, c] = ids as [string, string, string];
    delete process.env.SYNAPSE_TEST_STUB_LLM;
    try {
      const { ctx, calls } = context((call) => ({
        activities: answerFor(call).map((id) => ({
          id,
          depends_on: id === c ? [{ id: a, reason: "reports a's results" }] : id === b ? [{ id: a, reason: "uses a's cohort" }] : [],
        })),
      }));
      const { output } = await timelineModule.run(input(), ctx);
      expect(calls.filter((call) => call.purpose === "timeline-dependencies")).toHaveLength(1);
      const rows = new Map(output.activities.map((row) => [row.id, row]));
      expect(rows.get(c)!.depends_on).toEqual([]);
      expect(rows.get(c)!.meta.proposed_dependencies).toEqual([{ id: a, reason: "reports a's results" }]);
      const stored = await rowMeta(c);
      expect(stored.row.depends_on).toEqual([]);

      const issues = planIssues(await timelineModel(ANCHOR));
      expect(issues.filter((issue) => issue.kind === "proposed_dependency").map((issue) => issue.activity_id).sort()).toEqual(
        [b, c].sort(),
      );
      await expect(savePlan({ status: "final", note: "Sign off", actor: ACTOR })).rejects.toThrow(/proposed dependency .* nobody has reviewed/);
      expect((await savePlan({ status: "draft", note: "Draft with proposals open", actor: ACTOR })).status).toBe("draft");

      // Rebuilding with unchanged inputs does not ask the model again.
      const again = context(() => ({ activities: [] }));
      await timelineModule.run(input(), again.ctx);
      expect(again.calls.filter((call) => call.purpose === "timeline-dependencies")).toHaveLength(0);
      expect((await timelineModel(ANCHOR)).activities.find((row) => row.id === c)!.meta.proposed_dependencies).toHaveLength(1);
    } finally {
      process.env.SYNAPSE_TEST_STUB_LLM = "1";
    }
  });

  it("accepting makes a proposal a dependency; rejecting keeps it off for good", async () => {
    const [a, b, c] = ids as [string, string, string];
    await expect(
      reviewTimelineDependency({ id: c, upstream_id: a, decision: "accept", rationale: "", actor: ACTOR }),
    ).rejects.toThrow(/rationale/i);
    await reviewTimelineDependency({ id: c, upstream_id: a, decision: "accept", rationale: "Yes, the manuscript reports it", actor: ACTOR });
    await reviewTimelineDependency({ id: b, upstream_id: a, decision: "reject", rationale: "Different cohort", actor: ACTOR });
    await expect(
      reviewTimelineDependency({ id: b, upstream_id: a, decision: "reject", rationale: "again", actor: ACTOR }),
    ).rejects.toThrow(/no proposed dependency/i);

    const model = await timelineModel(ANCHOR);
    const rows = new Map(model.activities.map((row) => [row.id, row]));
    expect(rows.get(c)!.depends_on).toEqual([a]);
    expect(rows.get(c)!.meta.depends_locked).toBe(true);
    expect(rows.get(c)!.meta.proposed_dependencies).toEqual([]);
    expect(rows.get(b)!.depends_on).toEqual([]);
    expect(rows.get(b)!.meta.rejected_dependencies).toEqual([a]);
    const edits = await listEdits({ stage: "S10", entity_id: c });
    expect(edits.find((edit) => edit.field === "proposed_dependency")).toMatchObject({ action: "accept" });

    // A model that proposes a rejected dependency again is not listened to.
    const state = (await import("@/lib/iegp/store")).loadState;
    const rebuilt = buildTimeline({
      state: await state(),
      placements: [],
      overrides: (await db().select().from(t.timelineActivities)).map((row) => ({
        id: row.id,
        start_date: row.start_date,
        end_date: row.end_date,
        readout_date: row.readout_date,
        lane: row.lane,
        depends_on: (row.depends_on as string[]) ?? [],
        meta: row.meta as never,
      })),
      dependencies: new Map([[b, { upstream: [{ id: a, reason: "asked again" }] }]]),
      anchor: ANCHOR,
    });
    expect(rebuilt.activities.find((row) => row.id === b)!.meta.proposed_dependencies).toEqual([]);
  });

  it("with AI off, a rebuild never touches dependencies or proposals", async () => {
    const [a, , c] = ids as [string, string, string];
    const before = await rowMeta(c);
    const { ctx, calls } = context(() => ({ activities: [] }), false);
    await timelineModule.run(input(), ctx);
    expect(calls).toHaveLength(0);
    const after = await rowMeta(c);
    expect(after.row.depends_on).toEqual([a]);
    expect(after.meta.dependency_reasons).toEqual(before.meta.dependency_reasons);
  });

  it("reports loops and dependencies on activities off the timeline, and refuses final until fixed", async () => {
    const [a, , c] = ids as [string, string, string];
    // A loop written straight into saved data (an import or an old bug): reported, not ignored.
    const { row, meta } = await rowMeta(a);
    await db()
      .update(t.timelineActivities)
      .set({ depends_on: [c], meta: { ...meta, depends_locked: true } })
      .where(eq(t.timelineActivities.id, row.id));
    const looped = await timelineModel(ANCHOR);
    expect(looped.problems.some((problem) => problem.kind === "cycle")).toBe(true);
    await expect(savePlan({ status: "final", note: "Sign off", actor: ACTOR })).rejects.toThrow(/dependency loop/);
    await setTimelineDependencies({ id: a, depends_on: [], rationale: "Break the loop", actor: ACTOR });

    // A dependency on something not on the timeline.
    await db()
      .update(t.timelineActivities)
      .set({ depends_on: ["ACT-GONE"], meta: { ...meta, depends_locked: true } })
      .where(eq(t.timelineActivities.id, row.id));
    const dangling = await timelineModel(ANCHOR);
    expect(dangling.problems).toEqual([expect.objectContaining({ kind: "dangling", activity_id: a, upstream_id: "ACT-GONE" })]);
    await expect(savePlan({ status: "final", note: "Sign off", actor: ACTOR })).rejects.toThrow(/is not on the timeline/);
    await setTimelineDependencies({ id: a, depends_on: [], rationale: "Drop the stale reference", actor: ACTOR });
  });

  it("marks model estimates until a person accepts them, then saves final with the fingerprint", async () => {
    const [a] = ids as [string];
    const { row, meta } = await rowMeta(a);
    await db()
      .update(t.timelineActivities)
      .set({ meta: { ...meta, schedule_basis: { start: "model", end: "model", readout: null } } })
      .where(eq(t.timelineActivities.id, row.id));
    const estimated = (await timelineModel(ANCHOR)).activities.find((activity) => activity.id === a)!;
    expect(estimatedFields(estimated.meta.schedule_basis)).toEqual(["start", "end"]);
    await expect(savePlan({ status: "final", note: "Sign off", actor: ACTOR })).rejects.toThrow(/model-estimated start, end date nobody has reviewed/);

    // A tactic change after the estimate makes it stale, and the panel says so.
    const { meta: keyed } = await rowMeta(a);
    await db()
      .update(t.timelineActivities)
      .set({ meta: { ...keyed, inputs_key: "[\"old inputs\"]" } })
      .where(eq(t.timelineActivities.id, row.id));
    expect((await timelineModel(ANCHOR)).activities.find((activity) => activity.id === a)!.meta.estimate_stale).toBe(true);

    await expect(acceptTimelineEstimates({ ids: ["ACT-NONE"], rationale: "Nothing to accept here", actor: ACTOR })).rejects.toThrow(/carries a model estimate/);
    const { accepted } = await acceptTimelineEstimates({ ids: [a], rationale: "Checked with the study lead", actor: ACTOR });
    expect(accepted).toEqual([a]);
    const reviewed = (await timelineModel(ANCHOR)).activities.find((activity) => activity.id === a)!;
    expect(reviewed.meta.schedule_basis).toEqual({ start: "human", end: "human", readout: null });
    expect(reviewed.meta.estimate_stale).toBe(false);

    const model = await timelineModel(ANCHOR);
    expect(planIssues(model)).toEqual([]);
    const plan = await savePlan({ status: "final", note: "Signed off after review", actor: ACTOR });
    expect(plan.snapshot.fingerprint).toBe(planFingerprint(model.activities));
    expect(plan.snapshot.fingerprint_code).toBe(fingerprintCode(planFingerprint(model.activities)));
  });

  it("a date a person edits is no longer an estimate", async () => {
    const [, b] = ids as [string, string];
    const { row, meta } = await rowMeta(b);
    await db()
      .update(t.timelineActivities)
      .set({ meta: { ...meta, schedule_basis: { start: "model", end: "model", readout: null } } })
      .where(eq(t.timelineActivities.id, row.id));
    await updateTimelineActivity({ id: b, start_date: "2027-02-01", end_date: "2027-07-01", rationale: "Moved", actor: ACTOR });
    expect((await timelineModel(ANCHOR)).activities.find((activity) => activity.id === b)!.meta.schedule_basis).toMatchObject({
      start: "human",
      end: "human",
    });
  });
});

describe("KAN-85: inclusion, objective and outputs", () => {
  it("classifies completed as historical, proposed as not yet in the plan, and lists cancelled ones", () => {
    expect(inclusionOf("completed")).toBe("completed");
    expect(inclusionOf("proposed")).toBe("proposed");
    expect(inclusionOf("ongoing")).toBe("committed");
    expect(inclusionOf("planned")).toBe("committed");

    const state = buildSeed();
    const mapped = state.tactics.filter((tactic) => state.coverages.some((coverage) => coverage.tactic_id === tactic.id));
    const [done, cancelled, used] = mapped as [typeof mapped[0], typeof mapped[0], typeof mapped[0]];
    done.status = "completed";
    cancelled.status = "cancelled";
    used.intended_use = "HTA dossier section 4";
    const model = buildTimeline({ state, placements: [], anchor: ANCHOR });
    const all = [...model.activities.map((row) => ({ id: row.tactic_id, meta: row.meta })), ...model.pending.map((row) => ({ id: row.tactic_id, meta: row.meta }))];
    expect(all.find((row) => row.id === done.id)!.meta.inclusion).toBe("completed");
    expect(all.some((row) => row.id === cancelled.id)).toBe(false);
    expect(model.cancelled).toEqual(expect.arrayContaining([{ tactic_id: cancelled.id, tactic_name: cancelled.name }]));
    expect(all.find((row) => row.id === used.id)!.meta.outputs).toBe("HTA dossier section 4");
    // Every mapped activity names the objective of the gaps it answers, when there is one.
    const withObjective = all.filter((row) => row.meta.objective);
    expect(withObjective.length).toBeGreaterThan(0);
    const objectiveNames = new Set(state.objectives.map((objective) => objective.name));
    for (const row of withObjective) {
      for (const name of row.meta.objective.split("; ")) expect(objectiveNames.has(name)).toBe(true);
    }
  });
});
