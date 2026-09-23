import { describe, expect, it } from "vitest";
import { deriveGapStatus } from "@/accuracy/modules/status-derive/engine";

describe("accuracy status engine", () => {
  it("marks open when no validated joins", () => {
    expect(
      deriveGapStatus({ gap_id: "G1", coverages: [], tactics: [] }),
    ).toBe("open");
  });

  it("marks addressed for validated full + committed tactic", () => {
    expect(
      deriveGapStatus({
        gap_id: "G1",
        coverages: [
          { gap_id: "G1", tactic_id: "T1", overall: "full", validated: true },
        ],
        tactics: [{ id: "T1", status: "ongoing" }],
      }),
    ).toBe("addressed");
  });

  it("marks partial when limited coverage", () => {
    expect(
      deriveGapStatus({
        gap_id: "G1",
        coverages: [
          { gap_id: "G1", tactic_id: "T1", overall: "limited", validated: true },
        ],
        tactics: [{ id: "T1", status: "planned" }],
      }),
    ).toBe("partial");
  });
});
