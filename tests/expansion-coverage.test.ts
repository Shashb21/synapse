import { describe, expect, it } from "vitest";
import { buildSeed } from "@/lib/iegp/seed";
import { computeGapStatus, countingCoverages, mappedTactics } from "@/lib/iegp/engine";
import type { TacticExpansion } from "@/lib/iegp/types";

function scenario(status: string = "proposed") {
  const state = buildSeed();
  const tactic = { ...state.tactics[0]!, status: "ongoing" as const };
  const coverage = { ...state.coverages[0]!, tactic_id: tactic.id, expansion_id: "EXP-1", overall: "full" as const,
    overall_lock: { ...state.coverages[0]!.overall_lock, locked: false } };
  const expansion = { id: "EXP-1", tactic_id: tactic.id, gap_ids: [coverage.gap_id], status } as TacticExpansion;
  return { tactic, coverage, expansion };
}

describe("expansion-scoped coverage eligibility", () => {
  it("plan rows display independent child lifecycle and scoped identity", () => {
    const state = buildSeed();
    const {tactic, coverage, expansion} = scenario();
    expansion.scope = {name: "Added population"} as TacticExpansion["scope"];
    state.tactics = [tactic]; state.coverages = [coverage]; state.expansions = [expansion];
    expect(mappedTactics(state, coverage.gap_id)[0]).toMatchObject({id: tactic.id, expansion_id: expansion.id,
      status: "proposed", counts_toward_addressing: false, name: "Added population"});
  });
  it.each(["proposed", "cancelled", "rejected"])("%s child does not inherit an ongoing parent's eligibility", (status) => {
    const { tactic, coverage, expansion } = scenario(status);
    expect(computeGapStatus([coverage], [tactic], { expansions: [expansion] })).toBe("validated_open");
  });
  it.each(["planned", "ongoing", "completed"])("%s child counts without automatically validating Full", (status) => {
    const { tactic, coverage, expansion } = scenario(status);
    expect(computeGapStatus([coverage], [tactic], { expansions: [expansion] })).toBe("validated_partial");
    expect(computeGapStatus([{ ...coverage, overall_lock: { ...coverage.overall_lock, locked: true } }], [tactic], { expansions: [expansion] })).toBe("validated_addressed");
  });
  it("fails closed on missing child, wrong parent and wrong gap even in legacy calls", () => {
    const { tactic, coverage, expansion } = scenario("planned");
    expect(countingCoverages([coverage], [tactic])).toEqual([]);
    expect(computeGapStatus([coverage])).toBe("validated_open");
    for (const child of [{ ...expansion, tactic_id: "other" }, { ...expansion, gap_ids: ["other"] }]) {
      expect(countingCoverages([coverage], [tactic], [child])).toEqual([]);
    }
  });
  it("preserves locked parent Full alongside non-counting child and Limited", () => {
    const { tactic, coverage, expansion } = scenario();
    const parent = { ...coverage, id: "PARENT", expansion_id: null, overall_lock: { ...coverage.overall_lock, locked: true } };
    expect(computeGapStatus([parent, coverage, { ...parent, id: "LIMITED", overall: "limited" }], [tactic], { expansions: [expansion] })).toBe("validated_addressed");
    expect(computeGapStatus([parent], [tactic])).toBe("validated_addressed");
  });
});
