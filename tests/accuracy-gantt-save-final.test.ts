import { describe, expect, it } from "vitest";
import {
  activityIdForTactic,
  assertSaveFinalActivities,
  projectGanttFromTactics,
} from "@/accuracy/modules/gantt-project/engine";
import {
  projectWorkspaceGantt,
  saveFinalGanttPlan,
} from "@/accuracy/modules/gantt-project/save-final";
import { insertClaim } from "@/accuracy/store/claim-store";
import { latestAccuracyPlan } from "@/accuracy/store/plan-store";
import { createOrganization, createWorkspace } from "@/accuracy/store/tenant";
import { ensureAccuracySchema } from "@/accuracy/store/db";
import { registerAccuracyStack } from "@/accuracy";

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

describe("gantt save-final guard", () => {
  it("rejects empty activity lists", () => {
    expect(() => assertSaveFinalActivities([], ["T1"])).toThrow(/no activities/i);
  });

  it("rejects bars bound to non-validated tactics", () => {
    expect(() =>
      assertSaveFinalActivities(
        [
          {
            id: activityIdForTactic("T1"),
            tactic_id: "T1",
            start: "2026-01-01",
            end: "2026-06-01",
            readout: null,
            depends_on: [],
            gap_ids: [],
          },
        ],
        ["T2"],
      ),
    ).toThrow(/not validated/i);
  });

  it("accepts bars that bind only to validated tactics", () => {
    expect(() =>
      assertSaveFinalActivities(
        [
          {
            id: activityIdForTactic("T1"),
            tactic_id: "T1",
            start: "2026-01-01",
            end: "2026-06-01",
            readout: null,
            depends_on: [],
            gap_ids: [],
          },
        ],
        ["T1"],
      ),
    ).not.toThrow();
  });

  it("projects workspace tactics without inventing draft bars", async () => {
    registerAccuracyStack();
    const { workspace_id } = await freshWorkspace("proj");
    await insertClaim({
      workspace_id,
      claim_type: "tactic",
      statement: "Validated registry",
      validated: true,
      status: "validated",
      metadata: { start: "2026-01-01", end: "2026-06-01", source_badge: "cdp" },
    });
    await insertClaim({
      workspace_id,
      claim_type: "tactic",
      statement: "Draft only",
      validated: false,
      metadata: { start: "2026-02-01", end: "2026-08-01", source_badge: "draft" },
    });
    await insertClaim({
      workspace_id,
      claim_type: "tactic",
      statement: "Validated but undated",
      validated: true,
      status: "validated",
      metadata: { source_badge: "heor" },
    });

    const projected = await projectWorkspaceGantt(workspace_id);
    expect(projected.activities).toHaveLength(1);
    expect(projected.validated_tactic_count).toBe(2);
    expect(projected.activities[0]?.start).toBe("2026-01-01");
  });

  it("saves a final snapshot only from validated dated tactics", async () => {
    registerAccuracyStack();
    const { workspace_id } = await freshWorkspace("final");
    await insertClaim({
      workspace_id,
      claim_type: "tactic",
      statement: "Pivotal follow-up",
      validated: true,
      status: "validated",
      metadata: {
        start: "2026-03-01",
        end: "2027-03-01",
        depends_on: [],
        source_badge: "pivotal",
      },
    });

    const { plan, activities } = await saveFinalGanttPlan({
      workspace_id,
      status: "final",
      note: "Signed off after ledger review",
      actor: { name: "reviewer", function: "medical_affairs" },
    });

    expect(plan.status).toBe("final");
    expect(plan.version).toBe(1);
    expect(activities).toHaveLength(1);
    expect(plan.snapshot.activities).toEqual(activities);

    const latest = await latestAccuracyPlan(workspace_id);
    expect(latest?.id).toBe(plan.id);
    expect(latest?.note).toMatch(/ledger review/);
  });

  it("refuses save-final when no validated dated tactics exist", async () => {
    registerAccuracyStack();
    const { workspace_id } = await freshWorkspace("empty-final");
    await insertClaim({
      workspace_id,
      claim_type: "tactic",
      statement: "Draft undated",
      validated: false,
    });

    await expect(
      saveFinalGanttPlan({
        workspace_id,
        note: "Trying anyway",
        actor: { name: "reviewer", function: "medical_affairs" },
      }),
    ).rejects.toThrow(/no activities/i);
  });

  it("engine projection stays aligned with save-final inputs", () => {
    const activities = projectGanttFromTactics({
      tactics: [
        { id: "T-a", validated: true, start: "2026-01-01", end: "2026-04-01" },
        { id: "T-b", validated: false, start: "2026-01-01", end: "2026-04-01" },
      ],
    });
    expect(() => assertSaveFinalActivities(activities, ["T-a"])).not.toThrow();
    expect(() => assertSaveFinalActivities(activities, [])).toThrow(/not validated/i);
  });
});
