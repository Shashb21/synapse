import { describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@/accuracy/kernel/agent-events";
import { readParseBlocksByIds } from "@/accuracy/store/parse-store";
import { listActiveSourceClaims } from "@/accuracy/store/claim-store";

vi.mock("@/accuracy/store/claim-store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/accuracy/store/claim-store")>(),
  listActiveSourceClaims: vi.fn(async () => []),
}));

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
} from "@/accuracy/modules/need-extract/module";
import { scoreGapIdRecall } from "@/accuracy/eval/gap-id-recall";
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
      auth: "api_key",
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

/** Quote tests script the completeness judge independently from extraction. */
function withCompleteness(ctx: AccuracyModuleContext) {
  const propose = ctx.complete;
  ctx.complete = vi.fn(async (request) => {
    if (request.purpose === "snapshot_completeness") {
      return { raw: JSON.stringify({ checked_block_ids: ["blk-1"], suspected_omissions: [],
        prior_issue_resolutions: [] }), usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
    }
    return propose(request);
  });
}

describe("need extract module", () => {
  it("reports an uncited gap B and records its resolution after revision within requested blocks", async () => {
    const prev = process.env.SYNAPSE_TEST_STUB_LLM;
    process.env.SYNAPSE_TEST_STUB_LLM = "0";
    try {
      vi.mocked(readParseBlocksByIds).mockResolvedValueOnce([
        { id: "blk-1", workspace_id: "ws-test", source_file_id: "src-1", index: 0,
          kind: "prose", heading: null, text: "Need survival evidence A. Need safety evidence B.", parser: "test", created_at: "now" },
      ]);
      const ctx = stubCtx();
      const events: AgentEvent[] = [];
      ctx.run.recordAgentEvent = async (event) => { events.push(event); };
      let proposal = 0;
      ctx.complete = vi.fn(async (request) => {
        if (request.purpose === "snapshot_completeness") {
          const input = JSON.parse(request.user);
          expect(input.blocks.map((block: { id: string }) => block.id)).toEqual(["blk-1"]);
          if (proposal === 1) return { raw: JSON.stringify({ checked_block_ids: ["blk-1"],
            suspected_omissions: [{ item_kind: "gap", summary: "Safety evidence B",
              source_ref: { source_file_id: "src-1", block_id: "blk-1" }, evidence_quote: "Need safety evidence B",
              basis: "explicit", reason: "A is distinct from B", suggested_action: "Add gap B" }],
            prior_issue_resolutions: [] }), usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
          return { raw: JSON.stringify({ checked_block_ids: ["blk-1"], suspected_omissions: [],
            prior_issue_resolutions: [{ issue_id: input.prior_open_issues[0].issue_id,
              outcome: "resolved", reason: "B added", matched_item_ref: "draft-gap-1" }] }),
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
        }
        proposal++;
        const gaps = [{ statement: "Survival evidence A", external_id: "A", provenance: [
          { source_file_id: "src-1", block_id: "blk-1", quote: "Need survival evidence A" }] }];
        if (proposal === 2) gaps.push({ statement: "Safety evidence B", external_id: "B", provenance: [
          { source_file_id: "src-1", block_id: "blk-1", quote: "Need safety evidence B" }] });
        return { raw: JSON.stringify({ gaps }), usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
      });
      const result = await needExtractModule.run({ workspace_id: "ws-test", source_file_id: "src-1", block_ids: ["blk-1", "missing"] }, ctx);
      expect(result.output.source_complete).toBe(false);
      const critiques = events.filter((event) => event.event_type === "critique");
      expect(critiques[0]).toMatchObject({ completeness: { risk_level: "important",
        checked_block_ids: ["blk-1"], unchecked_block_ids: ["missing"], suspected_omissions: [expect.objectContaining({ item_kind: "gap",
          source_ref: { source_file_id: "src-1", block_id: "blk-1" } })] } });
      expect(critiques[1]).toMatchObject({ score: 1, completeness: { prior_issue_resolutions: [
        expect.objectContaining({ outcome: "resolved" })] } });
      const proposals = vi.mocked(ctx.complete).mock.calls.filter(([request]) => request.purpose?.includes("proposer"));
      expect(proposals[0]?.[0].user).toContain("target_block_ids: blk-1");
      expect(proposals[0]?.[0].user).not.toContain("target_block_ids: blk-1, missing");
      expect(proposals).toHaveLength(2);
    } finally { process.env.SYNAPSE_TEST_STUB_LLM = prev; }
  });
  it("inspects active persisted gaps and tactics alongside the current draft", async () => {
    const prev = process.env.SYNAPSE_TEST_STUB_LLM;
    process.env.SYNAPSE_TEST_STUB_LLM = "0";
    try {
      vi.mocked(readParseBlocksByIds).mockResolvedValueOnce([
        { id: "blk-1", workspace_id: "ws-test", source_file_id: "src-1", index: 0,
          kind: "prose", heading: null, text: "Evidence need and registry tactic.", parser: "test", created_at: "now" },
      ]);
      vi.mocked(listActiveSourceClaims).mockResolvedValueOnce([
        { id: "stored-gap", claim_type: "gap", statement: "Stored need", metadata: { provenance: [
          { source_file_id: "src-1", block_id: "blk-1", quote: "Evidence need" }] } },
        { id: "stored-tactic", claim_type: "tactic", statement: "Stored registry", metadata: { provenance: [
          { source_file_id: "src-1", block_id: "blk-1", quote: "registry tactic" }] } },
      ] as never);
      const ctx = stubCtx();
      ctx.complete = vi.fn(async (request) => {
        if (request.purpose === "snapshot_completeness") {
          const { items } = JSON.parse(request.user);
          expect(items).toEqual(expect.arrayContaining([
            expect.objectContaining({ item_kind: "gap", item_ref: "stored-gap", statement: "Stored need" }),
            expect.objectContaining({ item_kind: "tactic", item_ref: "stored-tactic", statement: "Stored registry" }),
            expect.objectContaining({ item_kind: "gap", item_ref: "draft-gap-0", statement: "New need" }),
          ]));
          return { raw: JSON.stringify({ checked_block_ids: ["blk-1"], suspected_omissions: [],
            prior_issue_resolutions: [] }), usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
        }
        return { raw: JSON.stringify({ gaps: [{ statement: "New need", external_id: null, provenance: [
          { source_file_id: "src-1", block_id: "blk-1", quote: "Evidence need" }] }] }),
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
      });
      await needExtractModule.run({ workspace_id: "ws-test", source_file_id: "src-1", block_ids: ["blk-1"] }, ctx);
    } finally { process.env.SYNAPSE_TEST_STUB_LLM = prev; }
  });
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
      withCompleteness(ctx);
      await expect(needExtractModule.run({ workspace_id: "ws-test", source_file_id: "src-1",
        block_ids: ["blk-1"] }, ctx)).rejects.toThrow("No admissible extraction snapshot");
      expect(vi.mocked(ctx.complete).mock.calls.map(([request]) => request.purpose))
        .toEqual([expect.stringContaining("proposer"), "snapshot_completeness"]);
      expect(events.some(event => event.event_type === "judgment")).toBe(false);
      expect(events.find((event) => event.event_type === "snapshot")).toMatchObject({
        signals: { quote_validity: { invalid_count: 1 } },
      });
      expect(events.find((event) => event.event_type === "critique")).toMatchObject({
        issues: [expect.objectContaining({ code: "quote_not_substring",
          source_ref: { source_file_id: "src-1", block_id: "blk-1" } })],
      });
    } finally { process.env.SYNAPSE_TEST_STUB_LLM = prev; }
  });
  it("keeps distinct same-block quote findings independent and out of revision feedback", async () => {
    const prev = process.env.SYNAPSE_TEST_STUB_LLM;
    process.env.SYNAPSE_TEST_STUB_LLM = "0";
    try {
      const ctx = stubCtx();
      const events: AgentEvent[] = [];
      ctx.run.recordAgentEvent = async (event) => { events.push(event); };
      ctx.complete = vi.fn(async () => ({ raw: JSON.stringify({ gaps: [
        { statement: "Need OS evidence", external_id: "G1", provenance: [
          { source_file_id: "src-1", block_id: "blk-1", quote: "Invented quote" },
          { source_file_id: "src-1", block_id: "blk-1", quote: "Another invented quote" }] },
        { statement: "Need PFS evidence", external_id: "G2", provenance: [] },
      ] }), usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }));
      withCompleteness(ctx);
      await expect(needExtractModule.run({ workspace_id: "ws-test", source_file_id: "src-1",
        block_ids: ["blk-1"] }, ctx)).rejects.toThrow("No admissible extraction snapshot");
      expect(events.some(event => event.event_type === "judgment")).toBe(false);
      expect(ctx.complete).toHaveBeenCalledTimes(4);
      const proposals = vi.mocked(ctx.complete).mock.calls.filter(([request]) => request.purpose?.includes("proposer"));
      expect(proposals).toHaveLength(2);
      const revisionPrompt = proposals[1]?.[0].user ?? "";
      expect(revisionPrompt).toContain("G2:no_quote");
      expect(revisionPrompt).not.toContain("quote_not_substring");
      expect(events.filter((event) => event.event_type === "snapshot").map((event) => event.signals.invariant_failures)).toEqual([
        ["G2:no_quote"],
        ["G2:no_quote"],
      ]);
      expect(events.find((event) => event.event_type === "critique")).toMatchObject({
        issues: expect.arrayContaining([expect.objectContaining({ code: "quote_not_substring" })]),
      });
      const terminal = events.find(event => event.event_type === "critique" && event.iteration === 1);
      if (terminal?.event_type !== "critique") throw new Error("Missing terminal assessment");
      expect(terminal.issues.filter(issue => issue.category === "quote_validity")).toHaveLength(2);
      expect(terminal.structural_fate?.prior_issue_resolutions).toHaveLength(3);
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
      source_complete: true,
    });
    expect(result.summary).toContain("SYNAPSE_TEST_STUB_LLM");
  });

  it("calls the live LLM when stub is off", async () => {
    const prev = process.env.SYNAPSE_TEST_STUB_LLM;
    process.env.SYNAPSE_TEST_STUB_LLM = "0";
    try {
      vi.mocked(readParseBlocksByIds).mockResolvedValueOnce([{ id: "blk-1", source_file_id: "src-1",
        workspace_id: "ws-test", index: 0, kind: "prose", heading: null, text: "Need OS evidence in EGFR NSCLC.", parser: "test", created_at: "now" }]);
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
      withCompleteness(ctx);
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

  it("scores recall of extracted external_ids against supplied targets", () => {
    const scored = scoreGapIdRecall({
      targets: ["NSCLC_CE_01", "NSCLC_CE_04", "NSCLC_OTHER"],
      extractedExternalIds: ["NSCLC_CE_01", "NSCLC_CE_04", "NOT_A_GAP", null, ""],
    });
    expect(scored.found).toEqual(["NSCLC_CE_01", "NSCLC_CE_04"]);
    expect(scored.missing).toEqual(["NSCLC_OTHER"]);
    expect(scored.recall).toBeCloseTo(2 / 3, 5);

    const emptyPack = scoreGapIdRecall({
      targets: [],
      extractedExternalIds: ["NSCLC_CE_01"],
    });
    expect(emptyPack.found).toEqual([]);
    expect(emptyPack.missing).toEqual([]);
    expect(emptyPack.recall).toBe(1);
  });
});


describe("need retained-version extraction", () => {
  it.each([{ regress: true, selected: 1, fullyChecked: false }, { regress: false, selected: 3, fullyChecked: false }, { regress: true, selected: 1, fullyChecked: true }])("selects source-supported V$selected (regress=$regress, fullyChecked=$fullyChecked)", async ({ regress, selected, fullyChecked }) => {
    // Break caught: accepting terminal invented evidence instead of a retained supported snapshot.
    const prev = process.env.SYNAPSE_TEST_STUB_LLM;
    process.env.SYNAPSE_TEST_STUB_LLM = "0";
    try {
      vi.mocked(readParseBlocksByIds).mockResolvedValueOnce([{ id: "blk-1", source_file_id: "src-1",
        workspace_id: "ws-test", index: 0, kind: "prose", heading: null,
        text: "Actual source says survival evidence is needed.", parser: "test", created_at: "now" }]);
      const ctx = stubCtx();
      Object.assign(ctx.run, { evaluation_context: "experiment", experiment_cycle_control: { critic_revision_passes: 3 } });
      const events: AgentEvent[] = [];
      const inputs: string[] = [];
      ctx.run.recordAgentEvent = async event => { events.push(event); };
      let round = -1;
      ctx.complete = async request => {
        inputs.push(request.user);
        if (request.purpose === "snapshot_completeness") return { raw: JSON.stringify({
          checked_block_ids: regress && round >= 2 && !fullyChecked ? [] : ["blk-1"], suspected_omissions: [], prior_issue_resolutions: [] }),
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
        round++;
        const quote = regress && round >= 2 ? "Invented evidence" : "Actual source says survival evidence is needed";
        const item = { statement: `Need V${round}`, external_id: null,
          provenance: [{ source_file_id: "src-1", block_id: "blk-1", quote }] };
        return { raw: JSON.stringify({ gaps: [item] }), usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
      };
      const result = await needExtractModule.run({ workspace_id: "ws-test", source_file_id: "src-1", block_ids: ["blk-1"] }, ctx);
      expect(result.output.gaps[0].statement).toBe(`Need V${selected}`);
      expect(result.output.source_complete).toBe(true);
      expect(events.filter(event => event.event_type === "snapshot").map(event => event.iteration)).toEqual([0, 1, 2, 3]);
      expect(events.at(-1)).toMatchObject({ event_type: "judgment", selected_iteration: selected, reason: expect.stringContaining("source") });
      expect(inputs.join(" ")).not.toMatch(/gold|precision|recall|f1/i);
      if (fullyChecked) {
        expect(events.filter(event => event.event_type === "critique").map(event => event.completeness.unchecked_block_ids)).toEqual([[], [], [], []]);
        expect(events.filter(event => event.event_type === "snapshot").map(event => event.signals.quote_validity.invalid_count)).toEqual([0, 0, 1, 1]);
      }
    } finally { process.env.SYNAPSE_TEST_STUB_LLM = prev; }
  });

  it("fails safely when completeness provider fails", async () => {
    const prev = process.env.SYNAPSE_TEST_STUB_LLM;
    process.env.SYNAPSE_TEST_STUB_LLM = "0";
    try {
      vi.mocked(readParseBlocksByIds).mockResolvedValueOnce([{ id: "blk-1", source_file_id: "src-1",
        workspace_id: "ws-test", index: 0, kind: "prose", heading: null,
        text: "Actual source says survival evidence is needed.", parser: "test", created_at: "now" }]);
      const ctx = stubCtx();
      const events: AgentEvent[] = [];
      ctx.run.recordAgentEvent = async event => { events.push(event); };
      ctx.complete = async request => {
        if (request.purpose === "snapshot_completeness") throw new Error("provider offline");
        return { raw: JSON.stringify({ gaps: [{ statement: "Need evidence",
          provenance: [{ source_file_id: "src-1", block_id: "blk-1", quote: "Actual source" }] }] }),
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
      };
      await expect(needExtractModule.run({ workspace_id: "ws-test", source_file_id: "src-1", block_ids: ["blk-1"] }, ctx)).rejects.toThrow();
      expect(events.map(event => event.event_type)).toEqual(["snapshot", "critique"]);
      expect(events[1]).toMatchObject({ completeness: { risk_level: "check_failed" } });
    } finally { process.env.SYNAPSE_TEST_STUB_LLM = prev; }
  });
});


it("need: preserves the selected important omission when terminal assessment clears it", async () => {
  const prev = process.env.SYNAPSE_TEST_STUB_LLM;
  process.env.SYNAPSE_TEST_STUB_LLM = "0";
  try {
    vi.mocked(readParseBlocksByIds).mockResolvedValueOnce([{ id: "blk-1", source_file_id: "src-1",
      workspace_id: "ws-test", index: 0, kind: "prose", heading: null,
      text: "Actual source. Important omitted need.", parser: "test", created_at: "now" }]);
    const ctx = stubCtx();
    const events: AgentEvent[] = [];
    ctx.run.recordAgentEvent = async event => { events.push(event); };
    let round = -1;
    ctx.complete = async request => {
      if (request.purpose === "snapshot_completeness") {
        const prior = JSON.parse(request.user).prior_open_issues;
        return { raw: JSON.stringify({ checked_block_ids: ["blk-1"],
          suspected_omissions: round === 0 ? [{ item_kind: "gap", summary: "Important omitted need",
            source_ref: { source_file_id: "src-1", block_id: "blk-1" }, evidence_quote: "Important omitted need",
            basis: "explicit", reason: "Distinct source item is absent", suggested_action: "Add the omitted item" }] : [],
          prior_issue_resolutions: prior.map((issue: { issue_id: string }) => ({ issue_id: issue.issue_id,
            outcome: "invalid", reason: "Terminal inspector reclassified the finding" })) }),
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
      }
      round++;
      return { raw: JSON.stringify({ gaps: [{ statement: `Need V${round}`,
        provenance: [{ source_file_id: "src-1", block_id: "blk-1", quote: round === 0 ? "Actual source" : "Invented evidence" }] }] }),
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
    };
    const result = await needExtractModule.run({ workspace_id: "ws-test", source_file_id: "src-1", block_ids: ["blk-1"] }, ctx);
    expect(result.output.gaps[0].statement).toBe("Need V0");
    expect(result.output.source_complete).toBe(true);
    expect(events[1]).toMatchObject({ completeness: { risk_level: "important", suspected_omissions: [expect.objectContaining({ importance: "important" })] } });
    expect(events[3]).toMatchObject({ completeness: { risk_level: "none_detected" } });
    expect(events.at(-1)).toMatchObject({ event_type: "judgment", selected_iteration: 0, reason: expect.stringContaining("1 important omissions") });
  } finally { process.env.SYNAPSE_TEST_STUB_LLM = prev; }
});
