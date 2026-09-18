import { describe, expect, it } from "vitest";
import {
  buildPlanBoard,
  buildPlanWorkspace,
  coverageEval,
  draftResidualStatement,
  engineMaySetStatus,
  extractCandidateGaps,
  extractCandidateNeeds,
  extractCandidateTactics,
  gapNameFromStatement,
  MAPPING_SUGGESTION_CAP,
  needEvalMetrics,
  pairNeeds,
  planColumn,
  splitSourceIntoBlocks,
  suggestGapStatus,
  suggestMappings,
  suggestPriority,
} from "@/lib/iegp/engine";
import { emptyDimensions, unlocked } from "@/lib/iegp/engine";
import { buildSeed } from "@/lib/iegp/seed";
import type { GapTacticCoverage } from "@/lib/iegp/types";
import { COVERAGE_DIMENSIONS } from "@/lib/iegp/enums";

function cov(overall: GapTacticCoverage["overall"], dims: Partial<GapTacticCoverage["dimensions"]>): GapTacticCoverage {
  const dimensions = emptyDimensions();
  for (const key of Object.keys(dims) as (keyof typeof dims)[]) {
    dimensions[key] = dims[key]!;
  }
  return {
    id: "c",
    gap_id: "g",
    tactic_id: "t",
    dimensions,
    overall,
    overall_rationale: "test",
    overall_lock: unlocked(),
    stale: false,
  };
}

describe("IEGP engine", () => {
  it("never allows the engine to write addressed", () => {
    expect(engineMaySetStatus("validated_addressed")).toBe(false);
    expect(engineMaySetStatus("validated_partial")).toBe(true);
  });

  it("drafts a residual that keeps the parent gap and flags a missing comparator", () => {
    const coverage = cov("partial", {
      population: { value: "yes", rationale: "", lock: unlocked() },
      intervention: { value: "yes", rationale: "", lock: unlocked() },
      comparator: { value: "no", rationale: "", lock: unlocked() },
      outcomes: { value: "yes", rationale: "", lock: unlocked() },
      decision_utility: { value: "no", rationale: "", lock: unlocked() },
    });
    const draft = draftResidualStatement({
      gap: {
        name: "Elderly vs SoC",
        statement: "Limited evidence on comparative effectiveness in elderly patients.",
        domain: "comparative_effectiveness",
      },
      coverages: [coverage],
    });
    expect(draft.statement.toLowerCase()).toMatch(/comparative|standard of care/);
    expect(draft.rationale).toMatch(/preserved|Uncovered/i);
  });

  it("does not treat a tactic existing as fully addressed", () => {
    const coverage = cov("limited", {
      relevance: { value: "partial", rationale: "", lock: unlocked() },
      comparator: { value: "no", rationale: "", lock: unlocked() },
    });
    expect(suggestGapStatus([coverage])).toBe("validated_open");
  });

  it("suggests priority without using cost or effort", () => {
    const pri = suggestPriority({
      residual: { statement: "IRA BIM remaining" },
      objective: {
        strategic_importance: 5,
        decision_date: "2026-12-01",
        key_decision: "P&T",
      },
      coverages: [],
      stakeholder: "hta",
      today: new Date("2026-09-17"),
    });
    expect(pri.score).toBeGreaterThan(50);
    expect(pri.reasons.join(" ")).not.toMatch(/\bcost\b|\bbudget\b|\beffort\b/i);
  });

  it("pairs extracted needs to gold without double-claiming", () => {
    const pairs = pairNeeds(
      [
        { id: "e1", statement: "Need to understand the economic burden associated with recurrence after velmaratinib.", source_id: "s" },
        { id: "e2", statement: "Unrelated fabricated claim about penguins.", source_id: "s" },
      ],
      [
        { id: "g1", statement: "Need to understand the economic burden associated with recurrence after velmaratinib.", source_id: "s", must_find: true },
      ],
    );
    expect(pairs.some((p) => p.kind === "exact" && p.gold_id === "g1")).toBe(true);
    expect(pairs.some((p) => p.kind === "wrong" && p.extract_id === "e2")).toBe(true);
    const metrics = needEvalMetrics(pairs, [{ id: "g1", must_find: true }], 2);
    expect(metrics.recall).toBe(1);
  });

  it("extracts candidate-need cues from source blocks", () => {
    const rows = extractCandidateNeeds([
      {
        id: "b",
        source_id: "s",
        heading: "Burden",
        text: "We need to understand the economic burden associated with recurrence. The weather was fine.",
      },
    ]);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.statement).toMatch(/economic burden/i);
  });

  it("extracts candidate gaps and tactics from the same source", () => {
    const blocks = [
      {
        id: "b1",
        source_id: "s",
        heading: "Elderly",
        text: "We need to understand comparative effectiveness of Velmara versus regional standard of care in elderly patients. Limited evidence remains on that question.",
      },
      {
        id: "b2",
        source_id: "s",
        heading: "VEL-301",
        text: "VEL-301 Phase III versus osimertinib addresses PFS in 2L EGFR-mutant NSCLC. The prospective Velmara registry will collect treatment and PROs.",
      },
    ];
    const gaps = extractCandidateGaps(blocks);
    const tactics = extractCandidateTactics(blocks);
    expect(gaps.some((g) => /comparative effectiveness/i.test(g.statement))).toBe(true);
    expect(tactics.some((t) => t.type === "phase3_trial")).toBe(true);
    expect(tactics.some((t) => t.type === "registry")).toBe(true);
  });

  it("names gaps from the statement, not the source title", () => {
    const gaps = extractCandidateGaps([
      {
        id: "b",
        source_id: "s",
        heading: "HEOR stakeholder interviews",
        text: "We need to understand the economic burden associated with recurrence after velmaratinib. Limited evidence characterises direct costs.",
      },
    ]);
    expect(gaps.length).toBeGreaterThan(0);
    for (const gap of gaps) {
      expect(gap.name.toLowerCase()).not.toMatch(/heor|interview/);
      expect(gap.name).not.toMatch(/^(Burden|Elderly|CNS):/i);
    }
    expect(gaps.some((g) => /economic burden/i.test(g.name))).toBe(true);
    expect(
      gapNameFromStatement(
        "We need to understand comparative effectiveness of Velmara versus regional standard of care.",
        "HEOR stakeholder interviews",
      ),
    ).not.toMatch(/interview/i);
  });

  it("names gaps as sentences from the statement, without a section heading prefix", () => {
    expect(
      gapNameFromStatement(
        "We need to understand the economic burden associated with recurrence after velmaratinib.",
        "Burden",
      ),
    ).toBe(
      "The economic burden associated with recurrence after velmaratinib is not adequately characterised.",
    );
    expect(
      gapNameFromStatement(
        "We need to understand comparative effectiveness of Velmara versus regional standard of care in elderly patients.",
        "Elderly",
      ),
    ).toBe(
      "Comparative effectiveness of Velmara versus regional standard of care in elderly patients.",
    );
    expect(
      gapNameFromStatement("KOLs need to know intracranial outcomes.", "CNS"),
    ).toBe("KOLs need to know intracranial outcomes.");

    const text = `HEOR stakeholder interviews — Velmara.

Burden
We need to understand the economic burden associated with recurrence after velmaratinib.

Elderly
We need to understand comparative effectiveness of Velmara versus regional standard of care in elderly patients.`;
    const blocks = splitSourceIntoBlocks(text, "HEOR stakeholder interviews").map((section, i) => ({
      id: `b${i}`,
      source_id: "s",
      heading: section.heading,
      text: section.text,
    }));
    const gaps = extractCandidateGaps(blocks);
    expect(gaps.every((g) => !/^(Burden|Elderly):/i.test(g.name))).toBe(true);
    expect(gaps.some((g) => /^The economic burden associated with recurrence after velmaratinib/i.test(g.name))).toBe(
      true,
    );
    expect(
      gaps.some((g) =>
        /^Comparative effectiveness of Velmara versus regional standard of care in elderly patients/i.test(g.name),
      ),
    ).toBe(true);
    expect(gaps.every((g) => /^[A-Z]/.test(g.name) && /[.?!]$/.test(g.name))).toBe(true);
  });

  it("splits a demo source into section blocks such as Elderly", () => {
    const text = `HEOR stakeholder interviews — Velmara.

Burden
We need to understand the economic burden associated with recurrence after velmaratinib.

Elderly
We need to understand comparative effectiveness of Velmara versus regional standard of care in elderly patients.`;
    const blocks = splitSourceIntoBlocks(text, "HEOR stakeholder interviews");
    expect(blocks.some((b) => b.heading === "Burden")).toBe(true);
    expect(blocks.some((b) => b.heading === "Elderly")).toBe(true);
    expect(blocks.every((b) => b.heading !== "HEOR stakeholder interviews")).toBe(true);
  });

  it("scores gold coverage overall degrees", () => {
    const result = coverageEval(
      [{ gap_id: "g", tactic_id: "t", overall: "partial" }],
      [{ gap_id: "g", tactic_id: "t", overall: "partial" }],
    );
    expect(result.exact).toBe(1);
    expect(result.wrong).toBe(0);
  });

  it("has ten coverage dimensions", () => {
    expect(COVERAGE_DIMENSIONS).toHaveLength(10);
  });

  it("boards the IEGP as high / medium / low with associated tactics", () => {
    expect(planColumn("critical")).toBe("high");
    const board = buildPlanBoard(buildSeed());
    expect(board.high.some((c) => c.gap_id === "GAP-ELDERLY-CE")).toBe(true);
    const elderly = board.high.find((c) => c.gap_id === "GAP-ELDERLY-CE")!;
    expect(elderly.tactics.some((t) => t.id === "TAC-ELDERLY-RWE")).toBe(true);
    expect(board.medium.some((c) => c.gap_id === "GAP-CNS")).toBe(true);
    expect(board.low.some((c) => c.gap_id === "GAP-CAREGIVER")).toBe(true);
  });

  it("keeps addressed gaps on the workspace with their tactics", () => {
    const workspace = buildPlanWorkspace(buildSeed());
    expect(workspace.review.some((c) => c.gap_id === "GAP-ILD")).toBe(true);
    expect(workspace.unprioritized.some((c) => c.gap_id === "GAP-OS")).toBe(true);
    const pfs = workspace.addressed.find((c) => c.gap_id === "GAP-PFS-TRIAL");
    expect(pfs).toBeTruthy();
    expect(pfs!.tactics.some((t) => t.id === "TAC-VEL-301")).toBe(true);
    expect(workspace.board.high.some((c) => c.gap_id === "GAP-SEQ")).toBe(true);
    expect(workspace.reviewTactics).toHaveLength(0);
    expect(workspace.availableTactics.some((t) => t.id === "TAC-REG")).toBe(true);
    const registry = workspace.availableTactics.find((t) => t.id === "TAC-REG");
    expect(registry?.gaps.map((g) => g.id).sort()).toEqual(["GAP-HCRU", "GAP-QOL", "GAP-SEQ"].sort());
  });

  it("puts mapped tactics on review and unprioritized cards, and leaves empty gaps empty", () => {
    const seed = buildSeed();
    const workspace = buildPlanWorkspace(seed);
    const ild = workspace.review.find((c) => c.gap_id === "GAP-ILD");
    expect(ild).toBeTruthy();
    expect(ild!.tactics).toHaveLength(0);
    const os = workspace.unprioritized.find((c) => c.gap_id === "GAP-OS");
    expect(os).toBeTruthy();
    expect(os!.tactics.some((t) => t.id === "TAC-LTFU")).toBe(true);

    const mapped = buildPlanWorkspace({
      ...seed,
      coverages: [
        ...seed.coverages,
        {
          ...seed.coverages[0]!,
          id: "COV-ILD-REG",
          gap_id: "GAP-ILD",
          tactic_id: "TAC-REG",
        },
      ],
    });
    expect(mapped.review.find((c) => c.gap_id === "GAP-ILD")!.tactics.some((t) => t.id === "TAC-REG")).toBe(
      true,
    );
  });

  it("suggests mappings only for accepted open/partial gaps and accepted tactics", () => {
    const seed = buildSeed();
    const suggestions = suggestMappings(seed);
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions.length).toBeLessThanOrEqual(MAPPING_SUGGESTION_CAP);
    for (const row of suggestions) {
      const gap = seed.gaps.find((g) => g.id === row.gap_id);
      const tactic = seed.tactics.find((t) => t.id === row.tactic_id);
      expect(gap?.status === "validated_open" || gap?.status === "validated_partial").toBe(true);
      expect(tactic?.review_status).toBe("accepted");
      expect(tactic?.status).not.toBe("cancelled");
      expect(seed.coverages.some((c) => c.gap_id === row.gap_id && c.tactic_id === row.tactic_id)).toBe(
        false,
      );
    }
    expect(suggestions.some((s) => s.gap_id === "GAP-ILD")).toBe(false);
    expect(suggestions.some((s) => s.gap_id === "GAP-CONGRESS")).toBe(false);
    expect(suggestions.some((s) => s.gap_id === "GAP-PFS-TRIAL")).toBe(false);
    expect(
      suggestions.some((s) => s.gap_id === "GAP-ELDERLY-CE" && s.tactic_id === "TAC-ELDERLY-RWE"),
    ).toBe(false);
  });

  it("drops a mapping after it is rejected or already covered", () => {
    const seed = buildSeed();
    const [first] = suggestMappings(seed);
    expect(first).toBeTruthy();
    const rejected = suggestMappings({
      ...seed,
      mapping_suggestions: [
        {
          gap_id: first!.gap_id,
          tactic_id: first!.tactic_id,
          status: "rejected",
          lock: unlocked(),
        },
      ],
    });
    expect(rejected.some((s) => s.gap_id === first!.gap_id && s.tactic_id === first!.tactic_id)).toBe(
      false,
    );
    const covered = suggestMappings({
      ...seed,
      coverages: [
        ...seed.coverages,
        {
          ...seed.coverages[0]!,
          id: "COV-SUGGEST-TEST",
          gap_id: first!.gap_id,
          tactic_id: first!.tactic_id,
        },
      ],
    });
    expect(covered.some((s) => s.gap_id === first!.gap_id && s.tactic_id === first!.tactic_id)).toBe(
      false,
    );
  });
});
