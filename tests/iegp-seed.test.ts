import { describe, expect, it } from "vitest";
import { buildSeed } from "@/lib/iegp/seed";

describe("Velmara IEGP seed", () => {
  const state = buildSeed();

  it("is one asset, one indication", () => {
    expect(state.asset.name).toBe("Velmara");
    expect(state.asset.indication).toMatch(/EGFR/i);
    expect(state.objectives.length).toBeGreaterThanOrEqual(4);
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

  it("separates coverage from priority (CNS override)", () => {
    const pri = state.priorities.find((p) => p.residual_id === "RES-CNS");
    expect(pri?.suggested_band).toBe("high");
    expect(pri?.band).toBe("medium");
    expect(pri?.override_reason).toBeTruthy();
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

  it("keeps completed tactics off the forward roadmap", () => {
    const completed = state.tactics.filter((t) => t.status === "completed").map((t) => t.id);
    expect(completed.length).toBeGreaterThan(0);
    expect(state.roadmap.some((r) => completed.includes(r.tactic_id))).toBe(false);
  });

  it("places caregiver in low so the three plan boxes are populated", () => {
    const pri = state.priorities.find((p) => p.residual_id === "RES-CAREGIVER");
    expect(pri?.band).toBe("low");
  });

  it("keeps an extracted candidate gap in the review queue", () => {
    const gap = state.gaps.find((g) => g.id === "GAP-ILD");
    expect(gap?.status).toBe("candidate");
    expect(state.residuals.some((r) => r.gap_id === "GAP-ILD" && !r.lock.locked)).toBe(true);
  });

  it("leaves long-term OS unprioritized so the plan can prompt a human lock", () => {
    const residual = state.residuals.find((r) => r.id === "RES-OS");
    expect(residual).toBeTruthy();
    expect(state.priorities.some((p) => p.residual_id === "RES-OS")).toBe(false);
  });

  it("locks every seed residual before priority", () => {
    for (const pri of state.priorities) {
      const residual = state.residuals.find((r) => r.id === pri.residual_id);
      expect(residual?.lock.locked).toBe(true);
      expect(pri.lock.locked).toBe(true);
    }
  });
});
