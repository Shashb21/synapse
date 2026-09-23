import { describe, expect, it } from "vitest";
import {
  inventoryExtractModule,
  inventoryExtractOutputSchema,
  inventoryTacticSchema,
} from "@/accuracy/modules/inventory-extract/module";
import type { AccuracyModuleContext } from "@/accuracy/kernel/contracts";

function stubCtx(): AccuracyModuleContext {
  return {
    org_id: "org-test",
    workspace_id: "ws-test",
    actor: { name: "test", function: "medical_affairs" },
    role: "medical_affairs",
    run: {
      id: "arun-test",
      note: () => {},
      step: async (_name, fn) => await fn(),
      steps: () => [],
    },
    route: {
      call_kind: "inventory_extract",
      role: "proposer",
      provider_id: "xai",
      provider_label: "Grok",
      model: "stub",
      auth: "oauth",
      connected: true,
      params: { temperature: 0, max_tokens: 8192 },
      fallbacks: [],
      degraded: false,
      reason: null,
    },
    complete: async () => {
      throw new Error("complete should not run when SYNAPSE_TEST_STUB_LLM=1");
    },
    noteCost: () => {},
  };
}

describe("inventory extract module", () => {
  it("returns empty tactics under SYNAPSE_TEST_STUB_LLM", async () => {
    expect(process.env.SYNAPSE_TEST_STUB_LLM).toBe("1");
    const result = await inventoryExtractModule.run(
      {
        workspace_id: "ws-test",
        source_file_id: "src-1",
        block_ids: ["blk-1"],
      },
      stubCtx(),
    );
    expect(inventoryExtractOutputSchema.parse(result.output)).toEqual({
      workspace_id: "ws-test",
      source_file_id: "src-1",
      tactics: [],
    });
    expect(result.summary).toContain("SYNAPSE_TEST_STUB_LLM");
  });

  it("calls the connected OAuth LLM when stub is off", async () => {
    const prev = process.env.SYNAPSE_TEST_STUB_LLM;
    process.env.SYNAPSE_TEST_STUB_LLM = "0";
    try {
      const ctx = stubCtx();
      ctx.complete = async () => ({
        raw: JSON.stringify({
          tactics: [
            {
              name: "Phase 3 registrational trial",
              type: "phase3_trial",
              status: "ongoing",
              evidence_question: "Does the drug improve overall survival?",
              origin: "inventory",
              provenance: [
                {
                  source_file_id: "src-1",
                  block_id: "blk-1",
                  quote: "Phase 3 study ongoing in NSCLC",
                },
              ],
            },
          ],
        }),
        usage: { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10 },
      });
      const result = await inventoryExtractModule.run(
        {
          workspace_id: "ws-test",
          source_file_id: "src-1",
          block_ids: ["blk-1"],
        },
        ctx,
      );
      expect(result.output.tactics).toHaveLength(1);
      expect(result.output.tactics[0]?.name).toMatch(/Phase 3/);
      expect(result.output.tactics[0]?.origin).toBe("inventory");
      expect(result.summary).toMatch(/1 tactic/);
    } finally {
      process.env.SYNAPSE_TEST_STUB_LLM = prev;
    }
  });

  it("requires inventory origin and provenance spans on tactics", () => {
    const ok = inventoryTacticSchema.safeParse({
      id: "tac-1",
      name: "Phase 3 registrational trial",
      type: "phase3_trial",
      status: "ongoing",
      evidence_question: "Does the drug improve overall survival?",
      origin: "inventory",
      provenance: [
        {
          source_file_id: "src-1",
          block_id: "blk-1",
          quote: "Phase 3 study ongoing in NSCLC",
        },
      ],
    });
    expect(ok.success).toBe(true);

    const bad = inventoryTacticSchema.safeParse({
      id: "tac-2",
      name: "Ideated study",
      type: "phase3_trial",
      status: "proposed",
      evidence_question: "Question?",
      origin: "ideated",
      provenance: [
        { source_file_id: "src-1", block_id: "blk-1", quote: "x" },
      ],
    });
    expect(bad.success).toBe(false);
  });
});
