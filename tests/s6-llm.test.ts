import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "@/modules";
import { wipePlatform } from "@/modules/kernel/db";
import type { ModuleContext, ResolvedRoute } from "@/modules/kernel/contracts";
import { NoRouteError } from "@/modules/llm/provider";
import { displayedGapStatus } from "@/lib/iegp/engine";
import {
  createGap,
  createProposedTactic,
  loadState,
  lockTactic,
  resetDemoSetup,
  syncComputedGapStatuses,
} from "@/lib/iegp/store";
import { partialSplitModule } from "@/modules/stages/s6-partial-split/module";

/**
 * The model path of S6, with a scripted model in place of a provider: the model
 * picks the addressed tactics, uncovered dimensions, names and confidence; a
 * model critic and a model judge decide; nothing is drafted or filled in by rule.
 */

const ACTOR = { name: "LLM Test", function: "heor" as const };

type Call = { purpose: string; body: Record<string, unknown> };
type Script = (call: Call) => unknown;

function route(connected: boolean): ResolvedRoute {
  return {
    stage: "S6",
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

const role = (call: Call) => call.purpose.split(":")[0];

async function makePartialGap() {
  await resetDemoSetup();
  await wipePlatform();
  const gapId = await createGap({
    name: "Comparative effectiveness versus regional SoC in elderly patients",
    statement: "Need comparative effectiveness of Velmara versus regional standard of care in elderly patients.",
    domain: "comparative_effectiveness",
    actor_name: ACTOR.name,
    actor_function: ACTOR.function,
  });
  const tacticId = await createProposedTactic({
    name: "Elderly chart review",
    type: "chart_review",
    description: "Chart review in patients aged 65 and over.",
    evidence_question: "What are outcomes of Velmara in elderly patients?",
    population: "Elderly 2L",
    intervention: "Velmara",
    comparator: "To be specified",
    outcomes: "PFS / OS",
    geography: "US + EU5",
    owner: ACTOR.name,
    function: ACTOR.function,
    residual_ids: [],
    gap_id: gapId,
    actor_name: ACTOR.name,
    actor_function: ACTOR.function,
  });
  await lockTactic({ tactic_id: tacticId, status: "planned", actor_name: ACTOR.name, actor_function: ACTOR.function });
  await syncComputedGapStatuses(gapId);
  const gap = (await loadState()).gaps.find((row) => row.id === gapId)!;
  expect(displayedGapStatus(gap)).toBe("validated_partial");
  return { gapId, tacticId };
}

describe("S6 on the model path", () => {
  let gapId = "";
  let tacticId = "";
  let savedStub: string | undefined;

  beforeEach(async () => {
    savedStub = process.env.SYNAPSE_TEST_STUB_LLM;
    delete process.env.SYNAPSE_TEST_STUB_LLM;
    ({ gapId, tacticId } = await makePartialGap());
  }, 60_000);
  afterEach(() => {
    if (savedStub === undefined) delete process.env.SYNAPSE_TEST_STUB_LLM;
    else process.env.SYNAPSE_TEST_STUB_LLM = savedStub;
  });

  const input = () => partialSplitModule.inputSchema.parse({ gap_id: gapId });
  const split = (overrides: Record<string, unknown> = {}) => ({
    addressed_name: "Elderly outcomes on Velmara",
    addressed_statement: "Outcomes of Velmara in patients aged 65 and over, from the elderly chart review.",
    addressed_tactic_ids: [tacticId],
    open_name: "Comparator evidence versus regional SoC",
    open_statement: "No mapped tactic compares Velmara with the regional standard of care.",
    uncovered_dimensions: ["comparator"],
    confidence: 72,
    rationale: "The chart review has no comparator arm.",
    ...overrides,
  });
  const keep = { verdict: "keep", confidence: 80, note: "holds" };
  const accept = { verdict: "accept", confidence: 77, note: "a reviewer can adopt this" };

  it("throws before doing anything when no LLM is connected", async () => {
    const { ctx, calls } = context(() => ({}), false);
    await expect(partialSplitModule.run(input(), ctx)).rejects.toBeInstanceOf(NoRouteError);
    await expect(partialSplitModule.run(input(), ctx)).rejects.toThrow(/control/);
    expect(calls).toHaveLength(0);
  });

  it("takes tactics, dimensions, names and confidence from the model, with no rule draft in the prompt", async () => {
    let critiques = 0;
    const { ctx, calls } = context((call) => {
      if (role(call) === "split-proposer") {
        return call.body.objection
          ? split({ open_name: "Head-to-head versus regional SoC in frail elderly", confidence: 81, rationale: "narrowed" })
          : split();
      }
      if (role(call) === "split-critic") {
        critiques += 1;
        return critiques === 1
          ? { verdict: "revise", confidence: 40, note: "leftover is too broad", issues: ["broad_leftover"] }
          : keep;
      }
      return accept;
    });

    const { output } = await partialSplitModule.run(input(), ctx);

    expect(output.mode).toBe("llm");
    const proposer = calls.filter((call) => role(call) === "split-proposer");
    expect(proposer).toHaveLength(2);
    expect(calls.filter((call) => role(call) === "split-critic")).toHaveLength(3);
    expect(calls.filter((call) => role(call) === "split-judge")).toHaveLength(1);

    // The model gets the facts — gap, needs, mapped tactics with their coverage — and no draft split.
    const first = proposer[0]!.body;
    expect(first).not.toHaveProperty("deterministic_draft");
    expect(first).not.toHaveProperty("uncovered_dimensions");
    expect(first).not.toHaveProperty("previous");
    expect(first.gap).toMatchObject({ id: gapId });
    const tactics = first.mapped_tactics as { id: string; counts_toward_addressing: boolean; coverage: unknown }[];
    expect(tactics.map((row) => row.id)).toEqual([tacticId]);
    expect(tactics[0]!.counts_toward_addressing).toBe(true);
    expect(tactics[0]!.coverage).toBeTruthy();

    // The revision answers the model critic's objection.
    expect(proposer[1]!.body.objection).toBe("leftover is too broad");
    expect(proposer[1]!.body.previous).toMatchObject({ open_name: "Comparator evidence versus regional SoC" });

    expect(output.proposal).toMatchObject({
      parent_gap_id: gapId,
      addressed_name: "Elderly outcomes on Velmara",
      addressed_tactic_ids: [tacticId],
      open_name: "Head-to-head versus regional SoC in frail elderly",
      uncovered_dimensions: ["comparator"],
      confidence: 81,
    });
    expect(output.proposal!.rationale).toEqual(["narrowed", "Judge: a reviewer can adopt this"]);
  });

  it("asks again when the model leaves out confidence or names a tactic that is not mapped", async () => {
    let proposals = 0;
    const { ctx, calls } = context((call) => {
      if (role(call) === "split-proposer") {
        proposals += 1;
        if (proposals === 1) return split({ confidence: undefined });
        if (proposals === 2) return split({ addressed_tactic_ids: ["TAC-NOT-MAPPED"] });
        return split({ confidence: 64 });
      }
      return role(call) === "split-critic" ? keep : accept;
    });

    const { output } = await partialSplitModule.run(input(), ctx);

    const proposer = calls.filter((call) => role(call) === "split-proposer");
    expect(proposer).toHaveLength(3);
    expect(proposer[0]!.body.note).toBeUndefined();
    expect(proposer[1]!.body.note).toMatch(/incomplete/);
    expect(output.proposal).toMatchObject({ confidence: 64, addressed_tactic_ids: [tacticId] });
  });

  it("fails the run when the model never returns a complete proposal", async () => {
    const { ctx } = context((call) =>
      role(call) === "split-proposer" ? split({ uncovered_dimensions: [] }) : role(call) === "split-critic" ? keep : accept,
    );
    await expect(partialSplitModule.run(input(), ctx)).rejects.toThrow(/did not return a complete split proposal/);
  });

  it("fails the run when the model critic never returns a verdict", async () => {
    const { ctx } = context((call) =>
      role(call) === "split-proposer" ? split() : role(call) === "split-critic" ? { note: "no verdict" } : accept,
    );
    await expect(partialSplitModule.run(input(), ctx)).rejects.toThrow(/did not return a complete split review/);
  });

  it("returns no proposal when the model judge rejects the split, instead of falling back to a draft", async () => {
    const { ctx, calls } = context((call) => {
      if (role(call) === "split-proposer") return split();
      if (role(call) === "split-critic") return keep;
      return { verdict: "reject", confidence: 20, note: "the chart review does not close any slice" };
    });

    const result = await partialSplitModule.run(input(), ctx);

    expect(calls.filter((call) => role(call) === "split-judge")).toHaveLength(1);
    expect(result.output.proposal).toBeNull();
    expect(result.output.applied).toBe(false);
    expect(result.summary).toMatch(/rejected/);
    expect(result.summary).toMatch(/the chart review does not close any slice/);
  });

  it("applies a validated split without asking a model", async () => {
    const { ctx, calls } = context(() => ({}), false);
    const { output } = await partialSplitModule.run(
      partialSplitModule.inputSchema.parse({
        gap_id: gapId,
        apply: {
          addressed_name: "Elderly outcomes on Velmara",
          open_name: "Comparator evidence versus regional SoC",
          addressed_tactic_ids: [tacticId],
          rationale: "Chart review covers the elderly; the comparator is still open",
        },
      }),
      ctx,
    );
    expect(calls).toHaveLength(0);
    expect(output).toMatchObject({ applied: true, proposal: null });
    expect(output.edit_id).toBeTruthy();
    const state = await loadState();
    expect(state.gaps.filter((row) => row.parent_gap_id === gapId)).toHaveLength(2);
  });
  it.each(["accept", "edit", "reject"])("captures a real S6 proposal %s through the dialog payload and API", async (decision) => {
    const { POST } = await import("@/app/api/iegp/route");
    const { splitPayload } = await import("@/components/split-gap-dialog");
    const { RunRecorder, openRun, closeRun } = await import("@/modules/kernel/observability");
    const { sharedDb } = await import("@/modules/kernel/db");
    const { sql } = await import("drizzle-orm");
    const recorder = new RunRecorder({ workspace_id: "default", stage: "S6", module_id: partialSplitModule.manifest.id, module_version: partialSplitModule.manifest.version, actor: ACTOR, input: { gap_id: gapId } });
    await openRun(recorder);
    const { ctx } = context((call) => role(call) === "split-proposer" ? split() : role(call) === "split-critic" ? keep : accept);
    ctx.run = recorder;
    const result = await partialSplitModule.run(input(), ctx);
    await closeRun({ recorder, status: "ok", output: result.output, route: ctx.route });
    const proposal = result.output.proposal!;
    const payload = splitPayload({ gapId, addressedName: proposal.addressed_name, addressedStatement: proposal.addressed_statement, openName: proposal.open_name, openStatement: decision === "edit" ? "A narrower unanswered comparison question." : proposal.open_statement, addressedTacticIds: proposal.addressed_tactic_ids, openTacticIds: [], originatingRunId: recorder.id });
    process.env.SYNAPSE_TEST_STUB_LLM = "1"; // API-only anonymous test identity; proposal above used the model path.
    const res = await POST(new Request("http://localhost/api/iegp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...payload, ...(decision === "reject" ? { action: "reject_split_proposal" } : {}), note: "Reviewer decision rationale", actor_name: ACTOR.name, actor_function: ACTOR.function }) }));
    expect(res.status).toBe(200);
    const rows = await sharedDb().execute(sql`select ai_output, final, outcome, run_id, actor, capture_key from decision_examples where run_id = ${recorder.id}`);
    expect(rows).toHaveLength(1);
    expect(rows[0].ai_output).toEqual(proposal);
    expect(rows[0].outcome).toBe(decision === "reject" ? "rejected" : decision === "edit" ? "edited" : "accepted");
    expect(rows[0].run_id).toBe(recorder.id); expect(rows[0].actor).toEqual(ACTOR); expect(rows[0].capture_key).toBeTruthy();
    if (decision === "edit") expect(rows[0].final).toMatchObject({ open_statement: "A narrower unanswered comparison question." });
    const parent = (await loadState()).gaps.find((row) => row.id === gapId)!;
    expect(Boolean(parent.retired)).toBe(decision !== "reject");
  });

  it("refuses an unproven S6 reference before changing the parent", async () => {
    const { POST } = await import("@/app/api/iegp/route");
    process.env.SYNAPSE_TEST_STUB_LLM = "1";
    const res = await POST(new Request("http://localhost/api/iegp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "split_partial_gap", parent_gap_id: gapId, originating_run_id: "missing-run", addressed_name: "Addressed population", open_name: "Unanswered comparison", tactic_ids: tacticId, note: "Reviewer reason", actor_name: ACTOR.name, actor_function: ACTOR.function }) }));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(Boolean((await loadState()).gaps.find((row) => row.id === gapId)!.retired)).toBe(false);
  });

  it("keeps an ordinary manual API split unaffiliated with AI learning", async () => {
    const { POST } = await import("@/app/api/iegp/route");
    const { sharedDb } = await import("@/modules/kernel/db");
    const { sql } = await import("drizzle-orm");
    const before = await sharedDb().execute(sql`select id from decision_examples where workspace_id = 'default' and stage = 'S6' and subject_id = ${gapId}`);
    process.env.SYNAPSE_TEST_STUB_LLM = "1";
    const res = await POST(new Request("http://localhost/api/iegp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "split_partial_gap", parent_gap_id: gapId, addressed_name: "Manual addressed population", open_name: "Manual unanswered question", tactic_ids: tacticId, actor_name: ACTOR.name, actor_function: ACTOR.function }) }));
    expect(res.status).toBe(200);
    expect(await sharedDb().execute(sql`select id from decision_examples where workspace_id = 'default' and stage = 'S6' and subject_id = ${gapId}`)).toEqual(before);
    expect(Boolean((await loadState()).gaps.find(row => row.id === gapId)!.retired)).toBe(true);
  });
  it("rejects mismatched workspace, gap, failed and non-model S6 provenance before mutation", async () => {
    const { POST } = await import("@/app/api/iegp/route");
    const { RunRecorder, openRun, closeRun } = await import("@/modules/kernel/observability");
    const { ctx } = context((call) => role(call) === "split-proposer" ? split() : role(call) === "split-critic" ? keep : accept);
    const result = await partialSplitModule.run(input(), ctx);
    process.env.SYNAPSE_TEST_STUB_LLM = "1";
    for (const mismatch of ["workspace", "gap", "failed", "stub", "stage"]) {
      const recorder = new RunRecorder({ workspace_id: mismatch === "workspace" ? "another-workspace" : "default", stage: mismatch === "stage" ? "S9" : "S6", module_id: partialSplitModule.manifest.id, module_version: partialSplitModule.manifest.version, actor: ACTOR, input: { gap_id: mismatch === "gap" ? "another-gap" : gapId } });
      await openRun(recorder); await closeRun({ recorder, status: mismatch === "failed" ? "error" : "ok", output: { ...result.output, mode: mismatch === "stub" ? "deterministic" : "llm" } });
      const res = await POST(new Request("http://localhost/api/iegp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "split_partial_gap", parent_gap_id: gapId, originating_run_id: recorder.id, addressed_name: "Addressed population", open_name: "Unanswered comparison", tactic_ids: tacticId, note: "Review reason", actor_name: ACTOR.name, actor_function: ACTOR.function }) }));
      expect(res.status, mismatch).toBeGreaterThanOrEqual(400);
      expect(Boolean((await loadState()).gaps.find(row => row.id === gapId)!.retired), mismatch).toBe(false);
    }
  });

});
