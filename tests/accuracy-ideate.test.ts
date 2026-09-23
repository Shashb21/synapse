import { describe, expect, it, vi } from "vitest";
import type { AccuracyModuleContext } from "@/accuracy/kernel/contracts";
import {
  ideateRouteAllowsLlm,
  mechanicalIdeateProposal,
  runIdeate,
} from "@/accuracy/modules/ideate/module";

function mockCtx(args: {
  connected: boolean;
  auth?: "oauth" | "api_key" | "none";
}): AccuracyModuleContext {
  const connected = args.connected;
  const auth = args.auth ?? (connected ? "oauth" : "none");
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
      call_kind: "ideate",
      role: "proposer",
      provider_id: connected ? "xai" : "none",
      provider_label: connected ? "Grok" : "None",
      model: connected ? "grok-2" : "none",
      auth,
      connected,
      params: { temperature: 0, max_tokens: 8192 },
      fallbacks: [],
      degraded: false,
      reason: connected ? null : "mechanical",
    },
    complete: vi.fn(async () => ({
      raw: "{}",
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    })),
    noteCost: () => {},
  };
}

const highGap = {
  id: "G1",
  statement: "Need OS evidence in biomarker-high subgroup",
  status: "open" as const,
  priority_band: "high" as const,
};

describe("ideateRouteAllowsLlm", () => {
  it("accepts oauth and api_key when connected", () => {
    expect(ideateRouteAllowsLlm({ connected: true, auth: "oauth" })).toBe(true);
    expect(ideateRouteAllowsLlm({ connected: true, auth: "api_key" })).toBe(true);
    expect(ideateRouteAllowsLlm({ connected: false, auth: "api_key" })).toBe(false);
    expect(ideateRouteAllowsLlm({ connected: true, auth: "none" })).toBe(false);
  });
});

describe("runIdeate", () => {
  it("returns mechanical stub proposal when LLM is not connected", async () => {
    const result = await runIdeate(
      {
        workspace_id: "ws-1",
        gaps: [highGap],
        existing_tactic_names: [],
        focus_gap_id: "G1",
        mechanical: {
          title: "Prospective OS follow-up in biomarker-high cohort",
          rationale: "No inventory tactic covers this residual high gap",
        },
      },
      mockCtx({ connected: false }),
    );
    expect(result.output.mode).toBe("stub");
    expect(result.output.proposals).toHaveLength(1);
    expect(result.output.proposals[0]).toEqual(
      mechanicalIdeateProposal({
        gap_id: "G1",
        title: "Prospective OS follow-up in biomarker-high cohort",
        rationale: "No inventory tactic covers this residual high gap",
      }),
    );
  });

  it("skips medium-priority gaps even with mechanical title", async () => {
    const result = await runIdeate(
      {
        workspace_id: "ws-1",
        gaps: [
          {
            id: "G-med",
            statement: "Medium need",
            status: "open",
            priority_band: "medium",
          },
        ],
        existing_tactic_names: [],
        focus_gap_id: "G-med",
        mechanical: {
          title: "Should not invent for medium",
          rationale: "Product lock high-only",
        },
      },
      mockCtx({ connected: false }),
    );
    expect(result.output.mode).toBe("stub");
    expect(result.output.proposals).toEqual([]);
  });

  it("uses ctx.complete when LLM is connected via oauth and locks gap_id", async () => {
    vi.stubEnv("SYNAPSE_TEST_STUB_LLM", "");
    const ctx = mockCtx({ connected: true, auth: "oauth" });
    ctx.complete = vi.fn(async () => ({
      raw: JSON.stringify({
        proposals: [
          {
            gap_id: "WRONG",
            name: "Biomarker-high OS registry extension",
            type: "registry",
            origin: "ideated",
            status: "proposed",
            design_summary: "Extend registry follow-up for OS in biomarker-high.",
            not_from_reference: true,
            rationale: "Closes residual OS evidence need.",
          },
        ],
      }),
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    }));

    const result = await runIdeate(
      {
        workspace_id: "ws-1",
        gaps: [highGap],
        existing_tactic_names: ["Existing inventory study"],
        focus_gap_id: "G1",
      },
      ctx,
    );

    expect(result.output.mode).toBe("llm");
    expect(result.output.proposals).toHaveLength(1);
    expect(result.output.proposals[0]?.gap_id).toBe("G1");
    expect(result.output.proposals[0]?.name).toMatch(/registry/i);
    expect(result.output.proposals[0]?.origin).toBe("ideated");
    expect(result.output.proposals[0]?.not_from_reference).toBe(true);
    expect(ctx.complete).toHaveBeenCalledOnce();
    vi.unstubAllEnvs();
  });

  it("uses ctx.complete when LLM is connected via api_key", async () => {
    vi.stubEnv("SYNAPSE_TEST_STUB_LLM", "");
    const ctx = mockCtx({ connected: true, auth: "api_key" });
    ctx.complete = vi.fn(async () => ({
      raw: JSON.stringify({
        proposals: [
          {
            gap_id: "G1",
            name: "Propensity-weighted OS cohort in biomarker-high",
            type: "rwe_study",
            origin: "ideated",
            status: "proposed",
            design_summary: "Retrospective EMR cohort with propensity weighting.",
            not_from_reference: true,
            rationale: "Generates comparative OS where trials are thin.",
          },
        ],
      }),
      usage: { prompt_tokens: 8, completion_tokens: 12, total_tokens: 20 },
    }));

    const result = await runIdeate(
      {
        workspace_id: "ws-1",
        gaps: [highGap],
        existing_tactic_names: [],
        focus_gap_id: "G1",
      },
      ctx,
    );

    expect(result.output.mode).toBe("llm");
    expect(result.output.proposals[0]?.type).toBe("rwe_study");
    expect(ctx.complete).toHaveBeenCalledOnce();
    vi.unstubAllEnvs();
  });

  it("drops LLM proposals that collide with existing tactic names", async () => {
    vi.stubEnv("SYNAPSE_TEST_STUB_LLM", "");
    const ctx = mockCtx({ connected: true });
    ctx.complete = vi.fn(async () => ({
      raw: JSON.stringify({
        proposals: [
          {
            gap_id: "G1",
            name: "Duplicate Study Name",
            type: "rwe_study",
            origin: "ideated",
            status: "proposed",
            design_summary: "Should be skipped",
            not_from_reference: true,
            rationale: "Duplicate",
          },
        ],
      }),
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));

    const result = await runIdeate(
      {
        workspace_id: "ws-1",
        gaps: [highGap],
        existing_tactic_names: ["Duplicate Study Name"],
        focus_gap_id: "G1",
      },
      ctx,
    );

    expect(result.output.mode).toBe("llm");
    expect(result.output.proposals).toEqual([]);
    vi.unstubAllEnvs();
  });
});
