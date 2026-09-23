import { describe, expect, it } from "vitest";
import { registerAccuracyStack, runAccuracyModule } from "@/accuracy";
import { claimMetadata, insertClaim, listClaims } from "@/accuracy/store/claim-store";
import { insertCoverageJoin, listCoverageJoins } from "@/accuracy/store/coverage-store";
import { createOrganization, createWorkspace } from "@/accuracy/store/tenant";
import { ensureAccuracySchema } from "@/accuracy/store/db";
import type { MergeDedupeOutput } from "@/accuracy/modules/merge-dedupe/module";
import type { StatusDeriveOutput } from "@/accuracy/modules/status-derive/module";

const BGB = "beone-bgb-58067-prmt5i";
const TISLE = "beone-tislelizumab-iegp";

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

describe("merge-dedupe + status-derive persistence", () => {
  it("collapses duplicate BGB gaps and keeps Tisle gold rows separate", async () => {
    registerAccuracyStack();
    const { org_id, workspace_id } = await freshWorkspace("merge-gold");

    const keep = await insertClaim({
      workspace_id,
      claim_type: "gap",
      statement: "Need CNS outcomes in EGFR NSCLC",
      metadata: {
        external_id: "NSCLC_CE_01",
        reference_pack_id: BGB,
        provenance: [],
      },
    });
    const dup = await insertClaim({
      workspace_id,
      claim_type: "gap",
      statement: "CNS Differentiation evidence need",
      metadata: {
        external_id: "NSCLC_CE_01",
        reference_pack_id: BGB,
        provenance: [
          { source_file_id: "src-bgb", block_id: "b9", quote: "NSCLC_CE_01 CNS Differentiation" },
        ],
      },
    });
    const tisle = await insertClaim({
      workspace_id,
      claim_type: "gap",
      statement: "Need RWE on long term tislelizumab efficacy in Caucasian patients",
      metadata: {
        external_id: "NSCLC_CE_01",
        reference_pack_id: TISLE,
      },
    });

    const result = await runAccuracyModule<MergeDedupeOutput>({
      call_kind: "merge_dedupe",
      agent_role: "none",
      input: { workspace_id },
      actor: { name: "test", function: "medical_affairs" },
      org_id,
      workspace_id,
    });

    expect(result.output.merged).toBe(1);
    expect(result.output.contradictions).toBe(0);
    expect(result.output.merges[0]?.reason).toBe("identity");

    const claims = await listClaims(workspace_id);
    const merged = claims.find((c) => c.id === dup.id);
    const survivor = claims.find((c) => c.id === keep.id);
    const otherPack = claims.find((c) => c.id === tisle.id);
    expect(merged?.status).toBe("merged");
    expect(claimMetadata(merged!).merged_into).toBe(keep.id);
    expect(claimMetadata(survivor!).external_id).toBe("NSCLC_CE_01");
    expect(claimMetadata(survivor!).reference_pack_id).toBe(BGB);
    expect(otherPack?.status).not.toBe("merged");
    expect(claimMetadata(otherPack!).reference_pack_id).toBe(TISLE);
  });

  it("derives Open/Partial/Addressed from coverage joins and persists computed_status", async () => {
    registerAccuracyStack();
    const { org_id, workspace_id } = await freshWorkspace("status-joins");

    const openGap = await insertClaim({
      workspace_id,
      claim_type: "gap",
      statement: "Open need with no joins",
      metadata: { reference_pack_id: BGB, external_id: "NSCLC_AD_01" },
    });
    const addressedGap = await insertClaim({
      workspace_id,
      claim_type: "gap",
      statement: "CNS outcomes covered by pivotal follow-up",
      metadata: { reference_pack_id: BGB, external_id: "NSCLC_CE_01" },
    });
    const partialGap = await insertClaim({
      workspace_id,
      claim_type: "gap",
      statement: "Proposed-only coverage remains partial",
      metadata: { reference_pack_id: BGB, external_id: "NSCLC_CE_04" },
    });
    const committed = await insertClaim({
      workspace_id,
      claim_type: "tactic",
      statement: "Extended follow-up within pivotal trials",
      status: "ongoing",
      metadata: { tactic_status: "ongoing", reference_pack_id: BGB },
    });
    const proposed = await insertClaim({
      workspace_id,
      claim_type: "tactic",
      statement: "Ideated publication only",
      status: "proposed",
      metadata: { tactic_status: "proposed", reference_pack_id: BGB },
    });

    await insertCoverageJoin({
      workspace_id,
      gap_id: addressedGap.id,
      tactic_id: committed.id,
      overall: "full",
      validated: true,
    });
    await insertCoverageJoin({
      workspace_id,
      gap_id: partialGap.id,
      tactic_id: proposed.id,
      overall: "covers",
      validated: true,
    });

    const derived = await runAccuracyModule<StatusDeriveOutput>({
      call_kind: "status_derive",
      agent_role: "none",
      input: { workspace_id },
      actor: { name: "test", function: "medical_affairs" },
      org_id,
      workspace_id,
    });

    expect(derived.output.open).toBe(1);
    expect(derived.output.partial).toBe(1);
    expect(derived.output.addressed).toBe(1);

    const byId = new Map(derived.output.statuses.map((s) => [s.gap_id, s.status]));
    expect(byId.get(openGap.id)).toBe("open");
    expect(byId.get(addressedGap.id)).toBe("addressed");
    expect(byId.get(partialGap.id)).toBe("partial");

    const reloaded = await listClaims(workspace_id, { claim_type: "gap" });
    expect(claimMetadata(reloaded.find((c) => c.id === addressedGap.id)!).computed_status).toBe(
      "addressed",
    );
    expect(claimMetadata(reloaded.find((c) => c.id === openGap.id)!).computed_status).toBe("open");
    expect(await listCoverageJoins(workspace_id)).toHaveLength(2);
  });
});
