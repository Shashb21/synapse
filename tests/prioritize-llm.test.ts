import { sources } from "@/lib/iegp/schema";
import { sql } from "drizzle-orm";
import { db } from "@/modules/kernel/db";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import "@/modules";
import { wipePlatform } from "@/modules/kernel/db";
import type { ModuleContext, ResolvedRoute } from "@/modules/kernel/contracts";
import { NoRouteError } from "@/modules/llm/provider";
import { displayedGapStatus, isLiveGap } from "@/lib/iegp/engine";
import { createGap, loadState, resetDemoSetup } from "@/lib/iegp/store";
import { DEFAULT_AXES, quadrantBand } from "@/modules/stages/s8-prioritization/axes";
import { listPlacements, setPlacement, prioritizationModule } from "@/modules/stages/s8-prioritization/module";

/**
 * The model path of S8, with a scripted model in place of a provider: no
 * rule-based scoring anywhere, a model critic, and a hard failure when the
 * model is missing or leaves a gap unscored.
 */

const ACTOR = { name: "LLM Test", function: "medical_affairs" as const };
const axis = (id: string) => DEFAULT_AXES.axes.find((row) => row.id === id)!;
const X = "decision_impact";
const Y = "time_pressure";

type Call = { purpose: string; body: Record<string, unknown> };
type Script = (call: Call) => unknown;

function route(connected: boolean): ResolvedRoute {
  return {
    stage: "S8",
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

const gapIdsOf = (call: Call) => (call.body.gaps as { id: string }[]).map((gap) => gap.id);
const reviewIdsOf = (call: Call) => (call.body.placements as { gap_id: string }[]).map((row) => row.gap_id);
const scored = (ids: string[], scores: Record<string, number>, rationale = "model reason") => ({
  gaps: ids.map((gap_id) => ({ gap_id, scores, rationale })),
});
const reviewed = (ids: string[], verdict: (id: string) => "keep" | "revise" = () => "keep") => ({
  reviews: ids.map((gap_id) => ({ gap_id, verdict: verdict(gap_id), confidence: 80, note: `note on ${gap_id}` })),
});

describe("S8 on the model path", () => {
  let ids: string[] = [];
  let savedStub: string | undefined;

  beforeAll(async () => {
    await resetDemoSetup();
    await wipePlatform();
    await db().insert(sources).values({ id: "kan132-source", filename: "committee.txt", title: "Committee evidence interview", source_type: "stakeholder_interview", stakeholder_function: "medical_affairs", ingested_at: "2026-10-16T00:00:00Z", full_text: "Comparative effectiveness and elderly safety evidence are missing for the committee submission." });
    for (const statement of [
      "No comparative effectiveness data versus standard of care for the payer dossier.",
      "Long-term safety in elderly patients is unknown.",
    ]) {
      await createGap({ statement, source_id: "kan132-source", source_quote: statement, actor_name: ACTOR.name, actor_function: ACTOR.function });
    }
    const state = await loadState();
    ids = state.gaps
      .filter((gap) => isLiveGap(gap) && displayedGapStatus(gap) === "validated_open")
      .map((gap) => gap.id)
      .slice(0, 2);
    expect(ids).toHaveLength(2);
  }, 60_000);

  beforeEach(() => {
    savedStub = process.env.SYNAPSE_TEST_STUB_LLM;
    delete process.env.SYNAPSE_TEST_STUB_LLM;
  });
  afterEach(() => {
    if (savedStub === undefined) delete process.env.SYNAPSE_TEST_STUB_LLM;
    else process.env.SYNAPSE_TEST_STUB_LLM = savedStub;
  });

  const input = () =>
    prioritizationModule.inputSchema.parse({ gap_ids: ids, x_axis: X, y_axis: Y, dry_run: true });

  it("throws before doing anything when no LLM is connected", async () => {
    const { ctx, calls } = context(() => ({}), false);
    await expect(prioritizationModule.run(input(), ctx)).rejects.toBeInstanceOf(NoRouteError);
    await expect(prioritizationModule.run(input(), ctx)).rejects.toThrow(/control/);
    expect(calls).toHaveLength(0);
  });

  it("takes every score from the model and re-scores only what the model critic objects to", async () => {
    const [a, b] = ids as [string, string];
    let critiques = 0;
    const { ctx, calls } = context((call) => {
      if (call.purpose === "priority-suggester") {
        const revising = gapIdsOf(call).every((id) => id === a) && critiques > 0;
        return revising
          ? scored([a], { [X]: 90, [Y]: 85 }, "revised: blocks the payer dossier")
          : scored(gapIdsOf(call), { [X]: 30, [Y]: 70 });
      }
      critiques += 1;
      return reviewed(reviewIdsOf(call), (id) => (critiques === 1 && id === a ? "revise" : "keep"));
    });

    const { output } = await prioritizationModule.run(input(), ctx);

    expect(output.mode).toBe("llm");
    const suggester = calls.filter((call) => call.purpose === "priority-suggester");
    const critic = calls.filter((call) => call.purpose === "priority-critic");
    expect(critic).toHaveLength(3);
    // Round 1 scores both; the one revision only re-scores the gap the critic named.
    expect(suggester).toHaveLength(2);
    expect(new Set(gapIdsOf(suggester[0]!))).toEqual(new Set([a, b]));
    expect(gapIdsOf(suggester[1]!)).toEqual([a]);
    const revision = (suggester[1]!.body.gaps as { objection?: string; previous?: unknown }[])[0]!;
    expect(revision.objection).toBe(`note on ${a}`);
    expect(revision.previous).toMatchObject({ scores: { [X]: 30, [Y]: 70 } });

    const byId = new Map(output.placements.map((row) => [row.gap_id, row]));
    expect(byId.get(a)).toMatchObject({ axis_scores: { [X]: 90, [Y]: 85 }, rationale: "revised: blocks the payer dossier" });
    expect(byId.get(b)).toMatchObject({ axis_scores: { [X]: 30, [Y]: 70 }, rationale: "model reason" });
    for (const row of output.placements) {
      expect(row).toMatchObject({ references: [], support_status: "unsupported" });
      expect(row.suggested_band).toBe(quadrantBand({ xAxis: axis(X), yAxis: axis(Y), scores: row.axis_scores }));
    }
  });

  it("carries only supplied record references and the reasoning they support", async () => {
    const { ctx, calls } = context((call) => {
      if (call.purpose === "priority-critic") return reviewed(reviewIdsOf(call));
      return { gaps: gapIdsOf(call).map((gap_id, index) => ({ gap_id, scores: { [X]: 80, [Y]: 70 },
        rationale: "The evidence need affects the dossier",
        references: [{ entity_type: "gap", entity_id: index === 0 ? gap_id : "invented-gap", reason: "The supplied evidence statement identifies the missing comparison" }],
      })) };
    });
    const { output } = await prioritizationModule.run(input(), ctx);
    const supplied = (calls.find(call => call.purpose === "priority-suggester")!.body.gaps as { references: unknown[] }[])[0]!;
    expect(supplied.references).toEqual(expect.arrayContaining([expect.objectContaining({ entity_type: "gap", entity_id: ids[0] })]));
    expect(output.placements[0]).toMatchObject({ references: [{ entity_type: "gap", entity_id: ids[0], reason: "The supplied evidence statement identifies the missing comparison" }], support_status: "supported" });
    expect(output.placements[1]).toMatchObject({ references: [], support_status: "unsupported" });
  });

  it("asks again for a gap the model left unscored instead of filling it in", async () => {
    const [a, b] = ids as [string, string];
    let first = true;
    const { ctx, calls } = context((call) => {
      if (call.purpose === "priority-critic") return reviewed(reviewIdsOf(call));
      if (first) {
        first = false;
        // b comes back without a Y score, which counts as unscored.
        return { gaps: [{ gap_id: a, scores: { [X]: 60, [Y]: 60 }, rationale: "ok" }, { gap_id: b, scores: { [X]: 60 }, rationale: "half" }] };
      }
      return scored(gapIdsOf(call), { [X]: 20, [Y]: 20 }, "second answer");
    });

    const { output } = await prioritizationModule.run(input(), ctx);

    const retry = calls.filter((call) => call.purpose === "priority-suggester")[1]!;
    expect(gapIdsOf(retry)).toEqual([b]);
    expect(retry.body.note).toMatch(/unscored/);
    expect(output.placements.find((row) => row.gap_id === b)).toMatchObject({
      axis_scores: { [X]: 20, [Y]: 20 },
      rationale: "second answer",
    });
  });

  it("fails the run when the model never scores a gap", async () => {
    const [a] = ids as [string, string];
    const { ctx } = context((call) =>
      call.purpose === "priority-critic" ? reviewed(reviewIdsOf(call)) : scored([a], { [X]: 50, [Y]: 50 }),
    );
    await expect(prioritizationModule.run(input(), ctx)).rejects.toThrow(/did not return a complete score/);
  });

  it("fails the run when the model critic never reviews a gap", async () => {
    const [a] = ids as [string, string];
    const { ctx } = context((call) =>
      call.purpose === "priority-critic" ? reviewed([a]) : scored(gapIdsOf(call), { [X]: 50, [Y]: 50 }),
    );
    await expect(prioritizationModule.run(input(), ctx)).rejects.toThrow(/did not return a complete review/);
  });
  it("retains supplied source context when reserving a gap for replay", async () => {
    const facts = await prioritizationModule.freeze!(input());
    const reserved = await prioritizationModule.evals!.reserveGold!(facts, [ids[0]!]);
    const { ctx } = context(call => {
      if (call.purpose === "priority-critic") return reviewed(reviewIdsOf(call));
      const gaps = call.body.gaps as { id: string; references: { entity_type: string; entity_id: string }[] }[];
      expect(gaps[0]!.references).toEqual(expect.arrayContaining([expect.objectContaining({ entity_type: "source", entity_id: "kan132-source" })]));
      return scored(gaps.map(gap => gap.id), { [X]: 80, [Y]: 75 });
    });
    ctx.replay = { evaluation: true, input: input(), facts: reserved.facts, examples: [], module_id: prioritizationModule.manifest.id, module_version: prioritizationModule.manifest.version, prompt_version: "fixture" };
    const { output } = await prioritizationModule.run({ ...input(), gap_ids: [ids[0]!] }, ctx);
    expect(output.placements).toHaveLength(1);
  });

  it("persists model-authored supplied gap/objective/source support and preserves human values on reruns", async () => {
    const { ctx } = context(call => {
      if (call.purpose === "priority-critic") return reviewed(reviewIdsOf(call));
      return { gaps: (call.body.gaps as { id: string; references: { entity_type: string; entity_id: string }[] }[]).map(gap => ({
        gap_id: gap.id, scores: { [X]: 80, [Y]: 75 }, rationale: "Supplied records explain the evidence need",
        references: gap.references.map(ref => ({ entity_type: ref.entity_type, entity_id: ref.entity_id, reason: "This record describes the evidence need affecting the decision" })),
      })) };
    });
    await prioritizationModule.run({ ...input(), dry_run: false }, ctx);
    const [a, b] = ids as [string, string];
    const saved = (await listPlacements()).find(row => row.gap_id === a)!;
    expect(saved).toMatchObject({ support_status: "supported", suggested_references: expect.arrayContaining([{ entity_type: "gap", entity_id: a, reason: "This record describes the evidence need affecting the decision" }]) });
    expect(saved.suggested_references?.some(ref => ref.entity_type === "objective")).toBe(true);
    expect(saved.suggested_references).toContainEqual({ entity_type: "source", entity_id: "kan132-source", reason: "This record describes the evidence need affecting the decision" });
    const human = await setPlacement({ gap_id: a, actor: ACTOR, band: "low", axis_scores: { [X]: 23, [Y]: 34 }, rationale: "Human assessment must survive reruns", reason: "Reviewed with the planning team", expected_version: saved.version });
    await prioritizationModule.run({ ...input(), dry_run: false }, ctx);
    expect((await listPlacements()).find(row => row.gap_id === a)).toMatchObject({ band: "low", axis_scores: { [X]: 23, [Y]: 34 }, rationale: human.rationale, human_axes: [X, Y], human_band: true });
    // A previously scored gap must not stop only-missing from saving a later gap.
    await db().execute(sql`DELETE FROM priority_placements WHERE gap_id = ${b}`);
    await prioritizationModule.run({ ...input(), dry_run: false, only_missing: true }, ctx);
    expect((await listPlacements()).find(row => row.gap_id === b)?.support_status).toBe("supported");
  });

  it("keeps all prior suggestions if a later placement write fails", async () => {
    const before = await listPlacements();
    const failId = [...ids].sort().at(-1)!;
    await db().execute(sql.raw("CREATE FUNCTION fail_s8_batch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Injected S8 batch failure'; END $$"));
    await db().execute(sql.raw(`CREATE TRIGGER fail_s8_batch BEFORE UPDATE ON priority_placements FOR EACH ROW WHEN (NEW.gap_id = '${failId}') EXECUTE FUNCTION fail_s8_batch()`));
    try {
      const { ctx } = context(call => call.purpose === "priority-critic" ? reviewed(reviewIdsOf(call)) : scored(gapIdsOf(call), { [X]: 12, [Y]: 15 }, "New suggestion must roll back"));
      await expect(prioritizationModule.run({ ...input(), dry_run: false }, ctx)).rejects.toThrow();
      expect(await listPlacements()).toEqual(before);
    } finally {
      await db().execute(sql.raw("DROP TRIGGER fail_s8_batch ON priority_placements"));
      await db().execute(sql.raw("DROP FUNCTION fail_s8_batch()"));
    }
  });

});
