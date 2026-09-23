import { describe, expect, it } from "vitest";
import {
  coverageRouteAllowsLlm,
  mapCoverageOverallToUi,
} from "@/accuracy/modules/coverage-decide/overall-map";
import {
  blockBundleIdsForPair,
  buildCoverageQueue,
} from "@/accuracy/store/coverage-queue";
import type { AccuracyClaimRow } from "@/accuracy/store/claim-store";
import type { CoveragePair } from "@/accuracy/store/coverage-store";

function claim(
  partial: Partial<AccuracyClaimRow> & Pick<AccuracyClaimRow, "id" | "claim_type" | "statement">,
): AccuracyClaimRow {
  return {
    workspace_id: "ws-1",
    status: "draft",
    validated: false,
    source_file_id: null,
    metadata: {},
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

function pair(
  gap: AccuracyClaimRow,
  tactic: AccuracyClaimRow,
  opts?: { validated?: boolean; overall?: string | null },
): CoveragePair {
  const meta = (tactic.metadata ?? {}) as { start?: string; end?: string };
  return {
    id: `pair_${gap.id}_${tactic.id}`,
    gap,
    tactic,
    overall: opts?.overall ?? null,
    rationale: null,
    validated: opts?.validated ?? false,
    tactic_start: typeof meta.start === "string" ? meta.start : null,
    tactic_end: typeof meta.end === "string" ? meta.end : null,
  };
}

describe("mapCoverageOverallToUi", () => {
  it("maps schema overalls onto UI decide labels", () => {
    expect(mapCoverageOverallToUi("full")).toBe("covers");
    expect(mapCoverageOverallToUi("partial")).toBe("partial");
    expect(mapCoverageOverallToUi("limited")).toBe("partial");
    expect(mapCoverageOverallToUi("not_relevant")).toBe("none");
  });
});

describe("coverageRouteAllowsLlm", () => {
  it("accepts oauth and api_key when connected", () => {
    expect(coverageRouteAllowsLlm({ connected: true, auth: "oauth" })).toBe(true);
    expect(coverageRouteAllowsLlm({ connected: true, auth: "api_key" })).toBe(true);
    expect(coverageRouteAllowsLlm({ connected: true, auth: "none" })).toBe(false);
    expect(coverageRouteAllowsLlm({ connected: false, auth: "api_key" })).toBe(false);
  });
});

describe("buildCoverageQueue", () => {
  it("puts undecided first and exposes current", () => {
    const g1 = claim({ id: "gap_1", claim_type: "gap", statement: "Need A" });
    const g2 = claim({ id: "gap_2", claim_type: "gap", statement: "Need B" });
    const t1 = claim({ id: "tac_1", claim_type: "tactic", statement: "Tactic 1" });
    const decided = pair(g1, t1, { validated: true, overall: "covers" });
    const open = pair(g2, t1, { validated: false });
    const snap = buildCoverageQueue([decided, open]);
    expect(snap.undecided_count).toBe(1);
    expect(snap.decided_count).toBe(1);
    expect(snap.current?.gap.id).toBe("gap_2");
    expect(snap.undecided[0]?.id).toBe(open.id);
  });
});

describe("blockBundleIdsForPair", () => {
  it("dedupes provenance block ids from gap and tactic", () => {
    const gap = claim({
      id: "gap_1",
      claim_type: "gap",
      statement: "Need",
      metadata: {
        provenance: [
          { source_file_id: "src", block_id: "B1", quote: "q1" },
          { source_file_id: "src", block_id: "B2", quote: "q2" },
        ],
      },
    });
    const tactic = claim({
      id: "tac_1",
      claim_type: "tactic",
      statement: "Tactic",
      metadata: {
        provenance: [
          { source_file_id: "src", block_id: "B2", quote: "q2b" },
          { source_file_id: "src", block_id: "B3", quote: "q3" },
        ],
      },
    });
    expect(blockBundleIdsForPair(gap, tactic)).toEqual(["B1", "B2", "B3"]);
  });
});
