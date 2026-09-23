import { describe, expect, it, vi } from "vitest";
import type { AccuracyModuleContext } from "@/accuracy/kernel/contracts";
import {
  buildStateFromBlocks,
  coverageCriticModule,
  coverageDecideModule,
  deterministicCoverageDecision,
  runCoverageDecide,
  runCoverageCritic,
} from "@/accuracy/modules/coverage-decide/module";

function mockCtx(connected: boolean): AccuracyModuleContext {
  return {
    org_id: "org-1",
    workspace_id: "ws-1",
    actor: { name: "test", function: "medical_affairs" },
    role: "medical_affairs",
    run: {
      id: "run-1",
      step: async (_name, fn) => fn(),
      note: () => {},
      steps: () => [],
    },
    route: {
      call_kind: "coverage_decide",
      role: "proposer",
      provider_id: connected ? "xai" : "none",
      provider_label: connected ? "Grok" : "None",
      model: connected ? "grok-2" : "none",
      auth: connected ? "oauth" : "none",
      connected,
      params: { temperature: 0, max_tokens: 8192 },
      fallbacks: [],
      degraded: false,
      reason: connected ? null : "mechanical",
    },
    complete: vi.fn(async () => ({ raw: "{}", usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } })),
    noteCost: () => {},
  };
}

const sampleBlocks = [
  { id: "B2", heading: "Registry", text: "VEL-REG-01 covers real-world NSCLC population." },
  { id: "B1", heading: "Gap", text: "Need comparative effectiveness in 1L NSCLC." },
];

describe("buildStateFromBlocks", () => {
  it("orders evidence blocks by block_bundle_ids and attaches pair labels", () => {
    const state = buildStateFromBlocks({
      gap_id: "G1",
      tactic_id: "T1",
      block_bundle_ids: ["B1", "B2", "missing"],
      blocks: sampleBlocks,
      labels: {
        gap: { name: "1L NSCLC", statement: "Need comparative effectiveness" },
        tactic: { name: "VEL-REG-01", evidence_question: "RWE in 1L" },
      },
    });
    expect(state.evidence_blocks.map((b) => b.id)).toEqual(["B1", "B2"]);
    expect(state.gap.statement).toContain("comparative");
    expect(state.tactic.name).toBe("VEL-REG-01");
  });
});

describe("coverage_decide pair run", () => {
  it("returns deterministic not_relevant when LLM is not connected", async () => {
    const input = {
      workspace_id: "ws-1",
      gap_id: "G1",
      tactic_id: "T1",
      block_bundle_ids: ["B1"],
    };
    const result = await runCoverageDecide(input, mockCtx(false), sampleBlocks);
    expect(result.mode).toBe("stub");
    expect(result.output).toEqual(deterministicCoverageDecision(input));
    expect(result.output.overall).toBe("not_relevant");
  });

  it("uses ctx.complete when LLM is connected and locks ids to the pair", async () => {
    const ctx = mockCtx(true);
    ctx.complete = vi.fn(async () => ({
      raw: JSON.stringify({
        gap_id: "WRONG",
        tactic_id: "WRONG",
        overall: "partial",
        quote_block_ids: ["B1", "outside"],
        confidence: 0.71,
        rationale: "Registry overlaps population in B1.",
      }),
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }));

    const result = await runCoverageDecide(
      {
        workspace_id: "ws-1",
        gap_id: "G1",
        tactic_id: "T1",
        block_bundle_ids: ["B1", "B2"],
      },
      ctx,
      sampleBlocks,
    );

    expect(result.mode).toBe("llm");
    expect(result.output.gap_id).toBe("G1");
    expect(result.output.tactic_id).toBe("T1");
    expect(result.output.overall).toBe("partial");
    expect(result.output.quote_block_ids).toEqual(["B1"]);
    expect(ctx.complete).toHaveBeenCalledOnce();
  });

  it("module run wires decide helper", async () => {
    const result = await coverageDecideModule.run(
      {
        workspace_id: "ws-1",
        gap_id: "G9",
        tactic_id: "T9",
        block_bundle_ids: [],
      },
      mockCtx(false),
    );
    expect(result.output.overall).toBe("not_relevant");
  });
});

describe("coverage_critic no LLM accept", () => {
  it("accepts the decision when LLM is not connected", async () => {
    const decision = {
      gap_id: "G1",
      tactic_id: "T1",
      overall: "partial" as const,
      quote_block_ids: ["B1"],
      confidence: 0.4,
      rationale: "Weak overlap",
    };
    const result = await runCoverageCritic(decision, mockCtx(false));
    expect(result.mode).toBe("stub");
    expect(result.output).toEqual({ accept: true, issues: [] });
  });

  it("module run accepts without LLM", async () => {
    const result = await coverageCriticModule.run(
      {
        gap_id: "G1",
        tactic_id: "T1",
        overall: "limited",
        quote_block_ids: [],
        confidence: 0.2,
        rationale: "Tangential",
      },
      mockCtx(false),
    );
    expect(result.output.accept).toBe(true);
    expect(result.output.issues).toHaveLength(0);
  });
});
