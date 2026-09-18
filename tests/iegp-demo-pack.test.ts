import { describe, expect, it } from "vitest";
import { DEMO_PACK } from "@/lib/iegp/demo-pack";
import { extractCandidateGaps, extractCandidateTactics } from "@/lib/iegp/engine";
import { buildBlankWorkspace } from "@/lib/iegp/blank";
import { readFileSync } from "node:fs";
import path from "node:path";

describe("blank demo workspace", () => {
  it("has the Velmara asset and objectives but no IEGP objects", () => {
    const state = buildBlankWorkspace();
    expect(state.asset.name).toBe("Velmara");
    expect(state.objectives.length).toBeGreaterThanOrEqual(4);
    expect(state.sources).toHaveLength(0);
    expect(state.gaps).toHaveLength(0);
    expect(state.tactics).toHaveLength(0);
    expect(state.needs).toHaveLength(0);
  });

  it("ships seven demo source files that extract gaps or tactics", () => {
    expect(DEMO_PACK).toHaveLength(7);
    for (const file of DEMO_PACK) {
      const blocks = [
        { id: "b", source_id: "s", heading: file.title, text: file.text },
      ];
      const gaps = extractCandidateGaps(blocks);
      const tactics = extractCandidateTactics(blocks);
      expect(
        gaps.length + tactics.length,
        `${file.filename} should extract at least one gap or tactic`,
      ).toBeGreaterThan(0);
      const onDisk = readFileSync(
        path.join(process.cwd(), "public/demo-sources", file.filename),
        "utf8",
      ).trim();
      expect(onDisk).toBe(file.text.trim());
    }
  });

  it("extracts both a gap and a tactic from the HEOR interview", () => {
    const file = DEMO_PACK.find((f) => f.id === "heor-interview")!;
    const blocks = [{ id: "b", source_id: "s", heading: file.title, text: file.text }];
    const gaps = extractCandidateGaps(blocks);
    const tactics = extractCandidateTactics(blocks);
    expect(gaps.some((g) => /comparative effectiveness|economic burden/i.test(g.statement))).toBe(true);
    expect(gaps.every((g) => !/heor stakeholder interviews/i.test(g.name))).toBe(true);
    expect(gaps.every((g) => !/^(Burden|Elderly):/i.test(g.name))).toBe(true);
    expect(gaps.some((g) => /economic burden|comparative/i.test(g.name))).toBe(true);
    expect(tactics.some((t) => t.type === "chart_review")).toBe(true);
  });
});
