/** Agreement counts distinguish agreement, edits and rejections without double-counting. */
import { describe, expect, it } from "vitest";
import type { DecisionExample } from "@/modules/kernel/decision-examples";
import { agreementSeries } from "@/modules/kernel/learning-agreement";

const row = (id: string, outcome: DecisionExample["outcome"], date = "2026-10-05T12:00:00Z", stage: DecisionExample["stage"] = "S2") => ({ id, outcome, created_at: date, stage }) as DecisionExample;
describe("agreementSeries", () => {
  it("counts each decision once and separates stages", () => {
    const accepted = row("a", "accepted");
    const series = agreementSeries([accepted, accepted, row("b", "edited"), row("c", "rejected"), row("d", "rejected"), row("e", "accepted", undefined, "S4")], "day");
    expect(series.find(x => x.stage === "S2")).toMatchObject({ total: 4, accepted: 1, edited: 1, rejected: 2, accepted_share: .25, edited_share: .25, rejected_share: .5 });
    expect(series.find(x => x.stage === "S4")?.total).toBe(1);
  });
  it("fills empty periods with null shares and uses Monday UTC week boundaries", () => {
    const series = agreementSeries([row("a", "accepted", "2026-10-05T23:00:00Z"), row("b", "edited", "2026-10-07T01:00:00Z")], "day");
    expect(series[1]).toMatchObject({ period: "2026-10-06", total: 0, accepted_share: null, edited_share: null, rejected_share: null });
    expect(agreementSeries([row("a", "accepted", "2026-10-11T23:00:00Z")], "week")[0].period).toBe("2026-10-05");
    expect(agreementSeries([], "day")).toEqual([]);
  });
  it("explicitly rejects invalid timestamps and outcomes", () => {
    expect(() => agreementSeries([row("a", "accepted", "not-a-date")], "day")).toThrow("timestamp");
    expect(() => agreementSeries([row("a", "invalid" as never)], "day")).toThrow("outcome");
  });
});
