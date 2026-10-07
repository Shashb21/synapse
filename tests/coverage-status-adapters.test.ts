import { describe, expect, it } from "vitest";
import { deriveGapStatus, type CoverageJoinLite } from "@/accuracy/modules/status-derive/engine";
import { computeGapStatus, emptyDimensions, unlocked, draftResidualStatement } from "@/lib/iegp/engine";
import type { GapTacticCoverage } from "@/lib/iegp/types";

type Row = { overall: string; lifecycle: string; validated?: boolean; freshness?: string };
const full = (lifecycle = "planned"): Row => ({ overall: "full", lifecycle, validated: true, freshness: "current" });
const scenarios: Array<[string, Row[], string]> = [
  ["proposed publication with available evidence", [full("proposed")], "open"],
  ["cancelled", [full("cancelled")], "open"],
  ["unknown lifecycle", [full("unknown")], "open"],
  ["planned Full dominates ongoing Limited", [full(), { ...full("ongoing"), overall: "limited" }], "addressed"],
  ["ongoing Full", [full("ongoing")], "addressed"],
  ["completed Full", [full("completed")], "addressed"],
  ["multiple Partial never become Full", [{ ...full(), overall: "partial" }, { ...full("completed"), overall: "partial" }], "partial"],
  ["Limited", [{ ...full(), overall: "limited" }], "partial"],
  ["stale validation", [{ ...full(), freshness: "stale" }], "open"],
  ["unknown freshness", [{ ...full(), freshness: "unknown" }], "open"],
  ["legacy missing freshness", [{ ...full(), freshness: undefined }], "open"],
  ["rejected", [{ ...full(), overall: "pending", validated: false }], "open"],
  ["pending", [{ ...full(), overall: "unassessed" }], "open"],
  ["model Full", [{ ...full(), validated: false }], "open"],
  ["Not relevant", [{ ...full(), overall: "not_relevant" }], "open"],
];
function planRows(rows: Row[]): GapTacticCoverage[] {
  return rows.map((r, i) => ({ id: `C${i}`, gap_id: "G", tactic_id: `T${i}`, overall: r.overall,
    dimensions: emptyDimensions(), overall_rationale: "Human assessment", stale: r.freshness === "stale", needs_review: false,
    overall_lock: { ...unlocked(), locked: r.validated ?? false }, validation_freshness: r.freshness,
  } as GapTacticCoverage));
}
describe("shared authoritative coverage status through both adapters", () => {
  it.each(scenarios)("%s", (_name, rows, expected) => {
    const coverages = rows.map((r, i) => ({ gap_id: "G", tactic_id: `T${i}`, overall: r.overall,
      validated: r.validated ?? false, freshness: r.freshness } as CoverageJoinLite));
    const tactics = rows.map((r, i) => ({ id: `T${i}`, status: r.lifecycle as "planned", type: "publication" as const, evidence_available: "2026-01-01" }));
    expect(deriveGapStatus({ gap_id: "G", coverages, tactics })).toBe(expected);
    expect(computeGapStatus(planRows(rows), tactics)).toBe(`validated_${expected}`);
  });
  it("cannot infer a committed lifecycle from the optional-tactics overload or an accepted child", () => {
    expect(computeGapStatus(planRows([full()]))).toBe("validated_open");
    expect(computeGapStatus([], [], { hasAcceptedChild: true })).toBe("validated_open");
  });
  it("residual drafting supplies actual lifecycle instead of treating a proposed Full as addressed", () => {
    const draft = draftResidualStatement({ gap: { name: "Comparison", statement: "Comparison", domain: "comparative_effectiveness" },
      coverages: planRows([full("proposed")]), tactics: [{ id: "T0", status: "proposed", type: "publication", evidence_available: "2026-01-01" }],
    } as Parameters<typeof draftResidualStatement>[0]);
    expect(draft.statement).not.toMatch(/No residual/);
    expect(draft.rationale).toContain("validated_open");
  });
});
