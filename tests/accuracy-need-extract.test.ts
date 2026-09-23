import { describe, expect, it } from "vitest";
import {
  needExtractModule,
  needExtractOutputSchema,
  needGapSchema,
  scoreGapIdRecall,
} from "@/accuracy/modules/need-extract/module";
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
      call_kind: "need_extract",
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

describe("need extract module", () => {
  it("returns empty gaps under SYNAPSE_TEST_STUB_LLM", async () => {
    expect(process.env.SYNAPSE_TEST_STUB_LLM).toBe("1");
    const result = await needExtractModule.run(
      {
        workspace_id: "ws-test",
        source_file_id: "src-1",
        block_ids: ["blk-1"],
      },
      stubCtx(),
    );
    expect(needExtractOutputSchema.parse(result.output)).toEqual({
      workspace_id: "ws-test",
      source_file_id: "src-1",
      gaps: [],
    });
    expect(result.summary).toContain("SYNAPSE_TEST_STUB_LLM");
  });

  it("requires provenance spans; allows optional external_id", () => {
    const ok = needGapSchema.safeParse({
      id: "gap-1",
      statement: "Need long-term CNS outcomes for BGB-58067",
      external_id: "NSCLC_CE_04",
      provenance: [
        {
          source_file_id: "src-1",
          block_id: "blk-1",
          quote: "NSCLC_CE_04 CNS Differentiation",
        },
      ],
    });
    expect(ok.success).toBe(true);
    expect(ok.data?.external_id).toBe("NSCLC_CE_04");

    const withoutExternal = needGapSchema.safeParse({
      id: "gap-2",
      statement: "Need comparative effectiveness in elderly EGFR NSCLC",
      external_id: null,
      provenance: [
        { source_file_id: "src-1", block_id: "blk-2", quote: "comparative effectiveness" },
      ],
    });
    expect(withoutExternal.success).toBe(true);

    const bad = needGapSchema.safeParse({
      id: "gap-3",
      statement: "Missing provenance",
      external_id: "NSCLC_HI_01",
      provenance: [],
    });
    expect(bad.success).toBe(false);
  });

  it("scores recall of extracted external_ids against mustFindForPack gap_ids", () => {
    const scored = scoreGapIdRecall({
      packId: "beone-bgb-58067-prmt5i",
      extractedExternalIds: ["NSCLC_CE_01", "NSCLC_CE_04", "NOT_A_GAP", null, ""],
    });
    expect(scored.found).toEqual(["NSCLC_CE_01", "NSCLC_CE_04"]);
    expect(scored.missing).toHaveLength(41);
    expect(scored.recall).toBeCloseTo(2 / 43, 5);

    const emptyPack = scoreGapIdRecall({
      packId: "beone-tislelizumab-iegp",
      extractedExternalIds: ["NSCLC_CE_01"],
    });
    expect(emptyPack.found).toEqual([]);
    expect(emptyPack.missing).toEqual([]);
    expect(emptyPack.recall).toBe(1);
  });
});
