import { describe, expect, it } from "vitest";
import { POST as assistPost } from "@/app/api/accuracy/coverage/assist/route";
import { registerAccuracyStack } from "@/accuracy";
import { insertClaim } from "@/accuracy/store/claim-store";
import { ensureAccuracySchema } from "@/accuracy/store/db";
import { createOrganization, createWorkspace } from "@/accuracy/store/tenant";

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

async function postAssist(body: Record<string, unknown>) {
  return assistPost(
    new Request("http://localhost/api/accuracy/coverage/assist", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("accuracy coverage assist API", () => {
  it("rejects unknown workspace and mismatched claim types", async () => {
    registerAccuracyStack();
    const missing = await postAssist({
      workspace_id: "ws-missing",
      gap_id: "gap_x",
      tactic_id: "tac_x",
    });
    expect(missing.status).toBe(404);

    const { workspace_id } = await freshWorkspace("cov-assist-bad");
    const gap = await insertClaim({
      workspace_id,
      claim_type: "gap",
      statement: "Need OS data",
    });
    const badType = await postAssist({
      workspace_id,
      gap_id: gap.id,
      tactic_id: gap.id,
    });
    expect(badType.status).toBe(400);
    const body = (await badType.json()) as { error?: string };
    expect(body.error).toMatch(/tactic/i);
  });

  it("returns stub suggestion under SYNAPSE_TEST_STUB_LLM without persisting", async () => {
    expect(process.env.SYNAPSE_TEST_STUB_LLM).toBe("1");
    registerAccuracyStack();
    const { workspace_id } = await freshWorkspace("cov-assist-stub");
    const gap = await insertClaim({
      workspace_id,
      claim_type: "gap",
      statement: "Need comparative OS in 1L NSCLC",
      metadata: {
        provenance: [{ source_file_id: "src-1", block_id: "B1", quote: "Need OS" }],
      },
    });
    const tactic = await insertClaim({
      workspace_id,
      claim_type: "tactic",
      statement: "VEL-REG-01",
      metadata: {
        provenance: [{ source_file_id: "src-1", block_id: "B2", quote: "Registry" }],
        gap_ids: [gap.id],
      },
    });

    const res = await postAssist({
      workspace_id,
      gap_id: gap.id,
      tactic_id: tactic.id,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok?: boolean;
      mode?: string;
      suggestion?: {
        overall: string;
        schema_overall: string;
        rationale: string;
        confidence: number;
      };
      block_bundle_ids?: string[];
    };
    expect(json.ok).toBe(true);
    expect(json.mode).toBe("stub");
    expect(json.suggestion?.schema_overall).toBe("not_relevant");
    expect(json.suggestion?.overall).toBe("none");
    expect(json.suggestion?.confidence).toBe(0);
    expect(json.block_bundle_ids).toEqual(["B1", "B2"]);
  });
});
