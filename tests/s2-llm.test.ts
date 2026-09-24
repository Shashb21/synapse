import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/iegp/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/iegp/store")>();
  return { ...actual, commitExtractedRecords: vi.fn(actual.commitExtractedRecords) };
});

import "@/modules";
import { runStage } from "@/modules/kernel/run";
import { wipePlatform } from "@/modules/kernel/db";
import type { ModuleContext, ResolvedRoute } from "@/modules/kernel/contracts";
import { NoRouteError } from "@/modules/llm/provider";
import { isLiveGap } from "@/lib/iegp/engine";
import { commitExtractedRecords, createGap, loadState, resetSeed } from "@/lib/iegp/store";
import { listParsedDocuments } from "@/modules/stages/s1-parse/module";
import { gapExtractModule } from "@/modules/stages/s2-gap-extract/module";

/**
 * The model path of S2, with a scripted model in place of a provider: a model
 * proposer that is re-asked for incomplete rows, a model critic whose failure
 * fails the run, and a model judge that decides acceptance and duplicates.
 */

const ACTOR = { name: "S2 LLM Test", function: "medical_affairs" as const };

type Call = { purpose: string; body: Record<string, unknown> | null; system: string };
type Script = (call: Call) => unknown;

function route(connected: boolean): ResolvedRoute {
  return {
    stage: "S2",
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
    complete: async ({ purpose, user, system }) => {
      let body: Record<string, unknown> | null = null;
      try {
        body = JSON.parse(user) as Record<string, unknown>;
      } catch {
        // The first proposal prompt is prose, not JSON.
      }
      const call = { purpose, body, system };
      calls.push(call);
      return script(call);
    },
  };
  return { ctx, calls };
}

const QUOTE_A = "Payers asked for comparative effectiveness data versus standard of care.";
const QUOTE_B = "Clinicians do not know how long patients stay on therapy in routine practice.";

const gapA = {
  name: "Comparative effectiveness vs SoC",
  statement: "How does the asset compare with standard of care on effectiveness?",
  domain: "comparative_effectiveness",
  source_quote: QUOTE_A,
};
const gapB = {
  name: "Real-world persistence",
  statement: "How long do patients persist on therapy in routine practice?",
  domain: "treatment_patterns",
  source_quote: QUOTE_B,
};

const subjectsOf = (call: Call, key: "candidates") =>
  ((call.body?.[key] as { subject?: string; id?: string; decide?: boolean }[]) ?? [])
    .filter((row) => row.decide !== false)
    .map((row) => (row.subject ?? row.id)!);
const keepAll = (call: Call) => ({
  critiques: subjectsOf(call, "candidates").map((subject) => ({
    subject,
    verdict: "keep",
    confidence: 81,
    note: `holds: ${subject}`,
  })),
});

describe("S2 on the model path", () => {
  let documentId = "";
  let planGapId = "";
  let savedStub: string | undefined;
  const L1 = () => `${documentId}-L001`;
  const L2 = () => `${documentId}-L002`;

  beforeAll(async () => {
    await resetSeed();
    await wipePlatform(["source_files", "parsed_documents", "gap_candidates"]);
    const lead = { actor: ACTOR, role: "medical_affairs" as const };
    await runStage({ stage: "S0", input: { demo_ids: ["heor-interview"] }, ...lead });
    await runStage({ stage: "S1", input: {}, ...lead });
    documentId = (await listParsedDocuments())[0]!.id;
    await createGap({
      statement: "No comparative effectiveness data versus standard of care for the payer dossier.",
      domain: "comparative_effectiveness",
      actor_name: ACTOR.name,
      actor_function: ACTOR.function,
    });
    planGapId = (await loadState()).gaps.filter(isLiveGap).at(-1)!.id;
  }, 60_000);

  beforeEach(() => {
    savedStub = process.env.SYNAPSE_TEST_STUB_LLM;
    delete process.env.SYNAPSE_TEST_STUB_LLM;
    vi.mocked(commitExtractedRecords).mockClear();
  });
  afterEach(() => {
    if (savedStub === undefined) delete process.env.SYNAPSE_TEST_STUB_LLM;
    else process.env.SYNAPSE_TEST_STUB_LLM = savedStub;
  });

  const input = (dry_run = true) =>
    gapExtractModule.inputSchema.parse({ document_ids: [documentId], dry_run });

  it("throws before doing anything when no LLM is connected", async () => {
    const { ctx, calls } = context(() => ({}), false);
    await expect(gapExtractModule.run(input(), ctx)).rejects.toBeInstanceOf(NoRouteError);
    await expect(gapExtractModule.run(input(), ctx)).rejects.toThrow(/control/);
    expect(calls).toHaveLength(0);
  });

  it("re-asks for an invalid domain and a missing quote, and commits the judge's duplicate_of", async () => {
    vi.mocked(commitExtractedRecords).mockImplementationOnce(async () => ({
      need_ids: ["NEED-X"],
      gap_ids: ["G-NEW"],
      tactic_ids: [],
    }));
    const { ctx, calls } = context((call) => {
      if (call.purpose.startsWith("gap-proposer:")) {
        return { gaps: [gapA, { ...gapB, domain: "real_world_stuff", source_quote: "" }] };
      }
      if (call.purpose.startsWith("gap-reviser:")) return { gaps: [{ id: L2(), ...gapB }] };
      if (call.purpose === "gap-critic") return keepAll(call);
      return {
        decisions: [
          { subject: L1(), verdict: "accept", confidence: 77, reason: "adds payer provenance", duplicate_of: planGapId },
          { subject: L2(), verdict: "accept", confidence: 66, reason: "new decision question", duplicate_of: null },
        ],
      };
    });

    const { output } = await gapExtractModule.run(input(false), ctx);

    const reviser = calls.filter((call) => call.purpose.startsWith("gap-reviser:"));
    expect(reviser).toHaveLength(1);
    const asked = (reviser[0]!.body!.candidates as { id: string; problems: string[] }[])[0]!;
    expect(asked.id).toBe(L2());
    expect(asked.problems.join(" ")).toMatch(/domain "real_world_stuff"/);
    expect(asked.problems.join(" ")).toMatch(/source_quote is missing/);
    expect(calls.filter((call) => call.purpose === "gap-critic")).toHaveLength(3);

    const judge = calls.filter((call) => call.purpose === "gap-judge");
    expect(judge).toHaveLength(1);
    expect(judge[0]!.body!.plan_gaps).toContainEqual(expect.objectContaining({ id: planGapId }));

    expect(output.mode).toBe("llm");
    const byId = new Map(output.accepted.map((row) => [row.id, row]));
    expect(byId.get(L1())).toMatchObject({ score: 77, duplicate_of: planGapId, source_quote: QUOTE_A });
    expect(byId.get(L2())).toMatchObject({ score: 66, duplicate_of: null, domain: "treatment_patterns", source_quote: QUOTE_B });

    const commit = vi.mocked(commitExtractedRecords).mock.calls[0]![0];
    expect(commit.gaps.map((gap) => [gap.id, gap.duplicate_of])).toEqual([
      [L1(), planGapId],
      [L2(), null],
    ]);
    expect(output.committed_gap_ids).toEqual(["G-NEW"]);
  });

  it("fails the run when the model never supplies a source quote", async () => {
    const { ctx } = context((call) => {
      if (call.purpose.startsWith("gap-proposer:")) return { gaps: [{ ...gapA, source_quote: "" }] };
      if (call.purpose.startsWith("gap-reviser:")) return { gaps: [{ id: L1(), ...gapA, source_quote: "" }] };
      return {};
    });
    await expect(gapExtractModule.run(input(), ctx)).rejects.toThrow(/did not return a complete gap revision/);
  });

  it("rethrows when the model critic fails instead of scoring by rule", async () => {
    const { ctx } = context((call) => {
      if (call.purpose.startsWith("gap-proposer:")) return { gaps: [gapA] };
      if (call.purpose === "gap-critic") throw new Error("critic provider down");
      return {};
    });
    await expect(gapExtractModule.run(input(), ctx)).rejects.toThrow(/critic provider down/);
  });

  it("fails the run when the critic never reviews a candidate", async () => {
    const { ctx } = context((call) => {
      if (call.purpose.startsWith("gap-proposer:")) return { gaps: [gapA, gapB] };
      if (call.purpose === "gap-critic") return { critiques: [{ subject: L1(), verdict: "keep", confidence: 70, note: "ok" }] };
      return {};
    });
    await expect(gapExtractModule.run(input(), ctx)).rejects.toThrow(/did not return a complete review/);
  });

  it("sends objections to the proposer and lets the judge reject a sibling duplicate", async () => {
    let critiques = 0;
    let judged = 0;
    const { ctx, calls } = context((call) => {
      if (call.purpose.startsWith("gap-proposer:")) return { gaps: [gapA, { ...gapA, name: "Same question again" }] };
      if (call.purpose.startsWith("gap-reviser:")) {
        return { gaps: [{ id: L2(), ...gapA, name: "Versus SoC, reworded", statement: "Is the asset more effective than standard of care?" }] };
      }
      if (call.purpose === "gap-critic") {
        critiques += 1;
        return {
          critiques: subjectsOf(call, "candidates").map((subject) => ({
            subject,
            verdict: critiques === 1 && subject === L2() ? "revise" : "keep",
            confidence: 60,
            note: subject === L2() ? `same question as ${L1()}` : "holds",
          })),
        };
      }
      judged += 1;
      // First answer points at a plan gap that does not exist: it must be re-asked.
      const bogus = judged === 1 ? "G-DOES-NOT-EXIST" : null;
      return {
        decisions: [
          { subject: L1(), verdict: "accept", confidence: 90, reason: "the stronger wording", duplicate_of: bogus },
          { subject: L2(), verdict: "reject", confidence: 85, reason: "repeats the first", same_as_candidate: L1() },
        ],
      };
    });

    const { output } = await gapExtractModule.run(input(), ctx);

    const reviser = calls.filter((call) => call.purpose.startsWith("gap-reviser:"));
    expect(reviser).toHaveLength(1);
    const revising = (reviser[0]!.body!.candidates as { id: string; objection: string }[])[0]!;
    expect(revising).toMatchObject({ id: L2(), objection: `revise: same question as ${L1()}` });

    const judge = calls.filter((call) => call.purpose === "gap-judge");
    expect(judge).toHaveLength(2);
    const retry = (judge[1]!.body!.candidates as { subject: string; decide: boolean; problems?: string[] }[]);
    expect(retry.find((row) => row.subject === L1())).toMatchObject({ decide: true });
    expect(retry.find((row) => row.subject === L1())!.problems!.join(" ")).toMatch(/not a plan gap id/);
    expect(retry.find((row) => row.subject === L2())).toMatchObject({ decide: false });

    expect(output.accepted.map((row) => [row.id, row.score, row.duplicate_of])).toEqual([[L1(), 90, null]]);
    expect(output.rejected).toHaveLength(1);
    expect(output.rejected[0]).toMatchObject({ id: L2(), score: 85, statement: "Is the asset more effective than standard of care?" });
    expect(output.rejected[0]!.critic_note).toMatch(/repeats the first/);
  });

  it("keeps no rule-based judgement in the production path", () => {
    const source = readFileSync(
      path.resolve(__dirname, "../src/modules/stages/s2-gap-extract/module.ts"),
      "utf8",
    );
    for (const rule of ["similarRecord", "guessDomain", "gapNameFromStatement", "heuristicCritique", "TACTIC_SHAPED"]) {
      expect(source, rule).not.toContain(rule);
    }
  });
});
