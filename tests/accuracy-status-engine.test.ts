import { describe, expect, it } from "vitest";
import { deriveGapStatus, normalizeCoverageOverall } from "@/accuracy/modules/status-derive/engine";

describe("accuracy status engine", () => {
  it("marks open when no validated joins", () => {
    expect(deriveGapStatus({ gap_id: "G1", coverages: [], tactics: [] })).toBe("open");
  });

  it("ignores unvalidated joins", () => {
    expect(
      deriveGapStatus({
        gap_id: "G1",
        coverages: [{ gap_id: "G1", tactic_id: "T1", overall: "full", validated: false }],
        tactics: [{ id: "T1", status: "ongoing" }],
      }),
    ).toBe("open");
  });

  it("marks addressed for validated full + committed tactic", () => {
    expect(
      deriveGapStatus({
        gap_id: "G1",
        coverages: [{ gap_id: "G1", tactic_id: "T1", overall: "full", validated: true, freshness: "current" }],
        tactics: [{ id: "T1", status: "ongoing" }],
      }),
    ).toBe("addressed");
  });

  it("maps coverage UI 'covers' onto full", () => {
    expect(normalizeCoverageOverall("covers")).toBe("full");
    expect(
      deriveGapStatus({
        gap_id: "G1",
        coverages: [{ gap_id: "G1", tactic_id: "T1", overall: "covers", validated: true, freshness: "current" }],
        tactics: [{ id: "T1", status: "planned" }],
      }),
    ).toBe("addressed");
  });

  it("marks partial when limited coverage", () => {
    expect(
      deriveGapStatus({
        gap_id: "G1",
        coverages: [{ gap_id: "G1", tactic_id: "T1", overall: "limited", validated: true, freshness: "current" }],
        tactics: [{ id: "T1", status: "planned" }],
      }),
    ).toBe("partial");
  });

  it("marks open for proposed-only full coverage", () => {
    expect(
      deriveGapStatus({
        gap_id: "G1",
        coverages: [{ gap_id: "G1", tactic_id: "T1", overall: "full", validated: true, freshness: "current" }],
        tactics: [{ id: "T1", status: "proposed" }],
      }),
    ).toBe("open");
  });

  it("marks open when the only covering tactic is cancelled", () => {
    expect(
      deriveGapStatus({
        gap_id: "G1",
        coverages: [{ gap_id: "G1", tactic_id: "T1", overall: "full", validated: true, freshness: "current" }],
        tactics: [{ id: "T1", status: "cancelled" }],
      }),
    ).toBe("open");
  });

  it("marks addressed when current committed Full sits beside Limited", () => {
    expect(
      deriveGapStatus({
        gap_id: "G1",
        coverages: [
          { gap_id: "G1", tactic_id: "T1", overall: "full", validated: true, freshness: "current" },
          { gap_id: "G1", tactic_id: "T2", overall: "limited", validated: true, freshness: "current" },
        ],
        tactics: [
          { id: "T1", status: "completed" },
          { id: "T2", status: "ongoing" },
        ],
      }),
    ).toBe("addressed");
  });

  it("treats not_relevant and unknown overall as non-qualifying", () => {
    expect(
      deriveGapStatus({
        gap_id: "G1",
        coverages: [
          { gap_id: "G1", tactic_id: "T1", overall: "not_relevant", validated: true, freshness: "current" },
          { gap_id: "G1", tactic_id: "T2", overall: "unknown", validated: true, freshness: "current" },
        ],
        tactics: [
          { id: "T1", status: "ongoing" },
          { id: "T2", status: "ongoing" },
        ],
      }),
    ).toBe("open");
  });
});
