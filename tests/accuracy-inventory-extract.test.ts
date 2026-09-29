import { describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@/accuracy/kernel/agent-events";

vi.mock("@/accuracy/store/parse-store", () => ({
  readParseBlocks: vi.fn(async () => [{ id: "blk-1", source_file_id: "src-1",
    heading: null, text: "Actual source describes an ongoing study." }]),
  readParseBlocksByIds: vi.fn(async () => [{ id: "blk-1", source_file_id: "src-1",
    heading: null, text: "Actual source describes an ongoing study." }]),
}));
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
      recordAgentEvent: async () => {},
      usageSummary: () => ({ token_usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, cost_usd: 0 }),
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
  it("flags an invalid tactic quote with its source reference", async () => {
    const prev = process.env.SYNAPSE_TEST_STUB_LLM;
    process.env.SYNAPSE_TEST_STUB_LLM = "0";
    try {
      const ctx = stubCtx();
      const events: AgentEvent[] = [];
      ctx.run.recordAgentEvent = async (event) => { events.push(event); };
      ctx.complete = vi.fn(async () => ({ raw: JSON.stringify({ tactics: [{
        name: "Phase 3 registrational trial", type: "phase3_trial", status: "ongoing",
        evidence_question: "Does it improve OS?", origin: "inventory",
        provenance: [{ source_file_id: "src-1", block_id: "blk-1", quote: "Invented study" }],
      }] }), usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }));
      const result = await inventoryExtractModule.run({ workspace_id: "ws-test", source_file_id: "src-1",
        block_ids: ["blk-1"] }, ctx);
      expect(result.output.tactics[0]?.provenance[0]?.quote).toBe("Invented study");
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
      ctx.complete = vi.fn(async () => ({ raw: JSON.stringify({ tactics: [
        { name: "Phase 3 registrational trial", type: "phase3_trial", status: "ongoing",
          evidence_question: "Does it improve OS?", origin: "inventory", provenance: [
            { source_file_id: "src-1", block_id: "blk-1", quote: "Invented study" }] },
        { name: "Registry study", type: "registry", status: "ongoing",
          evidence_question: "What is real-world OS?", origin: "inventory", provenance: [] },
      ] }), usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }));
      await inventoryExtractModule.run({ workspace_id: "ws-test", source_file_id: "src-1",
        block_ids: ["blk-1"] }, ctx);
      expect(ctx.complete).toHaveBeenCalledTimes(2);
      const revisionPrompt = vi.mocked(ctx.complete).mock.calls[1]?.[0].user ?? "";
      expect(revisionPrompt).toContain("Registry study:no_quote");
      expect(revisionPrompt).not.toContain("quote_not_substring");
      expect(events.find((event) => event.event_type === "critique")).toMatchObject({
        issues: expect.arrayContaining([expect.objectContaining({ code: "quote_not_substring" })]),
      });
    } finally { process.env.SYNAPSE_TEST_STUB_LLM = prev; }
  });
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
