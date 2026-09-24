import { describe, expect, it } from "vitest";
import {
  MAPPING_SCORE_FLOOR,
  buildPlanWorkspace,
  isDisseminationTactic,
  scoreGapTacticMapping,
} from "@/lib/iegp/engine";
import { buildSeed } from "@/lib/iegp/seed";
import type { Tactic } from "@/lib/iegp/types";

function seedPair() {
  const seed = buildSeed();
  const gap = (id: string) => seed.gaps.find((g) => g.id === id)!;
  const tactic = (id: string) => seed.tactics.find((t) => t.id === id)!;
  const needs = (gapId: string) => {
    const ids = seed.need_gap_links.filter((l) => l.gap_id === gapId).map((l) => l.need_id);
    return seed.needs.filter((n) => ids.includes(n.id));
  };
  const residual = (gapId: string) => seed.residuals.find((r) => r.gap_id === gapId)?.statement;
  const score = (gapId: string, tacticId: string) =>
    scoreGapTacticMapping(gap(gapId), tactic(tacticId), {
      needs: needs(gapId),
      residual_statement: residual(gapId),
    });
  return { seed, gap, tactic, needs, residual, score };
}

function asCongressAbstract(base: Tactic, overrides: Partial<Tactic> = {}): Tactic {
  return {
    ...base,
    id: "TAC-CONGRESS-SEQ",
    name: "WCLC 2027 sequencing abstract",
    type: "congress_abstract",
    description: "Congress abstract disseminating the sequencing narrative. Does not generate evidence.",
    evidence_question: "Communicate real-world treatment sequencing after osimertinib failure.",
    study_design: "Abstract",
    intended_use: "Dissemination",
    ...overrides,
  };
}

describe("gap–tactic scorer (S4 test-stub only)", () => {
  it("prefers the ≥65 chart review over an unrelated publication for the elderly CE gap", () => {
    const { score } = seedPair();
    const chart = score("GAP-ELDERLY-CE", "TAC-ELDERLY-RWE");
    const pub = score("GAP-ELDERLY-CE", "TAC-PUB-PFS");
    expect(chart.score).toBeGreaterThanOrEqual(MAPPING_SCORE_FLOOR);
    expect(chart.score).toBeGreaterThan(pub.score);
    expect(pub.score).toBeLessThan(MAPPING_SCORE_FLOOR);
    expect(chart.reasons.length).toBeGreaterThanOrEqual(2);
    expect(chart.reasons.length).toBeLessThanOrEqual(4);
    expect(chart.reasons.join(" ")).toMatch(/elderly|≥65|65|chart review|comparative/i);
  });

  it("lets a sequence/HCRU/QoL gap prefer the registry when names and questions overlap", () => {
    const { score } = seedPair();
    for (const gapId of ["GAP-SEQ", "GAP-HCRU", "GAP-QOL"] as const) {
      const registry = score(gapId, "TAC-REG");
      const pub = score(gapId, "TAC-PUB-PFS");
      expect(registry.score).toBeGreaterThanOrEqual(MAPPING_SCORE_FLOOR);
      expect(registry.score).toBeGreaterThan(pub.score);
      expect(registry.reasons.length).toBeGreaterThanOrEqual(2);
    }
    expect(score("GAP-SEQ", "TAC-REG").reasons.join(" ")).toMatch(/sequenc|registry|treatment pattern/i);
    expect(score("GAP-HCRU", "TAC-REG").reasons.join(" ")).toMatch(/hcru|hospitalisation|registry/i);
    expect(score("GAP-QOL", "TAC-REG").reasons.join(" ")).toMatch(/qol|pro|registry/i);
  });

  it("does not let a dissemination tactic outrank a generation tactic on a comparative-effectiveness gap", () => {
    const { gap, needs, residual, tactic } = seedPair();
    const elderly = gap("GAP-ELDERLY-CE");
    const chart = tactic("TAC-ELDERLY-RWE");
    const congress = asCongressAbstract(tactic("TAC-PUB-PFS"), {
      name: "Congress abstract on elderly comparative effectiveness",
      evidence_question: "Communicate comparative effectiveness of velmaratinib versus standard of care in elderly patients.",
      population: "Aged ≥65",
      comparator: "Regional SoC",
      outcomes: "PFS, OS",
    });
    const extras = { needs: needs("GAP-ELDERLY-CE"), residual_statement: residual("GAP-ELDERLY-CE") };
    const chartScore = scoreGapTacticMapping(elderly, chart, extras);
    const congressScore = scoreGapTacticMapping(elderly, congress, extras);
    expect(chartScore.score).toBeGreaterThan(congressScore.score);
    expect(chart.type).toBe("chart_review");
    expect(congress.type).toBe("congress_abstract");
  });

  it("rejected or covered pairs score zero", () => {
    const { seed, score } = seedPair();
    expect(score("GAP-ELDERLY-CE", "TAC-ELDERLY-RWE").score).toBeGreaterThanOrEqual(MAPPING_SCORE_FLOOR);
    expect(
      scoreGapTacticMapping(seed.gaps[0]!, seed.tactics[0]!, { rejected: true }).score,
    ).toBe(0);
    expect(
      scoreGapTacticMapping(seed.gaps[0]!, seed.tactics[0]!, { covered: true }).score,
    ).toBe(0);
  });

  it("maps a pneumonitis safety gap to an extracted chart review above the floor", () => {
    const scored = scoreGapTacticMapping(
      {
        name: "Pneumonitis rates in community hospitals after month six of Velmara",
        statement:
          "We need to understand pneumonitis rates in community hospitals after month six of Velmara.",
        domain: "safety",
      },
      {
        name: "EU5 hospital chart review",
        type: "chart_review",
        description: "Extracted from affiliate note.",
        evidence_question: "A chart review in three EU5 hospitals is already underway.",
        population: "To be specified",
        intervention: "Velmara",
        comparator: "To be specified",
        outcomes: "To be specified",
        study_design: "Extracted — not yet designed",
      },
    );
    expect(scored.score).toBeGreaterThanOrEqual(MAPPING_SCORE_FLOOR);
    expect(scored.reasons.length).toBeGreaterThanOrEqual(2);
  });

  it("reads dissemination off the tactic type, never its wording", () => {
    const { tactic } = seedPair();
    const chart = tactic("TAC-ELDERLY-RWE");
    expect(isDisseminationTactic({ type: "congress_abstract" })).toBe(true);
    expect(isDisseminationTactic({ type: "publication" })).toBe(true);
    const worded = { ...chart, name: "Congress abstract manuscript disseminating results" };
    expect(isDisseminationTactic(worded)).toBe(false);
  });

  it("offers no engine-ranked mapping suggestions: S4 is the only source of coverage", () => {
    const workspace = buildPlanWorkspace({ ...buildSeed(), coverages: [] });
    expect("mappingSuggestions" in workspace).toBe(false);
  });
});
