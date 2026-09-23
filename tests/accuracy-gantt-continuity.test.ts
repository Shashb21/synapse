import { describe, expect, it } from "vitest";
import {
  activityIdForTactic,
  coverageCountsTowardGantt,
  dependenciesRespectReadouts,
  projectGanttFromTactics,
} from "@/accuracy/modules/gantt-project/engine";
import { projectWorkspaceGantt } from "@/accuracy/modules/gantt-project/save-final";
import { insertClaim } from "@/accuracy/store/claim-store";
import { upsertCoverageDecision } from "@/accuracy/store/coverage-store";
import { createOrganization, createWorkspace } from "@/accuracy/store/tenant";
import { ensureAccuracySchema } from "@/accuracy/store/db";
import { registerAccuracyStack } from "@/accuracy";

function spanDays(start: string, end: string): number {
  return (
    (Date.parse(`${end.slice(0, 10)}T00:00:00Z`) -
      Date.parse(`${start.slice(0, 10)}T00:00:00Z`)) /
    86_400_000
  );
}

async function freshWorkspace(label: string) {
  await ensureAccuracySchema();
  const org_id = await createOrganization(`org-${label}-${Date.now()}`);
  const workspace_id = await createWorkspace({
    org_id,
    name: `WS ${label}`,
    slug: `${label}-${Date.now()}`,
  });
  return { org_id, workspace_id };
}

describe("gantt coverage → date continuity", () => {
  it("treats covers/full/partial as counting and none/not_relevant as not", () => {
    expect(coverageCountsTowardGantt("covers", true)).toBe(true);
    expect(coverageCountsTowardGantt("full", true)).toBe(true);
    expect(coverageCountsTowardGantt("partial", true)).toBe(true);
    expect(coverageCountsTowardGantt("limited", true)).toBe(true);
    expect(coverageCountsTowardGantt("none", true)).toBe(false);
    expect(coverageCountsTowardGantt("not_relevant", true)).toBe(false);
    expect(coverageCountsTowardGantt("covers", false)).toBe(false);
  });

  it("shifts a successor so it starts on the upstream readout and keeps duration", () => {
    const activities = projectGanttFromTactics({
      tactics: [
        {
          id: "T-study",
          validated: true,
          start: "2026-01-01",
          end: "2026-06-01",
          readout: "2026-07-15",
        },
        {
          id: "T-pub",
          validated: true,
          start: "2026-02-01",
          end: "2026-04-01",
          readout: "2026-04-20",
          depends_on: ["T-study"],
        },
      ],
    });
    const study = activities.find((row) => row.tactic_id === "T-study")!;
    const pub = activities.find((row) => row.tactic_id === "T-pub")!;
    expect(study.start).toBe("2026-01-01");
    expect(study.readout).toBe("2026-07-15");
    expect(pub.start).toBe("2026-07-15");
    expect(spanDays(pub.start, pub.end)).toBe(spanDays("2026-02-01", "2026-04-01"));
    expect(spanDays(pub.start, pub.readout!)).toBe(spanDays("2026-02-01", "2026-04-20"));
    expect(dependenciesRespectReadouts(activities)).toBe(true);
  });

  it("gates on end when the upstream has no sourced readout", () => {
    const activities = projectGanttFromTactics({
      tactics: [
        { id: "A", validated: true, start: "2026-01-01", end: "2026-03-01" },
        {
          id: "B",
          validated: true,
          start: "2026-01-15",
          end: "2026-02-15",
          depends_on: ["A"],
        },
      ],
    });
    expect(activities.find((row) => row.tactic_id === "B")?.start).toBe("2026-03-01");
    expect(dependenciesRespectReadouts(activities)).toBe(true);
  });

  it("does not invent dates when a successor is already continuous", () => {
    const activities = projectGanttFromTactics({
      tactics: [
        {
          id: "A",
          validated: true,
          start: "2026-01-01",
          end: "2026-03-01",
          readout: "2026-03-15",
        },
        {
          id: "B",
          validated: true,
          start: "2026-04-01",
          end: "2026-06-01",
          readout: "2026-06-15",
          depends_on: ["A"],
        },
      ],
    });
    const b = activities.find((row) => row.tactic_id === "B")!;
    expect(b.start).toBe("2026-04-01");
    expect(b.end).toBe("2026-06-01");
    expect(b.readout).toBe("2026-06-15");
  });

  it("infers dissemination waits on generating tactics that cover the same gap", () => {
    const activities = projectGanttFromTactics({
      tactics: [
        {
          id: "T-rwe",
          validated: true,
          start: "2026-01-01",
          end: "2026-06-01",
          readout: "2026-08-01",
          tactic_type: "rwe_study",
        },
        {
          id: "T-pub",
          validated: true,
          start: "2026-02-01",
          end: "2026-03-01",
          tactic_type: "publication",
        },
      ],
      coverages: [
        { gap_id: "G-ce", tactic_id: "T-rwe", overall: "covers", validated: true },
        { gap_id: "G-ce", tactic_id: "T-pub", overall: "partial", validated: true },
      ],
    });
    const pub = activities.find((row) => row.tactic_id === "T-pub")!;
    expect(pub.gap_ids).toEqual(["G-ce"]);
    expect(pub.depends_on).toEqual([activityIdForTactic("T-rwe")]);
    expect(pub.start).toBe("2026-08-01");
    expect(dependenciesRespectReadouts(activities)).toBe(true);
  });

  it("ignores unvalidated or not-relevant coverage when inferring joins", () => {
    const activities = projectGanttFromTactics({
      tactics: [
        {
          id: "T-rwe",
          validated: true,
          start: "2026-01-01",
          end: "2026-06-01",
          tactic_type: "rwe_study",
        },
        {
          id: "T-pub",
          validated: true,
          start: "2026-02-01",
          end: "2026-03-01",
          tactic_type: "publication",
        },
      ],
      coverages: [
        { gap_id: "G-ce", tactic_id: "T-rwe", overall: "covers", validated: false },
        { gap_id: "G-ce", tactic_id: "T-pub", overall: "not_relevant", validated: true },
      ],
    });
    const pub = activities.find((row) => row.tactic_id === "T-pub")!;
    expect(pub.gap_ids).toEqual([]);
    expect(pub.depends_on).toEqual([]);
    expect(pub.start).toBe("2026-02-01");
  });

  it("gates a child-gap tactic on tactics covering the parent gap", () => {
    const activities = projectGanttFromTactics({
      tactics: [
        {
          id: "T-parent",
          validated: true,
          start: "2026-01-01",
          end: "2026-04-01",
          readout: "2026-05-01",
          tactic_type: "registry",
        },
        {
          id: "T-child",
          validated: true,
          start: "2026-02-01",
          end: "2026-05-01",
          tactic_type: "chart_review",
        },
      ],
      gaps: [{ id: "G-child", parent_gap_id: "G-parent" }, { id: "G-parent" }],
      coverages: [
        { gap_id: "G-parent", tactic_id: "T-parent", overall: "full", validated: true },
        { gap_id: "G-child", tactic_id: "T-child", overall: "partial", validated: true },
      ],
    });
    const child = activities.find((row) => row.tactic_id === "T-child")!;
    expect(child.depends_on).toEqual([activityIdForTactic("T-parent")]);
    expect(child.start).toBe("2026-05-01");
  });

  it("does not invent bars or dates from coverage alone", () => {
    const activities = projectGanttFromTactics({
      tactics: [
        { id: "T-dated", validated: true, start: "2026-01-01", end: "2026-03-01" },
        { id: "T-undated", validated: true, tactic_type: "publication" },
        {
          id: "T-draft",
          validated: false,
          start: "2026-01-01",
          end: "2026-12-01",
          tactic_type: "rwe_study",
        },
      ],
      coverages: [
        { gap_id: "G1", tactic_id: "T-dated", overall: "covers", validated: true },
        { gap_id: "G1", tactic_id: "T-undated", overall: "covers", validated: true },
        { gap_id: "G1", tactic_id: "T-draft", overall: "covers", validated: true },
      ],
    });
    expect(activities.map((row) => row.tactic_id)).toEqual(["T-dated"]);
    expect(activities[0]?.start).toBe("2026-01-01");
    expect(activities[0]?.end).toBe("2026-03-01");
  });

  it("chains continuity through two successors without inventing studies", () => {
    const activities = projectGanttFromTactics({
      tactics: [
        {
          id: "T1",
          validated: true,
          start: "2026-01-01",
          end: "2026-02-01",
          readout: "2026-03-01",
        },
        {
          id: "T2",
          validated: true,
          start: "2026-01-15",
          end: "2026-02-15",
          depends_on: ["T1"],
        },
        {
          id: "T3",
          validated: true,
          start: "2026-01-20",
          end: "2026-02-20",
          depends_on: ["T2"],
        },
      ],
    });
    expect(activities.find((row) => row.tactic_id === "T2")?.start).toBe("2026-03-01");
    const t2 = activities.find((row) => row.tactic_id === "T2")!;
    const t3 = activities.find((row) => row.tactic_id === "T3")!;
    expect(t3.start >= t2.end).toBe(true);
    expect(dependenciesRespectReadouts(activities)).toBe(true);
  });

  it("does not hang or invent dates on a cyclic dependency", () => {
    const activities = projectGanttFromTactics({
      tactics: [
        {
          id: "T-a",
          validated: true,
          start: "2026-01-01",
          end: "2026-02-01",
          depends_on: ["T-b"],
        },
        {
          id: "T-b",
          validated: true,
          start: "2026-03-01",
          end: "2026-04-01",
          depends_on: ["T-a"],
        },
      ],
    });
    expect(activities).toHaveLength(2);
    expect(activities.find((row) => row.tactic_id === "T-a")?.start).toBe("2026-01-01");
    expect(activities.find((row) => row.tactic_id === "T-b")?.start).toBe("2026-03-01");
  });
});

describe("workspace gantt reads coverage joins", () => {
  it("projects continuous bars from stored joins and tactic dates", async () => {
    registerAccuracyStack();
    const { workspace_id } = await freshWorkspace("gantt-cont");
    const study = await insertClaim({
      workspace_id,
      claim_type: "tactic",
      statement: "VEL-REG-01",
      validated: true,
      status: "validated",
      metadata: {
        start: "2026-01-01",
        end: "2026-06-01",
        readout: "2026-09-01",
        tactic_type: "registry",
      },
    });
    const pub = await insertClaim({
      workspace_id,
      claim_type: "tactic",
      statement: "Registry manuscript",
      validated: true,
      status: "validated",
      metadata: {
        start: "2026-03-01",
        end: "2026-05-01",
        tactic_type: "publication",
      },
    });
    const gap = await insertClaim({
      workspace_id,
      claim_type: "gap",
      statement: "Need RWE in 1L",
      validated: true,
      status: "validated",
    });
    await upsertCoverageDecision({
      workspace_id,
      gap_id: gap.id,
      tactic_id: study.id,
      overall: "covers",
      rationale: "Registry covers the RWE gap",
    });
    await upsertCoverageDecision({
      workspace_id,
      gap_id: gap.id,
      tactic_id: pub.id,
      overall: "partial",
      rationale: "Manuscript disseminates the registry",
    });

    const projected = await projectWorkspaceGantt(workspace_id);
    expect(projected.activities).toHaveLength(2);
    const pubBar = projected.activities.find((row) => row.tactic_id === pub.id)!;
    expect(pubBar.gap_ids).toEqual([gap.id]);
    expect(pubBar.depends_on).toEqual([activityIdForTactic(study.id)]);
    expect(pubBar.start).toBe("2026-09-01");
    expect(dependenciesRespectReadouts(projected.activities)).toBe(true);
  });
});
