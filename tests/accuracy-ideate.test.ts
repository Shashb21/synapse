import { describe, expect, it, vi } from "vitest";
import type { AccuracyModuleContext } from "@/accuracy/kernel/contracts";
import {
  critiqueIdeationDraft,
  ideateModule,
  ideateOutputSchema,
  ideationProposalSchema,
  lockIdeationProposals,
} from "@/accuracy/modules/ideate/module";
import { IDEATE_PROPOSER_SYSTEM } from "@/accuracy/modules/ideate/prompts";

function mockCtx(connected: boolean): AccuracyModuleContext {
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
      call_kind: "ideate",
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
    complete: vi.fn(async () => ({
      raw: "{}",
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    })),
    noteCost: () => {},
  };
}

const highOpenGaps = [
  {
    id: "gap_high",
    statement: "Need OS evidence in biomarker-high subgroup",
    status: "open" as const,
    priority_band: "high" as const,
    validated: true,
  },
  {
    id: "gap_med",
    statement: "Need nicer slides",
    status: "open" as const,
    priority_band: "medium" as const,
    validated: true,
  },
];

describe("ideate module", () => {
  it("returns empty proposals under SYNAPSE_TEST_STUB_LLM", async () => {
    expect(process.env.SYNAPSE_TEST_STUB_LLM).toBe("1");
    const ctx = mockCtx(true);
    const result = await ideateModule.run(
      {
        workspace_id: "ws-test",
        gaps: highOpenGaps,
        existing_tactic_names: ["Phase 3 registrational trial"],
        per_gap: 1,
      },
      ctx,
    );
    expect(ideateOutputSchema.parse(result.output)).toEqual({
      mode: "stub",
      eligible_gap_ids: ["gap_high"],
      proposals: [],
    });
    expect(result.summary).toContain("SYNAPSE_TEST_STUB_LLM");
    expect(ctx.complete).not.toHaveBeenCalled();
  });

  it("locks origin/status and drops ineligible or inventory-like LLM rows", async () => {
    const prev = process.env.SYNAPSE_TEST_STUB_LLM;
    process.env.SYNAPSE_TEST_STUB_LLM = "0";
    try {
      const ctx = mockCtx(true);
      ctx.complete = vi.fn(async () => ({
        raw: JSON.stringify({
          proposals: [
            {
              gap_id: "gap_high",
              name: "Prospective OS follow-up in biomarker-high cohort",
              type: "rwe_study",
              origin: "inventory",
              status: "planned",
              design_summary: "Retrospective EMR cohort with 24-month OS readout.",
              provenance: [{ quote: "should be stripped" }],
            },
            {
              gap_id: "gap_med",
              name: "Invented medium-gap registry",
              type: "registry",
              origin: "ideated",
              status: "proposed",
              design_summary: "Should not attach to a medium gap.",
            },
            {
              gap_id: "gap_high",
              name: "G:21",
              type: "rwe_study",
              origin: "ideated",
              status: "proposed",
              design_summary: "Must not reuse Tisle inventory identifiers.",
            },
            {
              gap_id: "gap_high",
              name: "Phase 3 registrational trial",
              type: "phase3_trial",
              origin: "ideated",
              status: "proposed",
              design_summary: "Duplicate of inventory name.",
            },
          ],
        }),
        usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
      }));

      const result = await ideateModule.run(
        {
          workspace_id: "ws-test",
          gaps: highOpenGaps,
          existing_tactic_names: ["Phase 3 registrational trial"],
          per_gap: 1,
        },
        ctx,
      );

      expect(result.output.mode).toBe("llm");
      expect(result.output.eligible_gap_ids).toEqual(["gap_high"]);
      expect(result.output.proposals).toHaveLength(1);
      expect(result.output.proposals[0]?.name).toMatch(/Prospective OS follow-up/);
      expect(result.output.proposals[0]?.origin).toBe("ideated");
      expect(result.output.proposals[0]?.status).toBe("proposed");
      expect(result.output.proposals[0]?.not_from_reference).toBe(true);
      expect(ctx.complete).toHaveBeenCalled();
      const call = vi.mocked(ctx.complete).mock.calls[0]?.[0];
      expect(call?.system).toBe(IDEATE_PROPOSER_SYSTEM);
      expect(call?.user).toContain("gap_high");
      expect(call?.user).not.toContain("gap_med");
    } finally {
      process.env.SYNAPSE_TEST_STUB_LLM = prev;
    }
  });

  it("re-asks for a real tactic type instead of defaulting one", async () => {
    const prev = process.env.SYNAPSE_TEST_STUB_LLM;
    process.env.SYNAPSE_TEST_STUB_LLM = "0";
    try {
      const ctx = mockCtx(true);
      const answer = (type: string) => ({
        raw: JSON.stringify({
          tactics: [
            {
              gap_id: "gap_high",
              name: "Prospective OS follow-up in biomarker-high cohort",
              type,
              origin: "ideated",
              status: "proposed",
              rationale: "No inventory tactic covers residual OS in this subgroup.",
            },
          ],
        }),
        usage: { prompt_tokens: 8, completion_tokens: 8, total_tokens: 16 },
      });
      ctx.complete = vi
        .fn()
        .mockResolvedValueOnce(answer("not_a_type"))
        .mockResolvedValueOnce(answer("registry"));

      const result = await ideateModule.run(
        {
          workspace_id: "ws-test",
          gaps: highOpenGaps,
          existing_tactic_names: ["VEL-REG-01"],
          per_gap: 1,
        },
        ctx,
      );

      expect(result.output.mode).toBe("llm");
      expect(result.output.proposals).toHaveLength(1);
      const proposal = ideationProposalSchema.parse(result.output.proposals[0]);
      expect(proposal.origin).toBe("ideated");
      expect(proposal.status).toBe("proposed");
      expect(proposal.not_from_reference).toBe(true);
      expect(proposal.type).toBe("registry");
      expect(ctx.complete).toHaveBeenCalledTimes(2);
      expect(vi.mocked(ctx.complete).mock.calls[1]?.[0].user).toContain("invalid_type");
      expect(proposal.gap_id).toBe("gap_high");
    } finally {
      process.env.SYNAPSE_TEST_STUB_LLM = prev;
    }
  });
});

describe("lockIdeationProposals", () => {
  it("caps per gap and excludes inventory names", () => {
    const locked = lockIdeationProposals(
      {
        proposals: [
          {
            gap_id: "gap_high",
            name: "First rwe study for residual OS",
            type: "rwe_study",
            origin: "ideated",
            status: "proposed",
            design_summary: "EMR cohort",
            not_from_reference: true,
          },
          {
            gap_id: "gap_high",
            name: "Second rwe study for residual OS",
            type: "rwe_study",
            origin: "ideated",
            status: "proposed",
            design_summary: "Claims cohort",
            not_from_reference: true,
          },
        ],
      },
      {
        eligibleIds: new Set(["gap_high"]),
        existingNames: new Set(),
        perGap: 1,
      },
    );
    expect(locked.map((p) => p.name)).toEqual(["First rwe study for residual OS"]);
  });

  it("flags source quotes and ineligible gaps in the critic", () => {
    const { issues } = critiqueIdeationDraft(
      {
        proposals: [
          {
            gap_id: "gap_med",
            name: "Should not ideate medium",
            type: "rwe_study",
            provenance: [{ quote: "from deck" }],
          },
        ],
      },
      { eligibleIds: new Set(["gap_high"]), existingNames: new Set() },
    );
    expect(issues.some((i) => i.includes("ineligible_gap"))).toBe(true);
    expect(issues.some((i) => i.includes("source_quote_claimed"))).toBe(true);
  });
});
