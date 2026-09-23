import { describe, expect, it } from "vitest";
import { registerAccuracyStack } from "@/accuracy";
import { projectWorkspaceGantt } from "@/accuracy/modules/gantt-project/save-final";
import {
  applyClaimValidation,
  claimMetadata,
  insertClaim,
  listClaims,
  setTacticTiming,
} from "@/accuracy/store/claim-store";
import { upsertCoverageDecision } from "@/accuracy/store/coverage-store";
import { createOrganization, createWorkspace } from "@/accuracy/store/tenant";
import { ensureAccuracySchema } from "@/accuracy/store/db";
import { POST as postTiming } from "@/app/api/accuracy/claims/timing/route";
import { POST as postCoverage } from "@/app/api/accuracy/coverage/route";

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

describe("coverage → Gantt date continuity", () => {
  it("setTacticTiming writes ISO dates that projectWorkspaceGantt reads", async () => {
    registerAccuracyStack();
    const { workspace_id } = await freshWorkspace("timing-core");
    const tactic = await insertClaim({
      workspace_id,
      claim_type: "tactic",
      statement: "Registry study VEL-REG-01",
      validated: true,
      status: "validated",
      metadata: { source_badge: "cdp" },
    });

    await setTacticTiming({
      workspace_id,
      claim_id: tactic.id,
      start: "2026-02-01",
      end: "2026-11-01",
      rationale: "From CDP timing grid",
    });

    const projected = await projectWorkspaceGantt(workspace_id);
    expect(projected.activities).toHaveLength(1);
    expect(projected.activities[0]).toMatchObject({
      tactic_id: tactic.id,
      start: "2026-02-01",
      end: "2026-11-01",
    });
  });

  it("coverage decide with start/end flows dates into Gantt after validation", async () => {
    registerAccuracyStack();
    const { workspace_id } = await freshWorkspace("cov-gantt");
    const gap = await insertClaim({
      workspace_id,
      claim_type: "gap",
      statement: "Need OS in biomarker-high",
      validated: true,
      status: "open",
      metadata: { external_id: "G1" },
    });
    const tactic = await insertClaim({
      workspace_id,
      claim_type: "tactic",
      statement: "OS follow-up cohort",
      validated: false,
      status: "planned",
      metadata: { gap_ids: ["G1"], source_badge: "ideate" },
    });

    await upsertCoverageDecision({
      workspace_id,
      gap_id: gap.id,
      tactic_id: tactic.id,
      overall: "covers",
      rationale: "Tactic is the planned generating activity for this gap",
      start: "2026-03-01",
      end: "2027-03-01",
    });

    await applyClaimValidation({
      workspace_id,
      claim_ids: [tactic.id],
      action: "validate",
      rationale: "Inventory-backed planned study",
      actor: { name: "test", function: "medical_affairs" },
    });

    const reloaded = await listClaims(workspace_id, { claim_type: "tactic" });
    const meta = claimMetadata(reloaded.find((t) => t.id === tactic.id)!);
    expect(meta.start).toBe("2026-03-01");
    expect(meta.end).toBe("2027-03-01");

    const projected = await projectWorkspaceGantt(workspace_id);
    expect(projected.activities).toEqual([
      expect.objectContaining({
        tactic_id: tactic.id,
        start: "2026-03-01",
        end: "2027-03-01",
      }),
    ]);
  });

  it("POST /api/accuracy/claims/timing rejects gaps and inverted ranges", async () => {
    registerAccuracyStack();
    const { workspace_id } = await freshWorkspace("timing-api");
    const gap = await insertClaim({
      workspace_id,
      claim_type: "gap",
      statement: "A gap cannot hold Gantt dates",
      validated: true,
    });
    const tactic = await insertClaim({
      workspace_id,
      claim_type: "tactic",
      statement: "Dated tactic",
      validated: true,
      metadata: {},
    });

    const gapRes = await postTiming(
      new Request("http://localhost/api/accuracy/claims/timing", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspace_id,
          claim_id: gap.id,
          start: "2026-01-01",
          end: "2026-06-01",
          rationale: "Should fail for gaps",
        }),
      }),
    );
    expect(gapRes.status).toBe(400);

    const badRange = await postTiming(
      new Request("http://localhost/api/accuracy/claims/timing", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspace_id,
          claim_id: tactic.id,
          start: "2027-01-01",
          end: "2026-01-01",
          rationale: "Inverted range",
        }),
      }),
    );
    expect(badRange.status).toBe(400);

    const ok = await postTiming(
      new Request("http://localhost/api/accuracy/claims/timing", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspace_id,
          claim_id: tactic.id,
          start: "2026-01-01",
          end: "2026-06-01",
          rationale: "From plan timing grid",
        }),
      }),
    );
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { ok: boolean; start: string; end: string };
    expect(body).toMatchObject({ ok: true, start: "2026-01-01", end: "2026-06-01" });
  });

  it("POST /api/accuracy/coverage accepts optional dates and projects them", async () => {
    registerAccuracyStack();
    const { workspace_id } = await freshWorkspace("cov-api-dates");
    const gap = await insertClaim({
      workspace_id,
      claim_type: "gap",
      statement: "Gap for coverage API dates",
      validated: true,
      metadata: { external_id: "Gx" },
    });
    const tactic = await insertClaim({
      workspace_id,
      claim_type: "tactic",
      statement: "Tactic for coverage API dates",
      validated: true,
      status: "validated",
      metadata: { gap_ids: ["Gx"] },
    });

    const res = await postCoverage(
      new Request("http://localhost/api/accuracy/coverage", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspace_id,
          gap_id: gap.id,
          tactic_id: tactic.id,
          overall: "partial",
          rationale: "Partial cover with known timing",
          start: "2026-07-01",
          end: "2026-12-15",
        }),
      }),
    );
    expect(res.status).toBe(200);

    const projected = await projectWorkspaceGantt(workspace_id);
    expect(projected.activities[0]).toMatchObject({
      tactic_id: tactic.id,
      start: "2026-07-01",
      end: "2026-12-15",
    });
  });
});
