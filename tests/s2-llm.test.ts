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
import { commitExtractedRecords, createGap, loadState, resetDemoSetup } from "@/lib/iegp/store";
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
    await resetDemoSetup();
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
      merged_gap_ids: [],
      skipped_tactic_ids: [],
      gap_id_by_row: {},
      suggestion_id_by_row: {},
      flagged_gap_ids: [],
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

  it("keeps a reviewed overlap and a committed gap when the judge reverses their classifications", async () => {
    const { rejectGapSuggestion } = await import("@/lib/iegp/store");
    const firstQuote = "The fictional Oriole cohort needs comparative survival data.";
    const reviewQuote = "The fictional Oriole cohort also needs comparative hospitalization data.";
    const newQuote = "The fictional Oriole cohort needs adherence data.";
    const overlap = { match: "overlaps", match_gap_id: planGapId, shared_part: "Comparative data",
      new_part: "Hospitalization", merged_name: "Comparative outcomes", merged_statement: "Compare both outcomes",
      split_name: "Hospitalizations", split_statement: "How often do hospitalizations occur?" };
    const doc = (await listParsedDocuments([documentId]))[0]!;
    const { addSourceBlock, editSourceBlock } = await import("@/lib/iegp/source-blocks");
    const block = await addSourceBlock({ source_id: doc.source_id, text: firstQuote + " " + reviewQuote,
      actor: ACTOR, rationale: "Record both interview questions." });
    const execute = (rerun: boolean) => {
      const {ctx} = context(call => {
        if (call.purpose.startsWith("gap-proposer:")) return {gaps: [
          {...gapA, statement: rerun ? "What data are available on comparative survival?" : "What is the comparative survival?",
            domain: rerun ? "treatment_patterns" : gapA.domain, name: rerun ? "Survival comparison" : "Survival", source_quote: firstQuote},
          {...gapA, statement: rerun ? "What evidence is available on comparative hospitalization?" : "What is comparative hospitalization?",
            domain: rerun ? "treatment_patterns" : gapA.domain, name: rerun ? "Admissions" : "Hospitalization", source_quote: reviewQuote},
          ...(rerun ? [{...gapB, source_quote: newQuote}, {...gapA, statement: "What is comparative hospitalization?", source_quote: reviewQuote}] : []),
        ]};
        if (call.purpose === "gap-critic") return keepAll(call);
        return {decisions: subjectsOf(call, "candidates").map((subject, index) => ({
          subject, verdict: "accept", confidence: 90, reason: "Source evidence",
          ...(index === (rerun ? 0 : 1) ? overlap : { match: "new" }),
        }))};
      });
      ctx.run.id = rerun ? "repeat-gap-run" : "initial-gap-run";
      return gapExtractModule.run(input(false), ctx);
    };
    const first = await execute(false);
    expect(first.output.committed_gap_ids).toHaveLength(1);
    expect(first.output.suggestion_ids).toHaveLength(1);
    await rejectGapSuggestion({suggestion_id: first.output.suggestion_ids[0]!, rationale: "Reviewed by panel",
      actor_name: ACTOR.name, actor_function: ACTOR.function});
    process.env.SYNAPSE_TEST_STUB_LLM = "1";
    try {
      await runStage({ stage: "S1", input: { file_ids: [doc.file_id] }, actor: ACTOR, role: ACTOR.function });
    } finally { delete process.env.SYNAPSE_TEST_STUB_LLM; }
    const current = (await listParsedDocuments()).find(row => row.source_id === doc.source_id)!;
    expect(current.id).not.toBe(documentId);
    await editSourceBlock({ block_id: block.id, text: block.text + " " + newQuote, actor: ACTOR, rationale: "Add the panel's adherence question." });
    const before = await loadState();
    const repeats = await Promise.all([execute(true), execute(true)]);
    const after = await loadState();
    expect(repeats.flatMap(run => run.output.committed_gap_ids)).toHaveLength(1);
    expect(after.gaps.length).toBe(before.gaps.length + 1);
    expect(after.needs.length).toBe(before.needs.length + 1);
    expect(after.gap_suggestions).toEqual(before.gap_suggestions);
    expect(after.needs).toContainEqual(expect.objectContaining({source_quote: newQuote, block_id: block.id, run_id: "repeat-gap-run"}));
    expect(repeats[0]!.output.accepted.every(row => row.document_id === current.id)).toBe(true);
    documentId = current.id;
  });

  it("keeps a fresh overlap pending when all initially ambiguous supporting blocks disappear", async () => {
    const { addSourceBlock, deleteSourceBlock } = await import("@/lib/iegp/source-blocks");
    const { acceptGapMerge, acceptGapSplit } = await import("@/lib/iegp/store");
    const doc = (await listParsedDocuments([documentId]))[0]!;
    const quote = "Both copies describe the Hazel cost study.";
    const blockInput = { source_id: doc.source_id, text: quote, actor: ACTOR, rationale: "Record the passage." };
    const blocks = [await addSourceBlock(blockInput), await addSourceBlock(blockInput)];
    const { ctx } = context(call => {
      if (call.purpose.startsWith("gap-proposer:")) return { gaps: [{...gapA, source_quote: quote}] };
      if (call.purpose === "gap-critic") return keepAll(call);
      return { decisions: subjectsOf(call, "candidates").map(subject => ({ subject, verdict: "accept", confidence: 90,
        reason: "Hazel study", match: "overlaps", match_gap_id: planGapId, shared_part: "Costs", new_part: "Admissions",
        merged_name: "Cost and admissions", merged_statement: "What are the costs and admissions?",
        split_name: "Admissions", split_statement: "What are the admissions?" })) };
    });
    const { output } = await gapExtractModule.run(input(false), ctx);
    const suggestion_id = output.suggestion_ids[0]!;
    expect((await loadState()).gap_suggestions.find(row => row.id === suggestion_id)).toMatchObject({block_id: null});
    for (const block of blocks) await deleteSourceBlock({block_id: block.id, actor: ACTOR, rationale: "Withdraw this duplicate."});
    const before = await loadState();
    for (const decide of [acceptGapMerge, acceptGapSplit]) {
      await expect(decide({suggestion_id, actor_name: ACTOR.name, actor_function: ACTOR.function, rationale: "Review current source."}))
        .rejects.toThrow(/cited passage/);
    }
    expect(await loadState()).toEqual(before);
  });

  it("claims repeated findings within a batch and keeps distinct questions citing the same sentence on rerun", async () => {
    const quote = "The fictional Finch review requests comparative effectiveness and persistence.";
    const run = (includePersistence: boolean) => {
      const { ctx } = context(call => {
        if (call.purpose.startsWith("gap-proposer:")) return { gaps: [
          { ...gapA, source_quote: quote }, { ...gapA, source_quote: quote },
          ...(includePersistence ? [{ ...gapB, source_quote: quote }] : []),
        ] };
        if (call.purpose === "gap-critic") return keepAll(call);
        return { decisions: subjectsOf(call, "candidates").map(subject => ({
          subject, verdict: "accept", match: "new", confidence: 90, reason: "Finch source",
        })) };
      });
      return gapExtractModule.run(input(false), ctx);
    };
    const first = await run(false);
    expect(first.output.committed_gap_ids).toHaveLength(1);
    const { editNeed } = await import("@/lib/iegp/store");
    await editNeed({ need_id: first.output.committed_need_ids[0]!, statement: "The panel refined this question.",
      actor_name: ACTOR.name, actor_function: ACTOR.function, rationale: "Record the reviewed wording." });
    expect((await run(true)).output.committed_gap_ids).toHaveLength(1);
    expect((await run(true)).output.committed_gap_ids).toEqual([]);
  });

  it("follows sibling links through aliases and stops at recorded evidence", async () => {
    const quote = (letter: string) => `Aster finding ${letter}.`;
    const run = (letters: string[], targets: (number | null)[]) => {
      const { ctx } = context(call => {
        if (call.purpose.startsWith("gap-proposer:")) return { gaps: letters.map(letter => ({...gapA, source_quote: quote(letter)})) };
        if (call.purpose === "gap-critic") return keepAll(call);
        const ids = subjectsOf(call, "candidates");
        return { decisions: ids.map((subject, i) => ({ subject, verdict: "accept", confidence: 90, reason: "Aster record",
          ...(targets[i] == null ? { match: "new" } : { match: "same", same_as_candidate: ids[targets[i]!] }) })) };
      });
      return gapExtractModule.run(input(false), ctx);
    };
    const first = await run(["A", "B", "A", "D"], [3, 2, null, null]);
    expect(first.output.committed_gap_ids).toHaveLength(1);
    expect(first.output.committed_need_ids).toHaveLength(3);
    const second = await run(["E", "D", "F"], [1, 2, null]);
    expect(second.output.committed_gap_ids).toHaveLength(1);
    const state = await loadState();
    const corroboration = state.needs.find(row => row.source_quote === quote("E"))!;
    expect(state.need_gap_links).toContainEqual(expect.objectContaining({need_id: corroboration.id, gap_id: first.output.committed_gap_ids[0]}));
  });

  it("corroborates the live rewrite successor when the original still has a historical link", async () => {
    const { db } = await import("@/lib/iegp/db");
    const { sql } = await import("drizzle-orm");
    const { gapResolutionVersion } = await import("@/lib/iegp/relationship-version");
    const { rewritePartialGap } = await import("@/lib/iegp/store");
    const originalQuote = "The fictional Vale assessment requests comparative effectiveness.";
    const newQuote = "The fictional Vale committee confirmed the same comparison is needed.";
    const run = (corroborate: boolean) => {
      const { ctx } = context(call => {
        if (call.purpose.startsWith("gap-proposer:")) return { gaps: [
          { ...gapA, source_quote: originalQuote },
          ...(corroborate ? [{ ...gapA, source_quote: newQuote }] : []),
        ] };
        if (call.purpose === "gap-critic") return keepAll(call);
        const ids = subjectsOf(call, "candidates");
        return { decisions: ids.map((subject, index) => ({
          subject, verdict: "accept", confidence: 90, reason: "Vale evidence",
          ...(index ? { match: "same", same_as_candidate: ids[0] } : { match: "new" }),
        })) };
      });
      return gapExtractModule.run(input(false), ctx);
    };
    const { output: initial } = await run(false);
    const originalId = initial.committed_gap_ids[0]!;
    await db().execute(sql`UPDATE gaps SET status = 'validated_partial', computed_status = 'validated_partial' WHERE id = ${originalId}`);
    const successorId = await rewritePartialGap({
      gap_id: originalId, expected_resolution: gapResolutionVersion(await loadState(), originalId),
      name: "Remaining Vale comparison", status: "validated_open", note: "Keep the unanswered comparison.",
      actor_name: ACTOR.name, actor_function: ACTOR.function,
    });
    const historicalNeedId = initial.committed_need_ids[0]!;
    const rewritten = await loadState();
    expect(rewritten.need_gap_links.filter(link => link.need_id === historicalNeedId).map(link => link.gap_id))
      .toEqual(expect.arrayContaining([originalId, successorId]));

    const { output } = await run(true);
    expect(output.committed_gap_ids).toEqual([]);
    expect(output.joined_gap_ids).toEqual([successorId]);
    expect((await loadState()).need_gap_links).toContainEqual(expect.objectContaining({
      need_id: output.committed_need_ids[0], gap_id: successorId,
    }));
  });

  it("discards a frozen run when a reviewer edits its source during the model call", async () => {
    const { editSourceBlock, listSourceBlocks } = await import("@/lib/iegp/source-blocks");
    const sourceId = (await listParsedDocuments([documentId]))[0]!.source_id;
    const block = (await listSourceBlocks(sourceId))[0]!;
    const { ctx } = context(async call => {
      if (call.purpose.startsWith("gap-proposer:")) return { gaps: [{ ...gapA, source_quote: block.text }] };
      if (call.purpose === "gap-critic") return keepAll(call);
      await editSourceBlock({ block_id: block.id, text: block.text + " Updated during extraction.", actor: ACTOR, rationale: "Correct source wording." });
      return { decisions: subjectsOf(call, "candidates").map(subject => ({
        subject, verdict: "accept", match: "new", confidence: 90, reason: "Source",
      })) };
    });
    const before = await loadState();
    await expect(gapExtractModule.run(input(false), ctx)).rejects.toThrow(/source.*changed/i);
    expect((await loadState()).gaps).toEqual(before.gaps);
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

  it("sends objections to the proposer and keeps a sibling duplicate as a repeat of the one it matches (KAN-74)", async () => {
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
          { subject: L2(), verdict: "accept", confidence: 85, reason: "repeats the first", match: "same", same_as_candidate: L1() },
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

    expect(output.accepted.map((row) => [row.id, row.score, row.duplicate_of])).toEqual([
      [L1(), 90, null],
      [L2(), 85, null],
    ]);
    expect(output.rejected).toHaveLength(0);
    const repeat = output.accepted.find((row) => row.id === L2())!;
    expect(repeat).toMatchObject({ match: "same", same_as_candidate: L1(), statement: "Is the asset more effective than standard of care?" });
    expect(repeat.critic_note).toMatch(/repeats the first/);
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
