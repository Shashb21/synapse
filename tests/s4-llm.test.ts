import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import "@/modules";
import { wipePlatform } from "@/modules/kernel/db";
import type { ModuleContext, ResolvedRoute } from "@/modules/kernel/contracts";
import { NoRouteError } from "@/modules/llm/provider";
import { gapEligibleForMapping, tacticEligibleForMapping } from "@/lib/iegp/engine";
import { COVERAGE_DIMENSIONS } from "@/lib/iegp/enums";
import { buildMappingTableView } from "@/lib/iegp/mapping-table";
import { createGap, loadState, recordMissedTactic, resetSeed } from "@/lib/iegp/store";
import { kgMappingModule } from "@/modules/stages/s4-kg-mapping/module";

/**
 * The model path of S4, with a scripted model in place of a provider: the
 * proposer, critic and judge are all the model, invalid or missing rows are
 * asked for again, and nothing is filled in by rule.
 */

const ACTOR = { name: "LLM Test", function: "medical_affairs" as const };

type Call = { purpose: string; body: Record<string, unknown> };
type Script = (call: Call) => unknown;

function route(connected: boolean): ResolvedRoute {
  return {
    stage: "S4",
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

const dims = Object.fromEntries(COVERAGE_DIMENSIONS.map((dimension) => [dimension, "partial"]));
const gapIdsOf = (call: Call) => (call.body.gaps as { id: string }[]).map((gap) => gap.id);
const rowIdsOf = (call: Call) => (call.body.rows as { gap: { id: string } }[]).map((row) => row.gap.id);
const mapped = (gap_id: string, tactic_id: string, coverage = "partial", rationale = "model reason") => ({
  gap_id,
  mapping_status: coverage === "full" ? "addressed" : "partially_addressed",
  confidence: 70,
  rationale,
  mappings: [{ tactic_id, coverage, confidence: 65, rationale: `${tactic_id} overlaps`, dimensions: dims }],
});
const unmapped = (gap_id: string) => ({ gap_id, mapping_status: "open", confidence: 80, rationale: "nothing bears on it", mappings: [] });
const reviewsFor = (call: Call, verdict: (id: string) => "keep" | "revise" | "drop" = () => "keep") => ({
  reviews: (call.body.rows as { gap: { id: string }; mappings: { tactic_id: string }[] }[]).map((row) => {
    const v = verdict(row.gap.id);
    return {
      gap_id: row.gap.id,
      verdict: v,
      confidence: 75,
      note: `critic on ${row.gap.id}`,
      mappings: row.mappings.map((m) => ({ tactic_id: m.tactic_id, verdict: v, note: `mapping ${m.tactic_id}` })),
    };
  }),
});
const verdictsFor = (call: Call, verdict: (id: string) => "accept" | "reject" = () => "accept") => ({
  verdicts: rowIdsOf(call).map((gap_id) => ({ gap_id, verdict: verdict(gap_id), confidence: 88, reason: `judge on ${gap_id}` })),
});

describe("S4 on the model path", () => {
  let gapIds: string[] = [];
  let tacticIds: string[] = [];
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
    for (const name of ["Comparative effectiveness RWE study", "Elderly safety registry"]) {
      await recordMissedTactic({
        name,
        type: "rwe_study",
        evidence_question: `${name} question`,
        status: "ongoing",
        actor_name: ACTOR.name,
        actor_function: ACTOR.function,
      });
    }
    const state = await loadState();
    gapIds = state.gaps.filter((gap) => gapEligibleForMapping(gap.status) && !gap.retired).map((gap) => gap.id).slice(0, 2);
    tacticIds = state.tactics.filter(tacticEligibleForMapping).map((tactic) => tactic.id).slice(0, 2);
    expect(gapIds).toHaveLength(2);
    expect(tacticIds).toHaveLength(2);
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
    kgMappingModule.inputSchema.parse({ gap_ids: gapIds, tactic_ids: tacticIds, dry_run: true });

  it("throws before doing anything when no LLM is connected", async () => {
    const { ctx, calls } = context(() => ({}), false);
    await expect(kgMappingModule.run(input(), ctx)).rejects.toBeInstanceOf(NoRouteError);
    expect(calls).toHaveLength(0);
  });

  it("takes coverage verdicts from the model, the critic is the model, and the model judge decides", async () => {
    const [a, b] = gapIds as [string, string];
    const [t1, t2] = tacticIds as [string, string];
    let critiques = 0;
    const { ctx, calls } = context((call) => {
      if (call.purpose === "mapping-table-proposer") {
        const ids = gapIdsOf(call);
        if (critiques > 0) return { rows: ids.map((id) => mapped(id, t2, "full", "revised after critic")) };
        return { rows: [mapped(a, t1), unmapped(b)].filter((row) => ids.includes(row.gap_id)) };
      }
      if (call.purpose === "mapping-table-critic") {
        critiques += 1;
        return reviewsFor(call, (id) => (critiques === 1 && id === a ? "revise" : "keep"));
      }
      return verdictsFor(call, (id) => (id === b ? "reject" : "accept"));
    });

    const { output } = await kgMappingModule.run(input(), ctx);

    expect(output.mode).toBe("llm");
    expect(calls.filter((call) => call.purpose === "mapping-table-critic")).toHaveLength(3);
    expect(calls.filter((call) => call.purpose === "mapping-table-judge")).toHaveLength(1);
    const proposer = calls.filter((call) => call.purpose === "mapping-table-proposer");
    expect(proposer).toHaveLength(2);
    expect(gapIdsOf(proposer[1]!)).toEqual([a]);
    const revision = (proposer[1]!.body.gaps as { objection?: string; previous?: unknown }[])[0]!;
    expect(revision.objection).toContain(`critic on ${a}`);
    expect(revision.objection).toContain(`mapping ${t1}`);

    const byId = new Map(output.rows.map((row) => [row.gap_id, row]));
    expect(byId.get(a)).toMatchObject({
      mapping_status: "addressed",
      tactic_ids: [t2],
      rationale: ["revised after critic"],
      verdict: "accept",
      verdict_note: `judge on ${a}`,
      mappings: [{ tactic_id: t2, coverage: "full", confidence: 65, dimensions: dims }],
    });
    expect(byId.get(b)).toMatchObject({ mapping_status: "open", tactic_ids: [], verdict: "reject", confidence: 80 });
    expect(output.accepted.map((row) => row.gap_id)).toEqual([a]);
    // The judge sees that the row changed after the critic's last review.
    const judged = calls.find((call) => call.purpose === "mapping-table-judge")!;
    const judgedA = (judged.body.rows as { gap: { id: string }; revised_after_review: boolean }[]).find((row) => row.gap.id === a)!;
    expect(judgedA.revised_after_review).toBe(false);
  });

  it("re-asks for a row with an invalid status instead of deriving one", async () => {
    const [a, b] = gapIds as [string, string];
    const [t1] = tacticIds as [string, string];
    let first = true;
    const { ctx, calls } = context((call) => {
      if (call.purpose === "mapping-table-critic") return reviewsFor(call);
      if (call.purpose === "mapping-table-judge") return verdictsFor(call);
      if (first) {
        first = false;
        return { rows: [unmapped(a), { ...mapped(b, t1), mapping_status: "mostly_done" }] };
      }
      return { rows: gapIdsOf(call).map((id) => mapped(id, t1, "partial", "second answer")) };
    });

    const { output } = await kgMappingModule.run(input(), ctx);

    const retry = calls.filter((call) => call.purpose === "mapping-table-proposer")[1]!;
    expect(gapIdsOf(retry)).toEqual([b]);
    expect(retry.body.note).toMatch(/complete, valid row/);
    expect(output.rows.find((row) => row.gap_id === b)).toMatchObject({
      mapping_status: "partially_addressed",
      rationale: ["second answer"],
    });
  });

  it("re-asks for a gap the model skipped or left without confidence, and never fills one in", async () => {
    const [a, b] = gapIds as [string, string];
    const [t1] = tacticIds as [string, string];
    let answers = 0;
    const { ctx, calls } = context((call) => {
      if (call.purpose === "mapping-table-critic") return reviewsFor(call);
      if (call.purpose === "mapping-table-judge") return verdictsFor(call);
      answers += 1;
      if (answers === 1) return { rows: [{ ...mapped(a, t1), confidence: undefined }] };
      return { rows: gapIdsOf(call).map((id) => unmapped(id)) };
    });

    const { output } = await kgMappingModule.run(input(), ctx);

    const retry = calls.filter((call) => call.purpose === "mapping-table-proposer")[1]!;
    expect(new Set(gapIdsOf(retry))).toEqual(new Set([a, b]));
    expect(output.rows).toHaveLength(2);
    for (const row of output.rows) expect(row.rationale).toEqual(["nothing bears on it"]);
  });

  it("fails the run when the model never returns a row for a gap", async () => {
    const [a] = gapIds as [string, string];
    const { ctx } = context((call) => {
      if (call.purpose === "mapping-table-critic") return reviewsFor(call);
      if (call.purpose === "mapping-table-judge") return verdictsFor(call);
      return { rows: [unmapped(a)] };
    });
    await expect(kgMappingModule.run(input(), ctx)).rejects.toThrow(/did not return a complete mapping row/);
  });

  it("fails the run when the model critic never reviews a row", async () => {
    const [a] = gapIds as [string, string];
    const { ctx } = context((call) => {
      if (call.purpose === "mapping-table-critic") return { reviews: reviewsFor(call).reviews.filter((r) => r.gap_id === a) };
      if (call.purpose === "mapping-table-judge") return verdictsFor(call);
      return { rows: gapIdsOf(call).map((id) => unmapped(id)) };
    });
    await expect(kgMappingModule.run(input(), ctx)).rejects.toThrow(/did not return a complete review/);
  });

  it("fails the run when the model judge never rules on a row", async () => {
    const [a] = gapIds as [string, string];
    const { ctx } = context((call) => {
      if (call.purpose === "mapping-table-critic") return reviewsFor(call);
      if (call.purpose === "mapping-table-judge") return { verdicts: verdictsFor(call).verdicts.filter((v) => v.gap_id === a) };
      return { rows: gapIdsOf(call).map((id) => unmapped(id)) };
    });
    await expect(kgMappingModule.run(input(), ctx)).rejects.toThrow(/did not return a complete judge verdict/);
  });

  it("concedes rows the model critic drops; they never reach the judge", async () => {
    const [a, b] = gapIds as [string, string];
    const { ctx, calls } = context((call) => {
      if (call.purpose === "mapping-table-critic") return reviewsFor(call, (id) => (id === b ? "drop" : "keep"));
      if (call.purpose === "mapping-table-judge") return verdictsFor(call);
      return { rows: gapIdsOf(call).map((id) => unmapped(id)) };
    });
    const { output } = await kgMappingModule.run(input(), ctx);
    expect(output.rows.map((row) => row.gap_id)).toEqual([a]);
    expect(output.withdrawn).toEqual([{ gap_id: b, note: `critic on ${b}` }]);
    expect(rowIdsOf(calls.find((call) => call.purpose === "mapping-table-judge")!)).toEqual([a]);
  });

  it("tells the model judge when a row changed after the critic's last review", async () => {
    const [a, b] = gapIds as [string, string];
    const [t1] = tacticIds as [string, string];
    let critiques = 0;
    const { ctx, calls } = context((call) => {
      if (call.purpose === "mapping-table-critic") {
        critiques += 1;
        return reviewsFor(call, (id) => (critiques === 3 && id === b ? "revise" : "keep"));
      }
      if (call.purpose === "mapping-table-judge") return verdictsFor(call);
      return { rows: gapIdsOf(call).map((id) => (critiques === 3 ? mapped(id, t1) : unmapped(id))) };
    });
    const { output } = await kgMappingModule.run(input(), ctx);
    const judged = calls.find((call) => call.purpose === "mapping-table-judge")!;
    const flags = new Map(
      (judged.body.rows as { gap: { id: string }; revised_after_review: boolean }[]).map((row) => [row.gap.id, row.revised_after_review]),
    );
    expect(flags.get(a)).toBe(false);
    expect(flags.get(b)).toBe(true);
    expect(output.rows.find((row) => row.gap_id === b)).toMatchObject({ tactic_ids: [t1], mapping_status: "partially_addressed" });
  });

  it("shows a gap S4 has not mapped as not mapped yet, with no invented status or confidence", async () => {
    const state = await loadState();
    const view = buildMappingTableView(state, null);
    expect(view.length).toBeGreaterThan(0);
    for (const row of view) {
      expect(row.source).toBe("workspace");
      expect(row.mapping_status).toBeUndefined();
      expect(row.confidence).toBeUndefined();
    }
  });
  it("stores the model's coverage verdict and dimensions when a run commits", async () => {
    const [a] = gapIds as [string, string];
    const [t1] = tacticIds as [string, string];
    const { ctx } = context((call) => {
      if (call.purpose === "mapping-table-critic") return reviewsFor(call);
      if (call.purpose === "mapping-table-judge") return verdictsFor(call);
      return { rows: gapIdsOf(call).map((id) => (id === a ? mapped(id, t1, "partial") : unmapped(id))) };
    });

    await kgMappingModule.run(
      kgMappingModule.inputSchema.parse({ gap_ids: gapIds, tactic_ids: tacticIds, dry_run: false }),
      ctx,
    );

    const coverage = (await loadState()).coverages.find((row) => row.gap_id === a && row.tactic_id === t1)!;
    expect(coverage.overall).toBe("partial");
    for (const [dimension, value] of Object.entries(dims)) {
      expect(coverage.dimensions[dimension as keyof typeof coverage.dimensions].value).toBe(value);
    }
  });
});
