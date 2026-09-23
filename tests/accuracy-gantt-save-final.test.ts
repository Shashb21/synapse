import { describe, expect, it } from "vitest";
import {
  activityIdForTactic,
  assertSaveFinalActivities,
  projectGanttFromTactics,
} from "@/accuracy/modules/gantt-project/engine";
import {
  auditBundleFromPlan,
  catalogForActivities,
  projectWorkspaceGantt,
  saveFinalGanttPlan,
  snapshotHashForPlan,
} from "@/accuracy/modules/gantt-project/save-final";
import {
  auditBundleHref,
  canonicalizeGanttSnapshot,
  hashGanttSnapshot,
} from "@/accuracy/modules/gantt-project/snapshot-hash";
import { insertClaim, persistClaimPatch } from "@/accuracy/store/claim-store";
import { insertCoverageJoin } from "@/accuracy/store/coverage-store";
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

  it("persists a snapshot hash and audit bundle link for the frozen Gantt", async () => {
    registerAccuracyStack();
    const { workspace_id } = await freshWorkspace("hash-final");
    const gap = await insertClaim({
      workspace_id,
      claim_type: "gap",
      statement: "Need overall survival in 2L NSCLC",
      validated: true,
      status: "validated",
    });
    const tactic = await insertClaim({
      workspace_id,
      claim_type: "tactic",
      statement: "Pivotal OS follow-up",
      validated: true,
      status: "validated",
      metadata: {
        start: "2026-03-01",
        end: "2027-03-01",
        readout: "2027-06-01",
        source_badge: "pivotal",
      },
    });
    await insertCoverageJoin({
      workspace_id,
      gap_id: gap.id,
      tactic_id: tactic.id,
      overall: "covers",
      validated: true,
    });

    const first = await saveFinalGanttPlan({
      workspace_id,
      status: "final",
      note: "Signed off after ledger review",
      actor: { name: "reviewer", function: "medical_affairs" },
    });

    expect(first.snapshot_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.plan.snapshot.snapshot_hash).toBe(first.snapshot_hash);
    expect(first.plan.snapshot.labels?.map((row) => row.id).sort()).toEqual(
      [gap.id, tactic.id].sort(),
    );
    expect(first.activities[0]?.gap_ids).toEqual([gap.id]);
    expect(first.audit_bundle.href).toBe(
      auditBundleHref({
        workspace_id,
        plan_id: first.plan.id,
        snapshot_hash: first.snapshot_hash,
      }),
    );
    expect(first.audit_bundle.href).toContain(`/accuracy/audit?`);
    expect(first.audit_bundle.href).toContain(`plan_id=${first.plan.id}`);
    expect(first.audit_bundle.href).toContain(`snapshot_hash=${first.snapshot_hash}`);
    expect(auditBundleFromPlan(first.plan)).toEqual(first.audit_bundle);
    expect(snapshotHashForPlan(first.plan)).toBe(first.snapshot_hash);

    const recomputed = hashGanttSnapshot({
      workspace_id,
      activities: first.activities,
      tactic_ids: first.plan.snapshot.tactic_ids,
      counts: first.plan.snapshot.counts,
      labels: first.plan.snapshot.labels,
    });
    expect(recomputed).toBe(first.snapshot_hash);

    const second = await saveFinalGanttPlan({
      workspace_id,
      status: "final",
      note: "Re-affirming the same bars",
      actor: { name: "reviewer", function: "medical_affairs" },
    });
    expect(second.plan.version).toBe(2);
    expect(second.snapshot_hash).toBe(first.snapshot_hash);
    expect(second.audit_bundle.plan_id).not.toBe(first.audit_bundle.plan_id);
  });

  it("changes the snapshot hash when a validated bar changes", async () => {
    registerAccuracyStack();
    const { workspace_id } = await freshWorkspace("hash-change");
    const tactic = await insertClaim({
      workspace_id,
      claim_type: "tactic",
      statement: "Registry extract",
      validated: true,
      status: "validated",
      metadata: { start: "2026-01-01", end: "2026-06-01" },
    });

    const first = await saveFinalGanttPlan({
      workspace_id,
      note: "Initial sign-off of the Gantt",
      actor: { name: "reviewer", function: "medical_affairs" },
    });

    await persistClaimPatch({
      workspace_id,
      claim_id: tactic.id,
      metadata: { start: "2026-02-01", end: "2026-08-01" },
    });

    const second = await saveFinalGanttPlan({
      workspace_id,
      note: "Dates moved after readout review",
      actor: { name: "reviewer", function: "medical_affairs" },
    });
    expect(second.snapshot_hash).not.toBe(first.snapshot_hash);
    expect(second.activities[0]?.start).toBe("2026-02-01");
  });

  it("hashes workspace identity so identical bars differ across workspaces", () => {
    const activities = projectGanttFromTactics({
      tactics: [{ id: "T-a", validated: true, start: "2026-01-01", end: "2026-04-01" }],
    });
    const payload = {
      activities,
      tactic_ids: ["T-a"],
      counts: { activities: 1, validated_tactics: 1 },
    };
    const a = hashGanttSnapshot({ workspace_id: "ws-a", ...payload });
    const b = hashGanttSnapshot({ workspace_id: "ws-b", ...payload });
    expect(a).not.toBe(b);
    expect(canonicalizeGanttSnapshot({ workspace_id: "ws-a", ...payload })).toContain("ws-a");
  });

  it("builds catalog labels only for bars and their covered gaps", () => {
    const activities = projectGanttFromTactics({
      tactics: [
        {
          id: "T1",
          validated: true,
          start: "2026-01-01",
          end: "2026-02-01",
          gap_ids: ["G1"],
        },
      ],
    });
    const labels = catalogForActivities({
      claims: [
        { id: "T1", claim_type: "tactic", statement: "Study" },
        { id: "G1", claim_type: "gap", statement: "Gap" },
        { id: "G2", claim_type: "gap", statement: "Unused" },
      ],
      activities,
    });
    expect(labels.map((row) => row.id)).toEqual(["G1", "T1"]);
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
