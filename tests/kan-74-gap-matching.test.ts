import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import "@/modules";
import { runStage } from "@/modules/kernel/run";
import { wipePlatform } from "@/modules/kernel/db";
import type { ModuleContext, ResolvedRoute } from "@/modules/kernel/contracts";
import { isLiveGap } from "@/lib/iegp/engine";
import { commitExtractedRecords, createGap, loadState, resetDemoSetup, validateGap } from "@/lib/iegp/store";
import { listParsedDocuments } from "@/modules/stages/s1-parse/module";
import { gapExtractModule, parseJudgeDecision } from "@/modules/stages/s2-gap-extract/module";

/**
 * KAN-74: every accepted gap candidate is matched against the plan. "same" joins
 * its gap as a supporting need (and flags a gap a person already validated),
 * "overlaps" becomes a suggestion for a person, "new" becomes a gap, and a
 * candidate that repeats another candidate in the same run follows it, so no
 * source is ever dropped.
 */

const ACTOR = { name: "KAN-74 Test", function: "medical_affairs" as const };

const OVERLAP = {
  shared_part: "Comparative effectiveness versus standard of care is unknown.",
  new_part: "Nothing is known for patients over 75.",
  merged_name: "Comparative effectiveness incl. over-75s",
  merged_statement: "How does the asset compare with standard of care, including in patients over 75?",
  split_name: "Effectiveness in patients over 75",
  split_statement: "How effective is the asset in patients over 75?",
};

describe("KAN-74 judge decisions", () => {
  const scope = {
    subject: "C1",
    candidateIds: new Set(["C1", "C2"]),
    planIds: new Set(["GAP-001", "GAP-009"]),
    setAsideIds: new Set(["GAP-009"]),
  };
  const base = { subject: "C1", verdict: "accept", confidence: 80, reason: "sound" };

  it("reads same, overlaps and new, and the pre-KAN-74 duplicate_of as same", () => {
    expect(parseJudgeDecision({ ...base, match: "same", match_gap_id: "GAP-001" }, scope).decision).toMatchObject({
      match: "same",
      match_gap_id: "GAP-001",
    });
    expect(parseJudgeDecision({ ...base, duplicate_of: "GAP-001" }, scope).decision).toMatchObject({
      match: "same",
      match_gap_id: "GAP-001",
    });
    expect(parseJudgeDecision({ ...base, match: "same", same_as_candidate: "C2" }, scope).decision).toMatchObject({
      match: "same",
      same_as_candidate: "C2",
      match_gap_id: null,
    });
    expect(parseJudgeDecision({ ...base, match: "new" }, scope).decision).toMatchObject({ match: "new", overlap: null });
    expect(
      parseJudgeDecision({ ...base, match: "overlaps", match_gap_id: "GAP-001", ...OVERLAP }, scope).decision,
    ).toMatchObject({ match: "overlaps", match_gap_id: "GAP-001", overlap: OVERLAP });
  });

  it("names each problem so the judge can be asked again", () => {
    const problems = (row: Record<string, unknown>) => parseJudgeDecision({ ...base, ...row }, scope).problems ?? [];
    expect(problems({ match: "overlaps", match_gap_id: "GAP-001", shared_part: "x" }).join(" ")).toMatch(
      /needs new_part, merged_name, merged_statement, split_name, split_statement/,
    );
    expect(problems({ match: "overlaps", match_gap_id: "GAP-009", ...OVERLAP }).join(" ")).toMatch(/set aside/);
    expect(problems({ match: "overlaps", ...OVERLAP }).join(" ")).toMatch(/needs match_gap_id/);
    expect(problems({ match: "same" }).join(" ")).toMatch(/needs match_gap_id .* or same_as_candidate/);
    expect(problems({ match: "same", match_gap_id: "GAP-001", same_as_candidate: "C2" }).join(" ")).toMatch(/not both/);
    expect(problems({ match: "new", match_gap_id: "GAP-001" }).join(" ")).toMatch(/takes no match_gap_id/);
    expect(problems({ match: "same", match_gap_id: "GAP-404" }).join(" ")).toMatch(/not a plan gap id/);
    expect(problems({ match: "maybe" }).join(" ")).toMatch(/must be "same", "overlaps" or "new"/);
    // A repeat of another candidate is kept, not thrown away.
    expect(problems({ verdict: "reject", same_as_candidate: "C2" }).join(" ")).toMatch(/accepted with match "same"/);
  });

  it("lets a genuinely bad candidate be rejected without match fields", () => {
    expect(parseJudgeDecision({ ...base, verdict: "reject", reason: "a tactic" }, scope).decision).toMatchObject({
      verdict: "reject",
      match: "new",
    });
  });
});

describe("KAN-74 commit", () => {
  let sourceId = "";
  let gapId = "";

  beforeAll(async () => {
    await resetDemoSetup();
    await wipePlatform(["source_files", "parsed_documents", "gap_candidates"]);
    await runStage({ stage: "S0", input: { demo_ids: ["heor-interview"] }, actor: ACTOR, role: "medical_affairs" });
    await runStage({ stage: "S1", input: {}, actor: ACTOR, role: "medical_affairs" });
    sourceId = (await listParsedDocuments())[0]!.source_id;
    gapId = await createGap({
      statement: "No comparative effectiveness data versus standard of care.",
      domain: "comparative_effectiveness",
      actor_name: ACTOR.name,
      actor_function: ACTOR.function,
    });
  }, 60_000);

  const commit = (rows: Partial<Parameters<typeof commitExtractedRecords>[0]>) =>
    commitExtractedRecords({
      source_id: sourceId,
      title: "HEOR interview",
      stakeholder_function: "heor",
      actor_name: ACTOR.name,
      actor_function: ACTOR.function,
      needs: [],
      gaps: [],
      tactics: [],
      ...rows,
    });
  const sameRow = (id: string) => ({
    id,
    name: "Versus SoC",
    statement: "Is it better than standard of care?",
    domain: "comparative_effectiveness" as const,
    source_id: sourceId,
    source_quote: "Payers asked for data versus standard of care.",
    duplicate_of: gapId,
  });

  it("joins a same candidate as a supporting need without a flag while nobody has validated the gap", async () => {
    const result = await commit({ gaps: [sameRow("S-1")], needs: [] });
    expect(result.merged_gap_ids).toEqual([gapId]);
    expect(result.gap_id_by_row).toEqual({ "S-1": gapId });
    expect(result.flagged_gap_ids).toEqual([]);
    const state = await loadState();
    const links = state.need_gap_links.filter((link) => link.gap_id === gapId);
    expect(links.some((link) => link.role === "supporting")).toBe(true);
    expect(state.gaps.find((gap) => gap.id === gapId)!.new_source_at).toBeNull();
  });

  it("flags a gap whose priority a person validated when a new source joins it", async () => {
    const result = await commit({
      gaps: [{ ...sameRow("S-2"), source_quote: "HTA bodies want the comparison against current standard care." }],
      validated_gap_ids: [gapId],
    });
    expect(result.flagged_gap_ids).toEqual([gapId]);
    const gap = (await loadState()).gaps.find((row) => row.id === gapId)!;
    expect(gap.new_source_at).toBeTruthy();
    expect(gap.new_source_need_id).toBe(result.need_ids[0]);
  });

  it("never attaches the same source sentence to a gap twice (re-run, or two twins quoting it)", async () => {
    const quote = "Payers repeated that they need data versus standard of care.";
    const twin = (id: string) => ({ ...sameRow(id), source_quote: quote });
    const first = await commit({ gaps: [twin("D-1"), twin("D-2")] });
    expect(first.need_ids).toHaveLength(1);
    const rerun = await commit({ gaps: [twin("D-3")], validated_gap_ids: [gapId] });
    expect(rerun.need_ids).toEqual([]);
    expect(rerun.flagged_gap_ids).toEqual([]);
    const state = await loadState();
    const sameQuote = state.need_gap_links.filter(
      (link) => link.gap_id === gapId && state.needs.find((need) => need.id === link.need_id)?.source_quote === quote,
    );
    expect(sameQuote).toHaveLength(1);
  });

  it("files an overlap as a pending suggestion and creates no gap", async () => {
    const before = (await loadState()).gaps.length;
    const result = await commit({
      overlaps: [
        {
          id: "O-1",
          gap_id: gapId,
          run_id: "run-test",
          name: "Over-75s versus SoC",
          statement: "How does it compare with SoC in patients over 75?",
          domain: "comparative_effectiveness",
          source_quote: "Nobody has looked at the over-75s.",
          ...OVERLAP,
        },
      ],
    });
    const state = await loadState();
    expect(state.gaps.length).toBe(before);
    const suggestion = state.gap_suggestions.find((row) => row.id === result.suggestion_id_by_row["O-1"])!;
    expect(suggestion).toMatchObject({ gap_id: gapId, status: "pending", source_id: sourceId, ...OVERLAP });
  });

  it("refuses an overlap with a gap that is not in the plan", async () => {
    await expect(
      commit({
        overlaps: [
          { id: "O-2", gap_id: "GAP-404", run_id: "r", name: "n", statement: "s", domain: "safety", source_quote: "q", ...OVERLAP },
        ],
      }),
    ).rejects.toThrow(/not a gap in the plan/);
  });
});

type Call = { purpose: string; body: Record<string, unknown> | null };

function route(): ResolvedRoute {
  return {
    stage: "S2",
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
}

function context(script: (call: Call) => unknown): ModuleContext {
  return {
    ai: true,
    workspace_id: "default",
    actor: ACTOR,
    role: "medical_affairs",
    route: route(),
    run: { id: "kan74-run", step: async (_name, fn) => fn(), note: () => {}, steps: () => [] },
    complete: async ({ purpose, user }) => {
      let body: Record<string, unknown> | null = null;
      try {
        body = JSON.parse(user) as Record<string, unknown>;
      } catch {
        // The first proposal prompt is prose.
      }
      return script({ purpose, body });
    },
  };
}

describe("KAN-74 S2 run across two documents", () => {
  let savedStub: string | undefined;
  let docA = "";
  let docB = "";
  let planGapId = "";
  let sourceA = "";
  let sourceB = "";

  beforeAll(async () => {
    await resetDemoSetup();
    await wipePlatform(["source_files", "parsed_documents", "gap_candidates"]);
    const lead = { actor: ACTOR, role: "medical_affairs" as const };
    await runStage({ stage: "S0", input: { demo_ids: ["heor-interview", "medical-kol"] }, ...lead });
    await runStage({ stage: "S1", input: {}, ...lead });
    const documents = await listParsedDocuments();
    expect(documents.length).toBeGreaterThanOrEqual(2);
    [docA, docB] = [documents[0]!.id, documents[1]!.id];
    [sourceA, sourceB] = [documents[0]!.source_id, documents[1]!.source_id];
    planGapId = await createGap({
      statement: "No comparative effectiveness data versus standard of care.",
      domain: "comparative_effectiveness",
      actor_name: ACTOR.name,
      actor_function: ACTOR.function,
    });
    await validateGap({ gap_id: planGapId, actor_name: ACTOR.name, actor_function: ACTOR.function, note: "confirmed open" });
  }, 90_000);

  beforeEach(() => {
    savedStub = process.env.SYNAPSE_TEST_STUB_LLM;
    delete process.env.SYNAPSE_TEST_STUB_LLM;
  });
  afterEach(() => {
    if (savedStub === undefined) delete process.env.SYNAPSE_TEST_STUB_LLM;
    else process.env.SYNAPSE_TEST_STUB_LLM = savedStub;
  });

  const gap = (name: string, statement: string, quote: string, domain = "treatment_patterns") => ({
    name,
    statement,
    domain,
    source_quote: quote,
  });

  it("creates new gaps, joins repeats, flags the validated gap and files the overlap", async () => {
    const before = await loadState();
    const persistence = gap("Real-world persistence", "How long do patients persist on therapy?", "Persistence is unknown.");
    const versusSoc = gap("Versus SoC", "How does it compare with SoC?", "Payers want SoC data.", "comparative_effectiveness");
    const over75 = gap("Over-75s versus SoC", "How does it compare with SoC in over-75s?", "Over-75s are a gap.", "comparative_effectiveness");
    const A1 = `${docA}-L001`;
    const A2 = `${docA}-L002`;
    const B1 = `${docB}-L001`;
    const B2 = `${docB}-L002`;
    const B3 = `${docB}-L003`;
    const ctx = context((call) => {
      if (call.purpose === `gap-proposer:${docA}`) return { gaps: [persistence, versusSoc] };
      if (call.purpose === `gap-proposer:${docB}`) return { gaps: [{ ...persistence, name: "Persistence again" }, over75, { ...over75, name: "Over-75s again" }] };
      if (call.purpose === "gap-critic") {
        const subjects = ((call.body?.candidates as { subject: string }[]) ?? []).map((row) => row.subject);
        return { critiques: subjects.map((subject) => ({ subject, verdict: "keep", confidence: 80, note: "holds" })) };
      }
      return {
        decisions: [
          { subject: A1, verdict: "accept", confidence: 90, reason: "new question", match: "new" },
          { subject: A2, verdict: "accept", confidence: 85, reason: "same as the plan gap", match: "same", match_gap_id: planGapId },
          { subject: B1, verdict: "accept", confidence: 80, reason: "repeats A1", match: "same", same_as_candidate: A1 },
          { subject: B2, verdict: "accept", confidence: 75, reason: "adds over-75s", match: "overlaps", match_gap_id: planGapId, ...OVERLAP },
          { subject: B3, verdict: "accept", confidence: 70, reason: "repeats B2", match: "same", same_as_candidate: B2 },
        ],
      };
    });

    const { output, summary } = await gapExtractModule.run(gapExtractModule.inputSchema.parse({ document_ids: [docA, docB] }), ctx);

    expect(summary).toBe("5 of 5 gap candidates accepted: 1 new gap committed, 2 joined existing gaps, 1 overlap to review");
    expect(output.committed_gap_ids).toHaveLength(1);
    expect(output.suggestion_ids).toHaveLength(1);
    expect(output.accepted.find((row) => row.id === B1)).toMatchObject({ match: "same", same_as_candidate: A1 });

    const state = await loadState();
    expect(state.gaps.filter(isLiveGap)).toHaveLength(before.gaps.filter(isLiveGap).length + 1);
    // B1's source joined the gap A1 became.
    const newGapId = output.committed_gap_ids[0]!;
    const sourcesOn = (gapId: string) =>
      state.need_gap_links
        .filter((link) => link.gap_id === gapId)
        .map((link) => state.needs.find((need) => need.id === link.need_id)!.source_id);
    expect(sourcesOn(newGapId).sort()).toEqual([sourceA, sourceB].sort());
    // A2 joined the validated plan gap, which now shows "New source added".
    expect(sourcesOn(planGapId)).toContain(sourceA);
    expect(state.gaps.find((row) => row.id === planGapId)!.new_source_at).toBeTruthy();
    // B2 is a suggestion, and B3 (its repeat) rides along on it.
    const suggestion = state.gap_suggestions.find((row) => row.id === output.suggestion_ids[0])!;
    expect(suggestion).toMatchObject({ gap_id: planGapId, status: "pending", source_id: sourceB, name: "Over-75s versus SoC" });
    expect(suggestion.candidate_row_id).toBeTruthy();
    expect(suggestion.extra_sources).toEqual([
      { source_id: sourceB, statement: over75.statement, source_quote: over75.source_quote },
    ]);
    expect(state.gaps.some((row) => row.name === "Over-75s versus SoC")).toBe(false);
  });
});
