import { describe, expect, it } from "vitest";
import { registerAccuracyStack, runAccuracyModule } from "@/accuracy";
import {
  applyClaimValidation,
  claimMetadata,
  insertClaim,
  listClaims,
  requireValidationRationale,
} from "@/accuracy/store/claim-store";
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

describe("validation gate persistence", () => {
  it("requires a short rationale", () => {
    expect(() => requireValidationRationale("ab")).toThrow(/rationale/i);
    expect(requireValidationRationale("Looks correct")).toBe("Looks correct");
  });

  it("updates accuracy_claims.validated and records rationale on validate", async () => {
    registerAccuracyStack();
    const { workspace_id } = await freshWorkspace("val");
    const claim = await insertClaim({
      workspace_id,
      claim_type: "gap",
      statement: "Need OS by biomarker subgroup",
      metadata: { source_badge: "interview" },
    });
    expect(claim.validated).toBe(false);

    const result = await applyClaimValidation({
      workspace_id,
      claim_ids: [claim.id],
      action: "validate",
      rationale: "Quote matches interview block B2",
      actor: { name: "Ada", function: "medical_affairs" },
    });

    expect(result.updated).toBe(1);
    expect(result.claims[0]?.validated).toBe(true);
    expect(result.claims[0]?.status).toBe("validated");
    expect(claimMetadata(result.claims[0]!).validation?.rationale).toMatch(/interview block/);

    const reloaded = await listClaims(workspace_id);
    expect(reloaded[0]?.validated).toBe(true);
    expect(claimMetadata(reloaded[0]!).validation?.by).toBe("Ada");
  });

  it("rejects claims and clears validated with rationale", async () => {
    registerAccuracyStack();
    const { workspace_id } = await freshWorkspace("rej");
    const claim = await insertClaim({
      workspace_id,
      claim_type: "tactic",
      statement: "Publication plan only",
      validated: true,
      status: "validated",
    });

    const result = await applyClaimValidation({
      workspace_id,
      claim_ids: [claim.id],
      action: "reject",
      rationale: "Dissemination is not evidence generation",
      actor: { name: "Bo", function: "heor" },
    });

    expect(result.claims[0]?.validated).toBe(false);
    expect(result.claims[0]?.status).toBe("rejected");
    expect(claimMetadata(result.claims[0]!).validation?.action).toBe("reject");
  });

  it("runs through validation_gate module and persists", async () => {
    registerAccuracyStack();
    const { org_id, workspace_id } = await freshWorkspace("mod");
    const claim = await insertClaim({
      workspace_id,
      claim_type: "gap",
      statement: "Comparator evidence gap",
    });

    const run = await runAccuracyModule({
      call_kind: "validation_gate",
      agent_role: "none",
      input: {
        workspace_id,
        claim_ids: [claim.id],
        action: "validate",
        rationale: "Confirmed against source table",
      },
      actor: { name: "test", function: "medical_affairs" },
      org_id,
      workspace_id,
    });

    expect((run.output as { validated: number }).validated).toBe(1);
    const rows = await listClaims(workspace_id);
    expect(rows[0]?.validated).toBe(true);
  });

  it("refuses empty claim_ids at the module boundary", async () => {
    registerAccuracyStack();
    const { org_id, workspace_id } = await freshWorkspace("empty");
    await expect(
      runAccuracyModule({
        call_kind: "validation_gate",
        agent_role: "none",
        input: {
          workspace_id,
          claim_ids: [],
          action: "validate",
          rationale: "noop",
        },
        actor: { name: "test", function: "medical_affairs" },
        org_id,
        workspace_id,
      }),
    ).rejects.toThrow();
  });
});
