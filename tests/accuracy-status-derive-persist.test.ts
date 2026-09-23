import { describe, expect, it } from "vitest";
import { registerAccuracyStack, runAccuracyModule } from "@/accuracy";
import { normalizeCoverageOverall } from "@/accuracy/modules/status-derive/module";
import { insertClaim, listClaims, claimMetadata } from "@/accuracy/store/claim-store";
import { accuracyDb, ensureAccuracySchema } from "@/accuracy/store/db";
import * as t from "@/accuracy/store/schema";
import { createOrganization, createWorkspace } from "@/accuracy/store/tenant";
import { newId } from "@/modules/kernel/ids";

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

describe("status-derive after extract wiring", () => {
  it("maps UI coverage overall onto engine enums", () => {
    expect(normalizeCoverageOverall("covers")).toBe("full");
    expect(normalizeCoverageOverall("none")).toBe("not_relevant");
    expect(normalizeCoverageOverall("partial")).toBe("partial");
    expect(normalizeCoverageOverall("unknown")).toBeNull();
  });

  it("persists derived open/partial/addressed onto gap claims", async () => {
    registerAccuracyStack();
    const { org_id, workspace_id } = await freshWorkspace("status-derive");

    const gap = await insertClaim({
      workspace_id,
      claim_type: "gap",
      statement: "Need OS evidence",
      status: "draft",
      validated: true,
      metadata: { external_id: "G1" },
    });
    const tactic = await insertClaim({
      workspace_id,
      claim_type: "tactic",
      statement: "Registry NCT01234567",
      status: "ongoing",
      validated: true,
      metadata: { origin: "inventory" },
    });

    await accuracyDb().insert(t.accuracyCoverageJoins).values({
      id: newId("cov"),
      workspace_id,
      gap_id: gap.id,
      tactic_id: tactic.id,
      overall: "covers",
      dimensions: {},
      confidence: null,
      validated: true,
      rationale: "Full coverage from registry",
    });

    const result = await runAccuracyModule<{
      statuses: Array<{ gap_id: string; status: string }>;
      updated: number;
    }>({
      call_kind: "status_derive",
      input: { workspace_id, persist: true },
      actor: { name: "test", function: "medical_affairs" },
      org_id,
      workspace_id,
    });

    expect(result.output.statuses).toEqual([{ gap_id: gap.id, status: "addressed" }]);
    expect(result.output.updated).toBeGreaterThanOrEqual(1);

    const claims = await listClaims(workspace_id, { claim_type: "gap" });
    const updated = claims.find((c) => c.id === gap.id);
    expect(updated?.status).toBe("addressed");
    expect(claimMetadata(updated!).derived_status).toBe("addressed");
  });
});
