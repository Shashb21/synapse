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

describe("inventory extract module", () => {
  it("supplies persisted gaps and tactics with provenance alongside the current tactic draft", async () => {
    const prev = process.env.SYNAPSE_TEST_STUB_LLM;
    process.env.SYNAPSE_TEST_STUB_LLM = "0";
    try {
      vi.mocked(readParseBlocksByIds).mockResolvedValueOnce([
        { id: "blk-1", workspace_id: "ws-test", source_file_id: "src-1", index: 0,
          kind: "prose", heading: null, text: "Evidence need. Registry study. Trial planned.", parser: "test", created_at: "now" },
      ]);
      vi.mocked(listActiveSourceClaims).mockResolvedValueOnce([
        { id: "stored-gap", claim_type: "gap", statement: "Stored need", metadata: { provenance: [
          { source_file_id: "src-1", block_id: "blk-1", quote: "Evidence need" }] } },
        { id: "stored-tactic", claim_type: "tactic", statement: "Stored registry", metadata: { provenance: [
          { source_file_id: "src-1", block_id: "blk-1", quote: "Registry study" }, null, { quote: 42 }] } },
      ] as never);
      const ctx = stubCtx();
      const inspectedItems: unknown[] = [];
      ctx.complete = vi.fn(async (request) => {
        if (request.purpose === "snapshot_completeness") {
          inspectedItems.push(JSON.parse(request.user).items);
          return { raw: JSON.stringify({ checked_block_ids: ["blk-1"], suspected_omissions: [],
            prior_issue_resolutions: [] }), usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
        }
        return { raw: JSON.stringify({ tactics: [{ name: "New trial", type: "phase3_trial", status: "planned",
          evidence_question: "Does the treatment work?", provenance: [
            { source_file_id: "src-1", block_id: "blk-1", quote: "Trial planned" }] }] }),
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
      });
      await inventoryExtractModule.run({ workspace_id: "ws-test", source_file_id: "src-1", block_ids: ["blk-1"] }, ctx);
      expect(inspectedItems).toEqual([[
        { item_kind: "gap", item_ref: "stored-gap", statement: "Stored need", provenance: [
          { source_file_id: "src-1", block_id: "blk-1", quote: "Evidence need" }] },
        { item_kind: "tactic", item_ref: "stored-tactic", statement: "Stored registry", provenance: [
          { source_file_id: "src-1", block_id: "blk-1", quote: "Registry study" }] },
        { item_kind: "tactic", item_ref: "draft-tactic-0", statement: "New trial", provenance: [
          { source_file_id: "src-1", block_id: "blk-1", quote: "Trial planned" }] },
      ]]);
    } finally { process.env.SYNAPSE_TEST_STUB_LLM = prev; }
  });
  it("reports distinct tactic B despite A citing the same block and resolves it in V1", async () => {
    const prev = process.env.SYNAPSE_TEST_STUB_LLM;
    process.env.SYNAPSE_TEST_STUB_LLM = "0";
    try {
      vi.mocked(readParseBlocksByIds).mockResolvedValueOnce([
        { id: "blk-1", workspace_id: "ws-test", source_file_id: "src-1", index: 0,
          kind: "prose", heading: null, text: "Phase 3 trial A and registry B are planned.", parser: "test", created_at: "now" },
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
            suspected_omissions: [{ item_kind: "tactic", summary: "Registry B",
              source_ref: { source_file_id: "src-1", block_id: "blk-1" }, evidence_quote: "registry B",
              basis: "explicit", reason: "Trial A does not cover registry B", suggested_action: "Add registry B" }],
            prior_issue_resolutions: [] }), usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
          return { raw: JSON.stringify({ checked_block_ids: ["blk-1"], suspected_omissions: [],
            prior_issue_resolutions: [{ issue_id: input.prior_open_issues[0].issue_id,
              outcome: "resolved", reason: "B added", matched_item_ref: "draft-tactic-1" }] }),
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
        }
        proposal++;
        const tactics = [{ name: "Trial A", type: "phase3_trial", status: "planned", evidence_question: "Does A work?",
          provenance: [{ source_file_id: "src-1", block_id: "blk-1", quote: "Phase 3 trial A" }] }];
        if (proposal === 2) tactics.push({ name: "Registry B", type: "registry", status: "planned", evidence_question: "Does B work?",
          provenance: [{ source_file_id: "src-1", block_id: "blk-1", quote: "registry B" }] });
        return { raw: JSON.stringify({ tactics }), usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
      });
      await inventoryExtractModule.run({ workspace_id: "ws-test", source_file_id: "src-1", block_ids: ["blk-1", "missing"] }, ctx);
      const critiques = events.filter((event) => event.event_type === "critique");
      expect(critiques[0]).toMatchObject({ completeness: { risk_level: "important",
        checked_block_ids: ["blk-1"], unchecked_block_ids: ["missing"], suspected_omissions: [expect.objectContaining({ item_kind: "tactic",
          source_ref: { source_file_id: "src-1", block_id: "blk-1" } })] } });
      expect(critiques[1]).toMatchObject({ score: 1, completeness: { prior_issue_resolutions: [
        expect.objectContaining({ outcome: "resolved" })] } });
      const proposalPrompt = vi.mocked(ctx.complete).mock.calls.find(([request]) => request.purpose?.includes("proposer"))?.[0].user;
      expect(proposalPrompt).toContain("target_block_ids: blk-1");
      expect(proposalPrompt).not.toContain("target_block_ids: blk-1, missing");
    } finally { process.env.SYNAPSE_TEST_STUB_LLM = prev; }
  });
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
      withCompleteness(ctx);
      const result = await inventoryExtractModule.run({ workspace_id: "ws-test", source_file_id: "src-1",
        block_ids: ["blk-1"] }, ctx);
      expect(result.output.tactics).toEqual([]);
      expect(result.output.rejected_candidates).toEqual([{ index: 0, field: "provenance", reason: "quote_not_substring" }]);
      expect(vi.mocked(ctx.complete).mock.calls.map(([request]) => request.purpose))
        .toEqual([expect.stringContaining("proposer"), "snapshot_completeness"]);
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
      withCompleteness(ctx);
      await inventoryExtractModule.run({ workspace_id: "ws-test", source_file_id: "src-1",
        block_ids: ["blk-1"] }, ctx);
      expect(ctx.complete).toHaveBeenCalledTimes(4);
      const proposals = vi.mocked(ctx.complete).mock.calls.filter(([request]) => request.purpose?.includes("proposer"));
      expect(proposals).toHaveLength(2);
      const revisionPrompt = proposals[1]?.[0].user ?? "";
      expect(revisionPrompt).toContain("Registry study:no_quote");
      expect(revisionPrompt).not.toContain("quote_not_substring");
      expect(events.filter((event) => event.event_type === "snapshot").map((event) => event.signals.invariant_failures)).toEqual([
        ["Registry study:no_quote"],
        ["Registry study:no_quote"],
      ]);
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
      source_complete: true,
    });
    expect(result.summary).toContain("SYNAPSE_TEST_STUB_LLM");
  });

  it("calls the live LLM when stub is off", async () => {
    const prev = process.env.SYNAPSE_TEST_STUB_LLM;
    process.env.SYNAPSE_TEST_STUB_LLM = "0";
    try {
      vi.mocked(readParseBlocksByIds).mockResolvedValueOnce([{ id: "blk-1", source_file_id: "src-1",
        workspace_id: "ws-test", index: 0, kind: "prose", heading: null, text: "Phase 3 study ongoing in NSCLC.", parser: "test", created_at: "now" }]);
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
