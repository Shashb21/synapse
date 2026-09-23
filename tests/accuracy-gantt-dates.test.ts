import { describe, expect, it } from "vitest";
import {
  expandTimingToken,
  normalizeAsEnd,
  normalizeAsStart,
  requireIsoDateRange,
  resolveTacticDates,
} from "@/accuracy/modules/gantt-project/dates";
import { projectGanttFromTactics } from "@/accuracy/modules/gantt-project/engine";

describe("gantt date continuity helpers", () => {
  it("expands ISO days, months, years, quarters, and halves", () => {
    expect(expandTimingToken("2026-03-15")).toEqual({
      start: "2026-03-15",
      end: "2026-03-15",
    });
    expect(expandTimingToken("2026-03")).toEqual({
      start: "2026-03-01",
      end: "2026-03-31",
    });
    expect(expandTimingToken("2026")).toEqual({
      start: "2026-01-01",
      end: "2026-12-31",
    });
    expect(expandTimingToken("Q1 2027")).toEqual({
      start: "2027-01-01",
      end: "2027-03-31",
    });
    expect(expandTimingToken("2027-Q3")).toEqual({
      start: "2027-07-01",
      end: "2027-09-30",
    });
    expect(expandTimingToken("H2 2026")).toEqual({
      start: "2026-07-01",
      end: "2026-12-31",
    });
    expect(expandTimingToken("not-a-date")).toBeNull();
  });

  it("resolves discrete start/end and falls back to timing labels", () => {
    expect(
      resolveTacticDates({ start: "2026-01-01", end: "2026-06-01" }),
    ).toEqual({ start: "2026-01-01", end: "2026-06-01" });
    expect(resolveTacticDates({ timing: "Q2 2026" })).toEqual({
      start: "2026-04-01",
      end: "2026-06-30",
    });
    expect(
      resolveTacticDates({ start: "2026-05-01", timing: "Q2 2026" }),
    ).toEqual({ start: "2026-05-01", end: "2026-06-30" });
    expect(resolveTacticDates({ start: "2027-01-01", end: "2026-01-01" })).toBeNull();
    expect(resolveTacticDates({})).toBeNull();
  });

  it("normalizes start/end sides of a token", () => {
    expect(normalizeAsStart("H1 2026")).toBe("2026-01-01");
    expect(normalizeAsEnd("H1 2026")).toBe("2026-06-30");
  });

  it("requireIsoDateRange rejects inverted or malformed ranges", () => {
    expect(requireIsoDateRange("2026-01-01", "2026-02-01")).toEqual({
      start: "2026-01-01",
      end: "2026-02-01",
    });
    expect(() => requireIsoDateRange("Jan 2026", "2026-02-01")).toThrow(/start/);
    expect(() => requireIsoDateRange("2026-03-01", "2026-01-01")).toThrow(/end before/i);
  });

  it("projects Gantt bars from timing labels without inventing undated tactics", () => {
    const activities = projectGanttFromTactics({
      tactics: [
        { id: "T-q", validated: true, timing: "Q1 2026" },
        { id: "T-iso", validated: true, start: "2026-04-01", end: "2026-09-01" },
        { id: "T-missing", validated: true },
        { id: "T-draft", validated: false, timing: "2027" },
      ],
    });
    expect(activities).toEqual([
      {
        id: "ACT-T-q",
        tactic_id: "T-q",
        start: "2026-01-01",
        end: "2026-03-31",
        depends_on: [],
      },
      {
        id: "ACT-T-iso",
        tactic_id: "T-iso",
        start: "2026-04-01",
        end: "2026-09-01",
        depends_on: [],
      },
    ]);
  });
});
