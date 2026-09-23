import { describe, expect, it } from "vitest";
import {
  activityIdForTactic,
  assertActivitiesHaveTacticId,
  dependenciesRespectReadouts,
  projectGanttFromTactics,
} from "@/accuracy/modules/gantt-project/engine";
import { registerAccuracyStack, runAccuracyModule } from "@/accuracy";

describe("gantt project engine", () => {
  it("projects validated tactics with start, end, and depends_on", () => {
    const activities = projectGanttFromTactics({
      tactics: [
        {
          id: "T-base",
          validated: true,
          start: "2026-01-01",
          end: "2026-06-01",
          depends_on: [],
        },
        {
          id: "T-follow",
          validated: true,
          start: "2026-02-01",
          end: "2026-08-01",
          depends_on: ["T-base"],
        },
        { id: "T-draft", validated: false, start: "2026-01-01", end: "2026-12-01" },
      ],
    });

    expect(activities).toHaveLength(2);
    expect(activities[0]).toMatchObject({
      id: activityIdForTactic("T-base"),
      tactic_id: "T-base",
      start: "2026-01-01",
      end: "2026-06-01",
      readout: null,
      depends_on: [],
      gap_ids: [],
    });
    expect(activities[1]).toMatchObject({
      tactic_id: "T-follow",
      depends_on: [activityIdForTactic("T-base")],
    });
    expect(activities[1]?.start >= "2026-06-01").toBe(true);
    expect(activities[1]?.readout).toBeNull();
    expect(dependenciesRespectReadouts(activities)).toBe(true);
  });

  it("does not invent bars for tactics missing dates", () => {
    const activities = projectGanttFromTactics({
      tactics: [
        { id: "T1", validated: true, start: "2026-01-01", end: "2026-03-01" },
        { id: "T2", validated: true },
        { id: "T3", validated: false, start: "2026-01-01", end: "2026-03-01" },
      ],
    });
    expect(activities.map((a) => a.tactic_id)).toEqual(["T1"]);
  });

  it("applies activity overrides by tactic_id", () => {
    const activities = projectGanttFromTactics({
      tactics: [{ id: "T1", validated: true, start: "2026-01-01", end: "2026-03-01" }],
      activities: [{ tactic_id: "T1", start: "2026-04-01", end: "2026-09-01" }],
    });
    expect(activities[0]?.start).toBe("2026-04-01");
    expect(activities[0]?.end).toBe("2026-09-01");
  });

  it("rejects activities without tactic_id", () => {
    expect(() =>
      assertActivitiesHaveTacticId([{ tactic_id: "T1" }, { tactic_id: "" }]),
    ).toThrow(/missing tactic_id/);
  });

  it("sorts output deterministically by start then id", () => {
    const first = projectGanttFromTactics({
      tactics: [
        { id: "B", validated: true, start: "2026-02-01", end: "2026-03-01" },
        { id: "A", validated: true, start: "2026-01-01", end: "2026-02-01" },
      ],
    });
    const second = projectGanttFromTactics({
      tactics: [
        { id: "A", validated: true, start: "2026-01-01", end: "2026-02-01" },
        { id: "B", validated: true, start: "2026-02-01", end: "2026-03-01" },
      ],
    });
    expect(first).toEqual(second);
    expect(first.map((a) => a.tactic_id)).toEqual(["A", "B"]);
  });
});

describe("gantt project module run", () => {
  it("runs through accuracy kernel without LLM", async () => {
    registerAccuracyStack();
    const result = await runAccuracyModule({
      call_kind: "gantt_project",
      input: {
        workspace_id: "ws-gantt",
        tactics: [
          { id: "T1", validated: true, start: "2026-01-01", end: "2026-06-01", depends_on: [] },
        ],
      },
      actor: { name: "test", function: "medical_affairs" },
      org_id: "org-test",
      workspace_id: "ws-gantt",
    });
    const output = result.output as { activities: { tactic_id: string }[] };
    expect(output.activities).toHaveLength(1);
    expect(output.activities[0]?.tactic_id).toBe("T1");
    expect(result.cost_usd).toBe(0);
  });

  it("rejects override rows missing tactic_id at input parse", async () => {
    registerAccuracyStack();
    await expect(
      runAccuracyModule({
        call_kind: "gantt_project",
        input: {
          workspace_id: "ws-gantt",
          tactics: [],
          activities: [{ tactic_id: "", start: "2026-01-01", end: "2026-02-01" }],
        },
        actor: { name: "test", function: "medical_affairs" },
        org_id: "org-test",
        workspace_id: "ws-gantt",
      }),
    ).rejects.toThrow(/tactic_id/);
  });
});
