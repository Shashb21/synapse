import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import "@/modules";
import { wipePlatform } from "@/modules/kernel/db";
import type { ModuleContext, ResolvedRoute } from "@/modules/kernel/contracts";
import { NoRouteError } from "@/modules/llm/provider";
import { displayedGapStatus, isLiveGap } from "@/lib/iegp/engine";
import { createGap, loadState, resetSeed } from "@/lib/iegp/store";
import { DEFAULT_AXES, quadrantBand } from "@/modules/stages/s8-prioritization/axes";
import { prioritizationModule } from "@/modules/stages/s8-prioritization/module";

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
    await resetSeed();
    await wipePlatform();
    for (const statement of [
      "No comparative effectiveness data versus standard of care for the payer dossier.",
      "Long-term safety in elderly patients is unknown.",
    ]) {
      await createGap({ statement, actor_name: ACTOR.name, actor_function: ACTOR.function });
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
      expect(row.suggested_band).toBe(quadrantBand({ xAxis: axis(X), yAxis: axis(Y), scores: row.axis_scores }));
    }
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
});
