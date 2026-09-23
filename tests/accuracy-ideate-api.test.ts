import { describe, expect, it } from "vitest";
import { POST as ideatePost } from "@/app/api/accuracy/ideate/route";
import { registerAccuracyStack } from "@/accuracy";
import { claimMetadata, insertClaim, listClaims } from "@/accuracy/store/claim-store";
import { createOrganization, createWorkspace } from "@/accuracy/store/tenant";
import { ensureAccuracySchema } from "@/accuracy/store/db";

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

async function postIdeate(body: Record<string, unknown>) {
  return ideatePost(
    new Request("http://localhost/api/accuracy/ideate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("accuracy ideate API stub", () => {
  it("rejects medium-priority gaps", async () => {
    registerAccuracyStack();
    const { workspace_id } = await freshWorkspace("ideate-med");
    const gap = await insertClaim({
      workspace_id,
      claim_type: "gap",
      statement: "Medium priority evidence need that should not ideate",
      validated: true,
      status: "open",
      metadata: { priority: "medium" },
    });

    const res = await postIdeate({
      workspace_id,
      gap_id: gap.id,
      title: "Proposed registry expansion study",
      rationale: "Would fill residual medium gap",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/high-priority/i);
  });

  it("rejects unvalidated high-priority gaps", async () => {
    registerAccuracyStack();
    const { workspace_id } = await freshWorkspace("ideate-unval");
    const gap = await insertClaim({
      workspace_id,
      claim_type: "gap",
      statement: "High priority but not validated yet",
      validated: false,
      status: "open",
      metadata: { priority: "high" },
    });

    const res = await postIdeate({
      workspace_id,
      gap_id: gap.id,
      title: "Proposed biomarker RWE study",
      rationale: "Should require validation first",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/validated/i);
  });

  it("creates an ideated tactic for a validated high-priority gap", async () => {
    registerAccuracyStack();
    const { workspace_id } = await freshWorkspace("ideate-ok");
    const gap = await insertClaim({
      workspace_id,
      claim_type: "gap",
      statement: "Need OS evidence in biomarker-high subgroup",
      validated: true,
      status: "open",
      metadata: { priority: "high", external_id: "G-HIGH-1" },
    });

    const res = await postIdeate({
      workspace_id,
      gap_id: gap.id,
      title: "Prospective OS follow-up in biomarker-high cohort",
      rationale: "No inventory tactic covers this residual high gap",
      start: "2026-03-01",
      end: "2027-09-01",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; tactic_id: string };
    expect(body.ok).toBe(true);
    expect(body.tactic_id).toMatch(/^tac_/);

    const tactics = await listClaims(workspace_id, { claim_type: "tactic" });
    const created = tactics.find((t) => t.id === body.tactic_id);
    expect(created).toBeTruthy();
    expect(created?.status).toBe("proposed");
    const meta = claimMetadata(created!);
    expect(meta.origin).toBe("ideated");
    expect(meta.gap_ids).toEqual(["G-HIGH-1"]);
    expect(meta.ideation_rationale).toMatch(/inventory/);
  });
});
