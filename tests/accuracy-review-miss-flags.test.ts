import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerAccuracyStack, runAccuracyModule } from "@/accuracy";
import type { CompletenessAuditOutput } from "@/accuracy/modules/completeness-audit/module";
import { insertClaim, listClaims } from "@/accuracy/store/claim-store";
import { listMissFlagActions, recordMissFlagAction } from "@/accuracy/store/miss-flag-store";
import { persistParseBlocks } from "@/accuracy/store/parse-store";
import { insertSourceFile } from "@/accuracy/store/source-store";
import { createOrganization, createWorkspace } from "@/accuracy/store/tenant";

registerAccuracyStack();

const actor = { name: "test", function: "medical_affairs" as const };

describe("accuracy review miss-flag API path (module + store)", () => {
  let workspace_id = "";
  let source_file_id = "";
  let org_id = "";

  beforeAll(async () => {
    org_id = await createOrganization("Review miss-flag test org");
    workspace_id = await createWorkspace({
      org_id,
      name: "Review miss-flag WS",
      slug: `review-mf-${Date.now().toString(36)}`,
    });
    const source = await insertSourceFile({
      workspace_id,
      org_id,
      filename: "demo-plan.txt",
      mime: "text/plain",
      checksum: `chk-${Date.now()}`,
      doc_role: "medical",
    });
    source_file_id = source.id;
    await persistParseBlocks({
      workspace_id,
      source_file_id,
      parser: "local_structured",
      blocks: [
        {
          id: `${source_file_id}-B001`,
          source_file_id,
          index: 0,
          kind: "prose",
          heading: null,
          text: "Unmet evidence need for real-world pneumonitis monitoring outside academic centres after month six.",
        },
        {
          id: `${source_file_id}-B002`,
          source_file_id,
          index: 1,
          kind: "prose",
          heading: null,
          text: "A single-arm chart review in patients aged 65 and over is already underway in two EU5 centres.",
        },
      ],
    });
    await insertClaim({
      workspace_id,
      claim_type: "tactic",
      statement:
        "A single-arm chart review in patients aged 65 and over is already underway in two EU5 centres.",
      source_file_id,
      metadata: {
        provenance: [
          {
            source_file_id,
            block_id: `${source_file_id}-B002`,
            quote: "chart review in patients aged 65",
          },
        ],
      },
    });
  });

  afterAll(async () => {
    // Tables are shared; leave fixture workspace for inspection if needed.
  });

  it("runs completeness_audit and surfaces the uncovered block", async () => {
    const result = await runAccuracyModule<CompletenessAuditOutput>({
      call_kind: "completeness_audit",
      agent_role: "none",
      input: { workspace_id },
      actor,
      org_id,
      workspace_id,
    });
    expect(result.output.scanned_blocks).toBe(2);
    expect(result.output.open_flags).toBeGreaterThanOrEqual(1);
    expect(result.output.flags.some((f) => f.block_id.endsWith("-B001"))).toBe(true);
    expect(result.output.flags.every((f) => !f.block_id.endsWith("-B002"))).toBe(true);
  });

  it("promote records action and inserts a draft claim with provenance", async () => {
    const block_id = `${source_file_id}-B001`;
    const claim = await insertClaim({
      workspace_id,
      claim_type: "gap",
      statement:
        "Unmet evidence need for real-world pneumonitis monitoring outside academic centres after month six.",
      source_file_id,
      metadata: {
        origin: "completeness_audit",
        provenance: [
          {
            source_file_id,
            block_id,
            quote: "pneumonitis monitoring outside academic",
          },
        ],
      },
    });
    await recordMissFlagAction({
      workspace_id,
      block_id,
      action: "promote",
      suggested: "gap",
      claim_id: claim.id,
      rationale: "Promote uncovered pneumonitis monitoring need from parse block",
      actor,
    });
    const actions = await listMissFlagActions(workspace_id);
    expect(actions.some((a) => a.block_id === block_id && a.action === "promote")).toBe(true);

    const rerun = await runAccuracyModule<CompletenessAuditOutput>({
      call_kind: "completeness_audit",
      agent_role: "none",
      input: { workspace_id },
      actor,
      org_id,
      workspace_id,
    });
    expect(rerun.output.flags.every((f) => f.block_id !== block_id)).toBe(true);

    const claims = await listClaims(workspace_id, { claim_type: "gap" });
    expect(claims.some((c) => c.id === claim.id)).toBe(true);
  });
});
