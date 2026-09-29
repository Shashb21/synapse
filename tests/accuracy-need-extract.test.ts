import { describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@/accuracy/kernel/agent-events";

vi.mock("@/accuracy/store/parse-store", () => ({
  readParseBlocks: vi.fn(async () => [{ id: "blk-1", source_file_id: "src-1",
    heading: null, text: "Actual source says survival evidence is needed." }]),
  readParseBlocksByIds: vi.fn(async () => [{ id: "blk-1", source_file_id: "src-1",
    heading: null, text: "Actual source says survival evidence is needed." }]),
}));
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
      recordAgentEvent: async () => {},
      usageSummary: () => ({ token_usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, cost_usd: 0 }),
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
  it("flags an invalid source quote with its file and block reference", async () => {
    const prev = process.env.SYNAPSE_TEST_STUB_LLM;
    process.env.SYNAPSE_TEST_STUB_LLM = "0";
    try {
      const ctx = stubCtx();
      const events: AgentEvent[] = [];
      ctx.run.recordAgentEvent = async (event) => { events.push(event); };
      ctx.complete = vi.fn(async () => ({ raw: JSON.stringify({ gaps: [{ statement: "Need OS evidence",
        external_id: "G1", provenance: [{ source_file_id: "src-1", block_id: "blk-1",
          quote: "Invented quote" }] }] }),
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }));
      const result = await needExtractModule.run({ workspace_id: "ws-test", source_file_id: "src-1",
        block_ids: ["blk-1"] }, ctx);
      expect(result.output.gaps[0]?.provenance[0]?.quote).toBe("Invented quote");
      expect(ctx.complete).toHaveBeenCalledOnce();
      expect(events.find((event) => event.event_type === "judgment")).toMatchObject({ selected_iteration: 0 });
      expect(events.find((event) => event.event_type === "snapshot")).toMatchObject({
        signals: { quote_validity: { invalid_count: 1 } },
      });
      expect(events.find((event) => event.event_type === "critique")).toMatchObject({
        issues: [expect.objectContaining({ code: "quote_not_substring",
          source_ref: { source_file_id: "src-1", block_id: "blk-1" } })],
      });
    } finally { process.env.SYNAPSE_TEST_STUB_LLM = prev; }
  });
  it("keeps observation-only quote findings out of revision feedback", async () => {
    const prev = process.env.SYNAPSE_TEST_STUB_LLM;
    process.env.SYNAPSE_TEST_STUB_LLM = "0";
    try {
      const ctx = stubCtx();
      const events: AgentEvent[] = [];
      ctx.run.recordAgentEvent = async (event) => { events.push(event); };
      ctx.complete = vi.fn(async () => ({ raw: JSON.stringify({ gaps: [
        { statement: "Need OS evidence", external_id: "G1", provenance: [
          { source_file_id: "src-1", block_id: "blk-1", quote: "Invented quote" }] },
        { statement: "Need PFS evidence", external_id: "G2", provenance: [] },
      ] }), usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }));
      await needExtractModule.run({ workspace_id: "ws-test", source_file_id: "src-1",
        block_ids: ["blk-1"] }, ctx);
      expect(ctx.complete).toHaveBeenCalledTimes(2);
      const revisionPrompt = vi.mocked(ctx.complete).mock.calls[1]?.[0].user ?? "";
      expect(revisionPrompt).toContain("G2:no_quote");
      expect(revisionPrompt).not.toContain("quote_not_substring");
      expect(events.find((event) => event.event_type === "critique")).toMatchObject({
        issues: expect.arrayContaining([expect.objectContaining({ code: "quote_not_substring" })]),
      });
    } finally { process.env.SYNAPSE_TEST_STUB_LLM = prev; }
  });
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

  it("calls the connected OAuth LLM when stub is off", async () => {
    const prev = process.env.SYNAPSE_TEST_STUB_LLM;
    process.env.SYNAPSE_TEST_STUB_LLM = "0";
    try {
      const ctx = stubCtx();
      ctx.complete = async () => ({
        raw: JSON.stringify({
          gaps: [
            {
              statement: "Need OS evidence in EGFR NSCLC",
              external_id: "NSCLC_CE_01",
              provenance: [
                {
                  source_file_id: "src-1",
                  block_id: "blk-1",
                  quote: "Need OS evidence",
                },
              ],
            },
          ],
        }),
        usage: { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10 },
      });
      const result = await needExtractModule.run(
        {
          workspace_id: "ws-test",
          source_file_id: "src-1",
          block_ids: ["blk-1"],
        },
        ctx,
      );
      expect(result.output.gaps).toHaveLength(1);
      expect(result.output.gaps[0]?.statement).toMatch(/OS evidence/);
      expect(result.summary).toMatch(/1 gap/);
    } finally {
      process.env.SYNAPSE_TEST_STUB_LLM = prev;
    }
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
