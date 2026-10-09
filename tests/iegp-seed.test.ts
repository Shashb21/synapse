import { describe, expect, it } from "vitest";
import { buildSeed } from "@/lib/iegp/seed";
import { isLiveGap } from "@/lib/iegp/engine";

describe("Velmara IEGP seed", () => {
  const state = buildSeed();

  it("phrases every seed gap name as an evidence-topic title", () => {
    for (const gap of state.gaps) {
      expect(gap.name).toMatch(/^[A-Z0-9]/);
      expect(gap.name).not.toMatch(/[.?!]$/);
      expect(gap.name).not.toMatch(
        /^(We need|It has no|There is no|There is a lack of|KOLs need)\b/i,
      );
      expect(gap.name).not.toMatch(/is not adequately characterised/i);
      expect(gap.name).not.toMatch(/^(Burden|Elderly|CNS):/i);
    }
    for (const residual of state.residuals) {
      expect(residual.statement).not.toMatch(/^(We need|We still need|It has no)\b/i);
      expect(residual.statement).not.toMatch(/[.?!]$/);
    }
  });

  it("is one asset, one indication", () => {
    expect(state.asset.name).toBe("Velmara");
    expect(state.asset.indication).toMatch(/EGFR/i);
    expect(state.asset.wizard_complete).toBe(true);
    expect(state.objectives.length).toBeGreaterThanOrEqual(4);
    expect(state.tactics.every((t) => t.review_status === "accepted")).toBe(true);
  });

  it("keeps candidate needs from becoming automatic gaps", () => {
    const candidates = state.needs.filter((n) => n.status === "candidate");
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.some((n) => n.statement.toLowerCase().includes("65"))).toBe(true);
  });

  it("joins many needs onto the elderly comparative-effectiveness gap", () => {
    const links = state.need_gap_links.filter((l) => l.gap_id === "GAP-ELDERLY-CE");
    expect(links.length).toBeGreaterThanOrEqual(2);
  });

  it("joins at least one constituent need onto every live gap", () => {
    for (const gap of state.gaps.filter(isLiveGap)) {
      expect(
        state.need_gap_links.some((l) => l.gap_id === gap.id),
        `${gap.id} has no constituent need`,
      ).toBe(true);
    }
    expect(
      state.need_gap_links.some((l) => l.gap_id === "GAP-PFS-TRIAL" && l.need_id === "NEED-022"),
    ).toBe(true);
  });

  it("maps one registry tactic onto several gaps", () => {
    const maps = state.coverages.filter((c) => c.tactic_id === "TAC-REG");
    expect(maps.map((m) => m.gap_id).sort()).toEqual(
      ["GAP-HCRU", "GAP-QOL", "GAP-SEQ"].sort(),
    );
  });

  it("records elderly chart review as partial because the comparator is missing", () => {
    const row = state.coverages.find(
      (c) => c.gap_id === "GAP-ELDERLY-CE" && c.tactic_id === "TAC-ELDERLY-RWE",
    );
    expect(row?.overall).toBe("partial");
    expect(row?.dimensions.comparator.value).toBe("no");
    expect(row?.dimensions.population.value).toBe("yes");
  });

  it("preserves the parent gap when a residual exists", () => {
    const residual = state.residuals.find((r) => r.id === "RES-ELDERLY-SOC");
    const parent = state.gaps.find((g) => g.id === residual?.gap_id);
    expect(parent?.status).toBe("validated_partial");
    expect(parent?.statement.toLowerCase()).toMatch(/elderly/);
  });

  it("carries no legacy priority board or roadmap: bands are S8 placements (KAN-17)", () => {
    expect("priorities" in state).toBe(false);
    expect("roadmap" in state).toBe(false);
  });

  it("excludes congress footprint as a communication issue, not a gap", () => {
    const gap = state.gaps.find((g) => g.id === "GAP-CONGRESS");
    expect(gap?.status).toBe("excluded");
    expect(gap?.exclusion_reason).toBe("communication_issue");
  });

  it("treats the primary manuscript as a dissemination tactic not relevant to coverage", () => {
    const row = state.coverages.find(
      (c) => c.gap_id === "GAP-PFS-TRIAL" && c.tactic_id === "TAC-PUB-PFS",
    );
    expect(row?.overall).toBe("not_relevant");
  });

  it("maps the tactics the retired roadmap planned against a gap, unassessed", () => {
    for (const [gap_id, tactic_id] of [["GAP-PERSIST", "TAC-CLAIMS"], ["GAP-IRA", "TAC-BIM"]]) {
      const row = state.coverages.find((c) => c.gap_id === gap_id && c.tactic_id === tactic_id);
      expect(row?.overall).toBe("unassessed");
      expect(row?.overall_lock.locked).toBe(false);
    }
  });

  it("keeps an extracted candidate gap off the Gaps workbench", () => {
    const gap = state.gaps.find((g) => g.id === "GAP-ILD");
    expect(gap?.status).toBe("candidate");
    expect(state.residuals.some((r) => r.gap_id === "GAP-ILD" && !r.lock.locked)).toBe(true);
  });
});
