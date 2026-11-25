import { suppliedJudgementRecords } from "@/lib/iegp/judgement-references";
import { tacticEditVersion } from "@/lib/iegp/tactic-edit-version";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import "@/modules";
import { wipePlatform } from "@/modules/kernel/db";
import type { ModuleContext, ResolvedRoute } from "@/modules/kernel/contracts";
import { NoRouteError } from "@/modules/llm/provider";
import { emptyDimensions, gapEligibleForMapping, tacticEligibleForMapping, unlocked } from "@/lib/iegp/engine";
import { COVERAGE_DIMENSIONS } from "@/lib/iegp/enums";
import { buildMappingTableView } from "@/lib/iegp/mapping-table";
import { createGap, loadState, recordMissedTactic, resetDemoSetup } from "@/lib/iegp/store";
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

const dims = Object.fromEntries(COVERAGE_DIMENSIONS.map((dimension) => [dimension, "partial"]));
const gapIdsOf = (call: Call) => (call.body.gaps as { id: string }[]).map((gap) => gap.id);
const rowIdsOf = (call: Call) => (call.body.rows as { gap: { id: string } }[]).map((row) => row.gap.id);
const mapped = (gap_id: string, tactic_id: string, coverage = "partial", rationale = "model reason") => ({
  gap_id,
  mapping_status: coverage === "full" ? "addressed" : "partially_addressed",
  confidence: 70,
  rationale,
  mappings: [{ tactic_id, coverage, confidence: 65, rationale: `${tactic_id} overlaps`, dimensions: dims, references: [{ entity_type: "gap", entity_id: gap_id, reason: "The supplied gap states the evidence need this tactic covers" }] }],
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
    await resetDemoSetup();
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

  it("accepts a critic that keeps mappings without a note or names a tactic the row doesn't map (KAN-69)", async () => {
    const [t1, t2] = tacticIds as [string, string];
    const { ctx, calls } = context((call) => {
      if (call.purpose === "mapping-table-critic") {
        const rows = call.body.rows as { gap: { id: string }; mappings: { tactic_id: string }[] }[];
        return {
          reviews: rows.map((row) => ({
            gap_id: row.gap.id,
            verdict: "keep",
            confidence: 80,
            note: "Row is right.",
            mappings: [
              ...row.mappings.map((m) => ({ tactic_id: m.tactic_id, verdict: "keep", note: "" })),
              { tactic_id: t2, verdict: "keep", note: "Added mapping the proposer missed." },
            ],
          })),
        };
      }
      if (call.purpose === "mapping-table-judge") return verdictsFor(call);
      return { rows: gapIdsOf(call).map((id) => mapped(id, t1)) };
    });

    const { output } = await kgMappingModule.run(input(), ctx);

    // One critic call per exchange: nothing was re-asked.
    expect(calls.filter((call) => call.purpose === "mapping-table-critic")).toHaveLength(3);
    expect(output.rows).toHaveLength(2);
  });

  it("still re-asks when the critic objects to a mapping without saying why (KAN-69)", async () => {
    const [t1] = tacticIds as [string, string];
    let first = true;
    const { ctx, calls } = context((call) => {
      if (call.purpose === "mapping-table-critic") {
        if (first) {
          first = false;
          const rows = call.body.rows as { gap: { id: string }; mappings: { tactic_id: string }[] }[];
          return {
            reviews: rows.map((row) => ({
              gap_id: row.gap.id,
              verdict: "revise",
              confidence: 60,
              note: "Coverage looks too high.",
              mappings: row.mappings.map((m) => ({ tactic_id: m.tactic_id, verdict: "revise", note: "" })),
            })),
          };
        }
        return reviewsFor(call);
      }
      if (call.purpose === "mapping-table-judge") return verdictsFor(call);
      return { rows: gapIdsOf(call).map((id) => mapped(id, t1)) };
    });

    await kgMappingModule.run(input(), ctx);

    const critics = calls.filter((call) => call.purpose === "mapping-table-critic");
    expect(critics.length).toBeGreaterThan(3);
    expect(critics[1]!.body.note).toMatch(/note for every revise or drop/);
  });

  it("tells the model why a row was rejected: open with a limited mapping must be partially_addressed (KAN-66)", async () => {
    const [a, b] = gapIds as [string, string];
    const [t1] = tacticIds as [string, string];
    let first = true;
    const { ctx, calls } = context((call) => {
      if (call.purpose === "mapping-table-critic") return reviewsFor(call);
      if (call.purpose === "mapping-table-judge") return verdictsFor(call);
      if (first) {
        first = false;
        return { rows: [unmapped(a), { ...mapped(b, t1, "limited"), mapping_status: "open" }] };
      }
      return { rows: gapIdsOf(call).map((id) => mapped(id, t1, "limited", "second answer")) };
    });

    const { output } = await kgMappingModule.run(input(), ctx);

    const retry = calls.filter((call) => call.purpose === "mapping-table-proposer")[1]!;
    expect(gapIdsOf(retry)).toEqual([b]);
    expect(retry.body.note).toMatch(/rejected_because/);
    const retried = (retry.body.gaps as { id: string; rejected_because?: string }[]).find((gap) => gap.id === b)!;
    expect(retried.rejected_because).toMatch(new RegExp(`"open" but ${t1} is "limited".*partially_addressed`));
    expect(output.rows.find((row) => row.gap_id === b)).toMatchObject({ mapping_status: "partially_addressed" });
  });

  it("states the status rule to the critic, so it never asks for open while a limited mapping stays (KAN-66)", async () => {
    const { ctx, calls } = context((call) => {
      if (call.purpose === "mapping-table-critic") return reviewsFor(call);
      if (call.purpose === "mapping-table-judge") return verdictsFor(call);
      return { rows: gapIdsOf(call).map((id) => unmapped(id)) };
    });
    const systems: string[] = [];
    const complete = ctx.complete;
    ctx.complete = async (args) => {
      systems.push(`${args.purpose}::${args.system}`);
      return complete(args);
    };
    await kgMappingModule.run(input(), ctx);
    const critic = systems.find((entry) => entry.startsWith("mapping-table-critic::"))!;
    const proposer = systems.find((entry) => entry.startsWith("mapping-table-proposer::"))!;
    expect(critic).toMatch(/cannot be "open"/);
    expect(proposer).toMatch(/never "open"/);
    expect(calls.length).toBeGreaterThan(0);
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

  it("retries duplicate rows without re-asking for an accepted gap", async () => {
    const [a, b] = gapIds;
    const { ctx, calls } = context((call) => {
      if (call.purpose === "mapping-table-critic") return reviewsFor(call);
      if (call.purpose === "mapping-table-judge") return verdictsFor(call);
      const ids = gapIdsOf(call);
      return { rows: ids.length > 1 ? [unmapped(a), unmapped(b), unmapped(b)] : ids.map(unmapped) };
    });
    await kgMappingModule.run(input(), ctx);
    const proposes = calls.filter(call => call.purpose === "mapping-table-proposer");
    expect(proposes.map(gapIdsOf)).toEqual([[a, b].sort(), [b]]);
    expect(proposes[1]!.body.gaps).toEqual([expect.objectContaining({ rejected_because: expect.stringMatching(/duplicate/i) })]);
  });

  it("offers every eligible pair in bounded batches on frozen inputs", async () => {
    const state = await loadState();
    const template = state.tactics.find(tacticEligibleForMapping)!;
    const targets = Array.from({ length: 53 }, (_, index) => ({ ...template, id: `TAC-BATCH-${index}` }));
    const { ctx, calls } = context((call) => {
      if (call.purpose === "mapping-table-critic") return reviewsFor(call);
      if (call.purpose === "mapping-table-judge") return verdictsFor(call);
      return { rows: gapIdsOf(call).map(unmapped) };
    });
    const request = kgMappingModule.inputSchema.parse({ gap_ids: gapIds });
    ctx.replay = {
      input: request,
      module_id: kgMappingModule.manifest.id,
      module_version: kgMappingModule.manifest.version,
      prompt_version: "base",
      facts: { state: { ...state, tactics: targets, expansions: [] } },
      evaluation: true,
    };
    const { output } = await kgMappingModule.run(request, ctx);
    const offers = calls.filter(call => call.purpose === "mapping-table-proposer");
    expect(offers.length).toBeGreaterThan(1);
    const pairs = offers.flatMap(call => {
      const tactics = call.body.tactics as { id: string }[];
      expect(tactics.length * gapIdsOf(call).length).toBeLessThanOrEqual(24);
      return gapIdsOf(call).flatMap(gap => tactics.map(tactic => `${gap}::${tactic.id}`));
    });
    expect(pairs.sort()).toEqual(gapIds.flatMap(gap => targets.map(tactic => `${gap}::${tactic.id}`)).sort());
    expect(output.rows.map(row => row.gap_id)).toEqual(gapIds);
  });

  it("uses identical request batches and retains the same tied mappings when frozen input order changes", async () => {
    const [gapId, siblingId] = gapIds;
    const state = await loadState();
    const template = state.tactics.find(tacticEligibleForMapping)!;
    const targets = Array.from({ length: 25 }, (_, index) => ({
      ...template,
      id: `TAC-TIED-${String(index).padStart(2, "0")}`,
    }));
    const [first, second] = [targets[0]!, targets[24]!];
    const request = kgMappingModule.inputSchema.parse({ gap_ids: [gapId, siblingId], max_per_gap: 1, dry_run: true });

    const forward = { ...state, gaps: [...state.gaps], tactics: [...targets], expansions: [] };
    const reverse = { ...forward, gaps: [...forward.gaps].reverse(), tactics: [...targets].reverse() };
    const runs = [];
    for (const facts of [forward, reverse]) {
      const { ctx, calls } = context(call => {
        if (call.purpose === "mapping-table-critic") return reviewsFor(call);
        if (call.purpose === "mapping-table-judge") return verdictsFor(call);
        const offered = (call.body.tactics as { id: string }[]).map(tactic => tactic.id);
        const tactic = [first, second].find(target => offered.includes(target.id))!;
        return { rows: gapIdsOf(call).map(id => id === gapId ? mapped(id, tactic.id) : unmapped(id)) };
      });
      ctx.replay = {
        input: request,
        module_id: kgMappingModule.manifest.id,
        module_version: kgMappingModule.manifest.version,
        prompt_version: "base",
        facts: { state: facts },
        evaluation: true,
      };
      const { output } = await kgMappingModule.run(request, ctx);
      runs.push(calls);
      expect(output.accepted.map(row => row.gap_id)).toEqual(
        facts.gaps.filter(gap => request.gap_ids!.includes(gap.id)).map(gap => gap.id),
      );
    }

    expect(runs[1]).toEqual(runs[0]);
    for (const calls of runs) {
      const judged = calls.filter(call => call.purpose === "mapping-table-judge");
      const judgedFragments = judged.flatMap(call => (
        call.body.rows as { gap: { id: string }; mapping_status: string; mappings: { tactic_id: string }[] }[]
      ).filter(row => row.gap.id === gapId));
      expect(judgedFragments.map(row => ({
        status: row.mapping_status,
        mappings: row.mappings.map(mapping => mapping.tactic_id),
      }))).toEqual([
        { status: "partially_addressed", mappings: [first.id] },
        { status: "open", mappings: [] },
      ]);
    }
  });

  it.each([
    { label: "complementary partials", secondOutcome: "endpoints match", status: "addressed" },
    { label: "overlapping partials", secondOutcome: "endpoints missing", status: "partially_addressed" },
  ])("judges combined coverage for $label retained from different tactic batches", async ({ secondOutcome, status }) => {
    const [gapId] = gapIds;
    const state = await loadState();
    const template = state.tactics.find(tacticEligibleForMapping)!;
    const first = { ...template, id: "TAC-CROSS-00", population: "target population", outcomes: "endpoints missing" };
    const second = { ...template, id: "TAC-CROSS-24", population: "compatible cohort", outcomes: secondOutcome };
    const stale = { ...template, id: "TAC-CROSS-25" };
    const fillers = Array.from({ length: 23 }, (_, index) => ({ ...template, id: `TAC-CROSS-${String(index + 1).padStart(2, "0")}` }));
    const request = kgMappingModule.inputSchema.parse({ gap_ids: [gapId], dry_run: true });
    let combinedAttempts = 0;
    const combinedRationale = status === "addressed" ? "Together the two selected designs cover the population and endpoints." : "Both selected designs omit the gap's required endpoints.";
    const { ctx, calls } = context(call => {
      if (call.purpose === "mapping-table-critic") return reviewsFor(call);
      if (call.purpose === "mapping-table-judge") return verdictsFor(call);
      if (call.purpose === "mapping-table-combined-coverage") {
        combinedAttempts++;
        const offered = call.body.tactics as { id: string; outcomes: string }[];
        const evaluatedStatus = offered.some(target => target.outcomes === "endpoints match") ? "addressed" : "partially_addressed";
        return { rows: [{
          gap_id: gapId,
          mapping_status: combinedAttempts === 1 ? "open" : evaluatedStatus,
          confidence: 84,
          rationale: combinedRationale,
        }] };
      }
      const offered = (call.body.tactics as { id: string }[]).map(tactic => tactic.id);
      const ordinary = [first, second].find(target => offered.includes(target.id))!;
      const fragment = mapped(gapId, ordinary.id);
      if (offered.includes(stale.id)) fragment.mappings.push(mapped(gapId, stale.id, "full").mappings[0]!);
      return { rows: [fragment] };
    });
    ctx.replay = {
      input: request,
      module_id: kgMappingModule.manifest.id,
      module_version: kgMappingModule.manifest.version,
      prompt_version: "base",
      facts: { state: {
        ...state,
        tactics: [first, ...fillers, second, stale],
        expansions: [],
        coverages: [{
          id: "COV-STALE",
          gap_id: gapId,
          tactic_id: stale.id,
          dimensions: emptyDimensions(),
          overall: "limited",
          overall_rationale: "Previous assessment",
          overall_lock: unlocked(),
          stale: true,
          needs_review: false,
        }],
      } },
      evaluation: true,
    };

    const { output } = await kgMappingModule.run(request, ctx);

    expect(output.accepted[0]).toMatchObject({
      mapping_status: status,
      confidence: 84,
      rationale: [combinedRationale, "model reason", "model reason"],
      tactic_ids: [first.id, second.id],
      mappings: expect.arrayContaining([expect.objectContaining({ tactic_id: stale.id, review_only: true })]),
    });
    const combined = calls.filter(call => call.purpose === "mapping-table-combined-coverage");
    expect(combined).toHaveLength(2);
    expect(combined[1].body).toMatchObject({
      gap: { id: gapId },
      tactics: [{ id: first.id }, { id: second.id }],
      mappings: [{ tactic_id: first.id }, { tactic_id: second.id }],
      rejected_because: expect.stringContaining("partially_addressed"),
    });
    const judged = calls.filter(call => call.purpose === "mapping-table-judge" && call.body.combined_coverage);
    expect(judged).toHaveLength(1);
    expect(judged[0].body).toMatchObject({
      tactics: [{ id: first.id }, { id: second.id }],
      rows: [{ gap: { id: gapId }, mapping_status: status, mappings: [{ tactic_id: first.id }, { tactic_id: second.id }] }],
    });
    const fragmentReviews = calls.filter(call => call.body.partial_row &&
      (call.purpose === "mapping-table-critic" || call.purpose === "mapping-table-judge"));
    expect(new Set(fragmentReviews.map(call => call.purpose))).toEqual(new Set(["mapping-table-critic", "mapping-table-judge"]));
    for (const call of fragmentReviews) {
      expect(call.body.rows).toEqual([expect.objectContaining({ mapping_status: "partially_addressed" })]);
    }
  });

  it.each(["absent", "same batch", "separate batch"] as const)(
    "preserves complementary ordinary coverage when a stale assessment is %s",
    async placement => {
      const [gapId] = gapIds;
      const state = await loadState();
      const template = state.tactics.find(tacticEligibleForMapping)!;
      const first = { ...template, id: "TAC-POPULATION" };
      const second = { ...template, id: "TAC-OUTCOMES" };
      const stale = { ...template, id: "TAC-STALE" };
      const fillers = Array.from({ length: placement === "separate batch" ? 22 : 0 },
        (_, index) => ({ ...template, id: `TAC-FILLER-${index}` }));
      const targets = [first, second, ...fillers, ...(placement === "absent" ? [] : [stale])];
      const coverages = placement === "absent" ? [] : [{
        id: "COV-STALE",
        gap_id: gapId,
        tactic_id: stale.id,
        dimensions: emptyDimensions(),
        overall: "limited" as const,
        overall_rationale: "Previous assessment",
        overall_lock: unlocked(),
        stale: true,
        needs_review: false,
      }];
      const request = kgMappingModule.inputSchema.parse({ gap_ids: [gapId], dry_run: true });
      const { ctx, calls } = context(call => {
        if (call.purpose === "mapping-table-critic") return reviewsFor(call);
        if (call.purpose === "mapping-table-judge") return verdictsFor(call);
        const offered = (call.body.tactics as { id: string }[]).map(tactic => tactic.id);
        const ordinary = [first, second].filter(tactic => offered.includes(tactic.id));
        const mappings = ordinary.map(tactic => ({
          ...mapped(gapId, tactic.id).mappings[0]!,
          rationale: tactic.id === first.id ? "Covers the target population" : "Covers the missing outcomes",
        }));
        if (offered.includes(stale.id)) mappings.push(mapped(gapId, stale.id, "full").mappings[0]!);
        return { rows: [{
          ...unmapped(gapId),
          mapping_status: ordinary.length ? "addressed" : "open",
          rationale: ordinary.length ? "The two ordinary studies cover complementary requirements." : "Only the stale relationship was reassessed.",
          mappings,
        }] };
      });
      ctx.replay = {
        input: request,
        module_id: kgMappingModule.manifest.id,
        module_version: kgMappingModule.manifest.version,
        prompt_version: "base",
        facts: { state: { ...state, tactics: targets, expansions: [], coverages } },
        evaluation: true,
      };

      const { output } = await kgMappingModule.run(request, ctx);

      const proposals = calls.filter(call => call.purpose === "mapping-table-proposer");
      expect(proposals).toHaveLength(placement === "separate batch" ? 2 : 1);
      expect(output.accepted[0]).toMatchObject({ mapping_status: "addressed", tactic_ids: [first.id, second.id] });
      expect(output.accepted[0]!.mappings.filter(mapping => mapping.review_only).map(mapping => mapping.tactic_id))
        .toEqual(placement === "absent" ? [] : [stale.id]);
      if (placement === "separate batch") {
        const staleReviews = calls.filter(call =>
          (call.purpose === "mapping-table-critic" || call.purpose === "mapping-table-judge") &&
          (call.body.tactics as { id: string }[]).some(tactic => tactic.id === stale.id));
        expect(new Set(staleReviews.map(call => call.purpose))).toEqual(new Set(["mapping-table-critic", "mapping-table-judge"]));
        for (const call of staleReviews) {
          expect(call.body.rows).toEqual([expect.objectContaining({
            mapping_status: "open",
            mappings: [expect.objectContaining({ tactic_id: stale.id, coverage: "full", review_only: true })],
          })]);
        }
      }
    },
  );

  it.each([
    { label: "one partial mapping", ordinaryCoverages: ["partial"] },
    { label: "only limited mappings", ordinaryCoverages: ["limited", "limited"] },
  ])("retries addressed when a stale full assessment accompanies $label", async ({ ordinaryCoverages }) => {
    const [gapId, siblingId] = gapIds;
    const state = await loadState();
    const template = state.tactics.find(tacticEligibleForMapping)!;
    const ordinary = ordinaryCoverages.map((coverage, index) => ({
      tactic: { ...template, id: `TAC-ORDINARY-${index}` },
      coverage,
    }));
    const stale = { ...template, id: "TAC-STALE" };
    const request = kgMappingModule.inputSchema.parse({ gap_ids: [gapId, siblingId], dry_run: true });
    const { ctx, calls } = context(call => {
      if (call.purpose === "mapping-table-critic") return reviewsFor(call);
      if (call.purpose === "mapping-table-judge") return verdictsFor(call);
      const repair = Boolean(call.body.note);
      return { rows: gapIdsOf(call).map(id => id === siblingId ? unmapped(id) : {
        ...unmapped(gapId),
        mapping_status: repair ? "partially_addressed" : "addressed",
        rationale: repair ? "The ordinary mappings cover part of the gap." : "The stale assessment completes coverage.",
        mappings: [
          ...ordinary.map(({ tactic, coverage }) => mapped(gapId, tactic.id, coverage).mappings[0]!),
          mapped(gapId, stale.id, "full").mappings[0]!,
        ],
      }) };
    });
    ctx.replay = {
      input: request,
      module_id: kgMappingModule.manifest.id,
      module_version: kgMappingModule.manifest.version,
      prompt_version: "base",
      facts: { state: {
        ...state,
        tactics: [...ordinary.map(({ tactic }) => tactic), stale],
        expansions: [],
        coverages: [{
          id: "COV-STALE",
          gap_id: gapId,
          tactic_id: stale.id,
          dimensions: emptyDimensions(),
          overall: "limited",
          overall_rationale: "Previous assessment",
          overall_lock: unlocked(),
          stale: true,
          needs_review: false,
        }],
      } },
      evaluation: true,
    };

    const { output } = await kgMappingModule.run(request, ctx);

    const proposals = calls.filter(call => call.purpose === "mapping-table-proposer");
    expect(proposals.map(gapIdsOf)).toEqual([[gapId, siblingId].sort(), [gapId]]);
    expect(proposals[1]!.body.gaps).toEqual([expect.objectContaining({
      rejected_because: expect.stringMatching(/ordinary.*stale.*partially_addressed/i),
    })]);
    expect(output.accepted.find(row => row.gap_id === gapId)).toMatchObject({
      mapping_status: "partially_addressed",
      tactic_ids: ordinary.map(({ tactic }) => tactic.id),
      mappings: expect.arrayContaining([expect.objectContaining({ tactic_id: stale.id, coverage: "full", review_only: true })]),
    });
    expect(output.accepted.find(row => row.gap_id === siblingId)).toMatchObject({ mapping_status: "open" });
  });

  it("bounds critic and judge calls even when all offered tactics get explicit verdicts", async () => {
    const [gapId] = gapIds;
    const state = await loadState();
    const template = state.tactics.find(tacticEligibleForMapping)!;
    const targets = Array.from({ length: 25 }, (_, index) => ({ ...template, id: `TAC-REVIEW-${String(index).padStart(2, "0")}` }));
    const request = kgMappingModule.inputSchema.parse({ gap_ids: [gapId] });
    const { ctx, calls } = context(call => {
      if (call.purpose === "mapping-table-critic") return reviewsFor(call);
      if (call.purpose === "mapping-table-judge") return verdictsFor(call, () =>
        (call.body.tactics as { id: string }[]).some(tactic => tactic.id === targets.at(-1)!.id) ? "reject" : "accept");
      const tactics = call.body.tactics as { id: string }[];
      return { rows: [{
        ...unmapped(gapId),
        mappings: tactics.map(tactic => ({ ...mapped(gapId, tactic.id).mappings[0], coverage: "not_relevant", dimensions: null, references: [] })),
      }] };
    });
    ctx.replay = {
      input: request,
      module_id: kgMappingModule.manifest.id,
      module_version: kgMappingModule.manifest.version,
      prompt_version: "base",
      facts: { state: { ...state, tactics: targets, expansions: [] } },
      evaluation: true,
    };

    const { output } = await kgMappingModule.run(request, ctx);

    const reviews = calls.filter(call => call.purpose !== "mapping-table-proposer");
    for (const review of reviews) {
      expect((review.body.tactics as unknown[]).length).toBeLessThanOrEqual(24);
      const [row] = review.body.rows as { mappings: unknown[] }[];
      expect(row.mappings.length).toBeLessThanOrEqual(24);
    }
    expect(output.rejected[0].mappings.map(mapping => mapping.tactic_id)).toEqual(targets.map(tactic => tactic.id));
  });

  it("retries a wrong-batch tactic only in the slice where it was returned", async () => {
    const [gapId] = gapIds;
    const state = await loadState();
    const template = state.tactics.find(tacticEligibleForMapping)!;
    const targets = Array.from({ length: 25 }, (_, index) => ({ ...template, id: `TAC-SLICE-${String(index).padStart(2, "0")}` }));
    const request = kgMappingModule.inputSchema.parse({ gap_ids: [gapId] });
    let attemptsOnLastSlice = 0;
    const { ctx, calls } = context(call => {
      if (call.purpose === "mapping-table-critic") return reviewsFor(call);
      if (call.purpose === "mapping-table-judge") return verdictsFor(call);
      const tactics = call.body.tactics as { id: string }[];
      if (tactics.length > 1) return { rows: [mapped(gapId, tactics[0].id)] };
      attemptsOnLastSlice++;
      return { rows: [mapped(gapId, attemptsOnLastSlice === 1 ? targets[0].id : tactics[0].id)] };
    });
    ctx.replay = {
      input: request,
      module_id: kgMappingModule.manifest.id,
      module_version: kgMappingModule.manifest.version,
      prompt_version: "base",
      facts: { state: { ...state, tactics: targets, expansions: [] } },
      evaluation: true,
    };

    const { output } = await kgMappingModule.run(request, ctx);

    const offers = calls.filter(call => call.purpose === "mapping-table-proposer");
    expect(offers.map(call => (call.body.tactics as { id: string }[]).map(tactic => tactic.id))).toEqual([
      targets.slice(0, 24).map(tactic => tactic.id), [targets[24].id], [targets[24].id],
    ]);
    expect(offers[2].body.gaps).toEqual([expect.objectContaining({
      id: gapId, rejected_because: expect.stringContaining(targets[0].id),
    })]);
    expect(output.accepted[0].tactic_ids).toEqual([targets[0].id, targets[24].id]);
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

    const original = await loadState();
    const { output } = await kgMappingModule.run(
      kgMappingModule.inputSchema.parse({ gap_ids: gapIds, tactic_ids: tacticIds, dry_run: false }),
      ctx,
    );

    const mapping = output.rows.find(row => row.gap_id === a)!.mappings[0];
    expect(mapping.supplied_records).toEqual(suppliedJudgementRecords(original, [a]));
    expect(mapping.expected_tactic_version).toBe(tacticEditVersion(original.tactics.find(row => row.id === t1)!));
    const coverage = (await loadState()).coverages.find((row) => row.gap_id === a && row.tactic_id === t1)!;
    expect(coverage.overall).toBe("partial");
    for (const [dimension, value] of Object.entries(dims)) {
      expect(coverage.dimensions[dimension as keyof typeof coverage.dimensions].value).toBe(value);
    }
  });
  it.each(["missing", "inaccessible"])("does not commit a model relationship with %s support", async support => {
    const id = await createGap({ statement: "Comparative outcomes needed for the committee", actor_name: ACTOR.name, actor_function: ACTOR.function });
    const tacticId = tacticIds[0];
    const { ctx, calls } = context(call => {
      if (call.purpose === "mapping-table-critic") return reviewsFor(call);
      if (call.purpose === "mapping-table-judge") return verdictsFor(call);
      const row = mapped(id, tacticId);
      row.mappings[0].references = support === "missing" ? [] : [{ entity_type: "gap", entity_id: "not-a-supplied-gap", reason: "Claiming unrelated evidence" }];
      return { rows: [row] };
    });
    await expect(kgMappingModule.run(kgMappingModule.inputSchema.parse({ gap_ids: [id], tactic_ids: [tacticId] }), ctx)).rejects.toThrow(/supporting references/i);
    expect((await loadState()).coverages.some(row => row.gap_id === id)).toBe(false);
    expect(calls.find(call => call.purpose === "mapping-table-proposer")!.body.supporting_records).toEqual(expect.arrayContaining([expect.objectContaining({ entity_type: "gap", entity_id: id, excerpt: "Comparative outcomes needed for the committee" })]));
  });

});
