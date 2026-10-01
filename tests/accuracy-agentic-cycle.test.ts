import { describe, expect, it, vi } from "vitest";
import { inspectQuoteSpans, runShallowAgenticCycle } from "@/accuracy/kernel/agentic";
import type { AgentEvent, ProductionSignals } from "@/accuracy/kernel/agent-events";
import type { RunHandle, TokenUsage } from "@/accuracy/kernel/contracts";
import type { SnapshotCompletenessAssessment, SuspectedOmission } from "@/accuracy/modules/completeness-audit/snapshot-inspector";

const zero: TokenUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
const signals: ProductionSignals = {
  quote_validity: { valid_count: 0, invalid_count: 0, unchecked_count: 0 },
  invariant_failures: [], completeness: "not_checked",
};
const clean: SnapshotCompletenessAssessment = {
  risk_level: "none_detected", checked_block_ids: ["block-1"], unchecked_block_ids: [],
  suspected_omissions: [], prior_issue_resolutions: [],
};
const important: SuspectedOmission = {
  issue_id: "omission-1", item_kind: "gap", summary: "Regional need",
  source_ref: { source_file_id: "file-1", block_id: "block-1" },
  evidence_quote: "Regional need is documented", basis: "explicit", importance: "important",
  reason: "Missing from snapshot", suggested_action: "Add the regional gap",
};

function recordingRun() {
  const events: AgentEvent[] = [];
  let usage = { ...zero };
  let cost = 0;
  const run: RunHandle = {
    id: "run-1", step: async (_name, fn) => fn(), note: () => {}, steps: () => [],
    recordAgentEvent: async (event) => { events.push(event); },
    usageSummary: () => ({ token_usage: { ...usage }, cost_usd: cost }),
  };
  const charge = (tokens: number, dollars: number) => {
    usage = { prompt_tokens: usage.prompt_tokens + tokens, completion_tokens: usage.completion_tokens,
      total_tokens: usage.total_tokens + tokens };
    cost += dollars;
  };
  return { run, events, charge };
}

describe("agentic version capture", () => {
  it("rejects an invalid revision budget before producing a snapshot", async () => {
    const { run, events } = recordingRun();
    await expect(runShallowAgenticCycle({ run, onSnapshot: async () => signals,
      maxExchanges: -1, proposer: async () => ({ value: "V0" }),
      critic: async () => ({ score: 1, issues: [] }), judge: async (draft) => draft,
    })).rejects.toThrow("maxExchanges must be a nonnegative integer");
    expect(events).toEqual([]);
  });
  it("counts missing source blocks as unchecked instead of invalid", () => {
    const inspected = inspectQuoteSpans({
      blocks: [{ id: "B1", source_file_id: "F1", text: "Verified source quote" }],
      spans: [
        { source_file_id: "F1", block_id: "B1", quote: "Verified source quote" },
        { source_file_id: "F1", block_id: "B2", quote: "Cannot inspect" },
      ],
    });
    expect(inspected.signals).toEqual({ valid_count: 1, invalid_count: 0, unchecked_count: 1 });
    expect(inspected.findings).toEqual([]);
  });
  it("records V0, critique, and latest-version judgment on early exit", async () => {
    const { run, events, charge } = recordingRun();
    const result = await runShallowAgenticCycle({
      run, onSnapshot: async () => signals,
      proposer: async () => { charge(3, 0.03); return { value: "exact V0" }; },
      critic: async () => { charge(2, 0.02); return { score: 0.9, issues: [] }; },
      onCompleteness: async () => { charge(4, 0.04); return clean; },
      judge: async (draft) => { charge(1, 0.01); return draft; },
    });
    expect(result.final).toEqual({ value: "exact V0" });
    expect(events.map((event) => event.event_type)).toEqual(["snapshot", "critique", "judgment"]);
    expect(events[0]).toMatchObject({ iteration: 0, output: { value: "exact V0" },
      evaluation_context: "production", signals, token_usage: { total_tokens: 3 }, cost_usd: 0.03 });
    expect(events[1]).toMatchObject({ iteration: 0, completeness: clean,
      token_usage: { total_tokens: 6 }, cost_usd: 0.06 });
    expect(events[2]).toMatchObject({ selected_iteration: 0, token_usage: { total_tokens: 1 }, cost_usd: 0.01 });
    expect(JSON.stringify(events)).not.toMatch(/precision|recall|f1/i);
  });

  it("records not applicable when no completeness callback is supplied", async () => {
    const { run, events } = recordingRun();
    await runShallowAgenticCycle({ run, onSnapshot: async () => signals,
      proposer: async () => ({ value: "V0" }), critic: async () => ({ score: 1, issues: [] }),
      judge: async (draft) => draft,
    });
    expect(events[1]).toMatchObject({ event_type: "critique", completeness: {
      risk_level: "not_applicable", checked_block_ids: [], unchecked_block_ids: [],
      suspected_omissions: [], prior_issue_resolutions: [],
    } });
  });

  it("revises important omissions with source evidence and assesses terminal V1", async () => {
    const { run, events, charge } = recordingRun();
    const feedback: string[][] = [];
    const prior: SuspectedOmission[][] = [];
    let criticCalls = 0;
    const result = await runShallowAgenticCycle<{ round: number }>({
      run, onSnapshot: async () => signals,
      proposer: async (round, _draft, critiques) => { feedback.push(critiques); charge(3, 0.03); return { round }; },
      critic: async () => { criticCalls++; charge(2, 0.02); return { score: 0.95, issues: [] }; },
      onCompleteness: async (_draft, previous) => {
        prior.push(previous); charge(5, 0.05);
        return previous.length ? { ...clean, prior_issue_resolutions: [{ issue_id: important.issue_id,
          outcome: "resolved", reason: "Added as gap-1", matched_item_ref: "gap-1" }] }
          : { ...clean, risk_level: "important", suspected_omissions: [important] };
      },
      judge: async (draft) => draft,
    });
    expect(result.final).toEqual({ round: 1 });
    expect(feedback).toHaveLength(2);
    expect(feedback[1].join(" ")).toContain("gap");
    expect(feedback[1].join(" ")).toContain("file-1");
    expect(feedback[1].join(" ")).toContain("block-1");
    expect(feedback[1].join(" ")).toContain(important.evidence_quote);
    expect(feedback[1].join(" ")).toContain(important.suggested_action);
    expect(prior).toEqual([[], [important]]);
    expect(criticCalls).toBe(2);
    expect(events.map((event) => event.event_type)).toEqual(["snapshot", "critique", "snapshot", "critique", "judgment"]);
    expect(events[1]).toMatchObject({ score: 0.95, token_usage: { total_tokens: 7 }, cost_usd: 0.07,
      issues: [{ issue_id: important.issue_id, source_ref: important.source_ref }] });
    expect(events[3]).toMatchObject({ score: 0.95, token_usage: { total_tokens: 7 }, cost_usd: 0.07,
      completeness: { prior_issue_resolutions: [{ issue_id: important.issue_id, outcome: "resolved" }] } });
    expect(events[4]).toMatchObject({ selected_iteration: 1 });
  });

  it("does not revise for advisory omissions and preserves the assessment", async () => {
    const { run, events } = recordingRun();
    const proposer = vi.fn(async () => ({ value: "V0" }));
    await runShallowAgenticCycle({ run, onSnapshot: async () => signals, proposer,
      critic: async () => ({ score: 0.9, issues: [] }),
      onCompleteness: async () => ({ ...clean, risk_level: "advisory",
        suspected_omissions: [{ ...important, basis: "inferred", importance: "advisory" }] }),
      judge: async (draft) => draft,
    });
    expect(proposer).toHaveBeenCalledTimes(1);
    expect(events.map((event) => event.event_type)).toEqual(["snapshot", "critique", "judgment"]);
    expect(events[1]).toMatchObject({ issues: [], completeness: { risk_level: "advisory" } });
  });

  it("assesses terminal V0 and preserves completeness check failure semantics", async () => {
    const { run, events } = recordingRun();
    const exact = { value: "Exact V0", nested: { evidence: "source text" } };
    const result = await runShallowAgenticCycle({ run, onSnapshot: async () => signals,
      maxExchanges: 0, proposer: async () => exact,
      critic: async () => ({ score: 1, issues: [] }),
      onCompleteness: async () => { throw new Error("inspector unavailable"); },
      judge: async (draft) => draft,
    });
    expect(result.final).toEqual(exact);
    expect(events[0]).toMatchObject({ event_type: "snapshot", output: exact });
    expect(events[1]).toMatchObject({ event_type: "critique", score: 1,
      completeness: { risk_level: "check_failed" } });
  });

  it("records a revision and passes human-readable claims to proposer", async () => {
    const { run, events, charge } = recordingRun();
    const now = vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValueOnce(11)
      .mockReturnValueOnce(20).mockReturnValueOnce(27)
      .mockReturnValueOnce(30).mockReturnValueOnce(43)
      .mockReturnValueOnce(50).mockReturnValueOnce(55)
      .mockReturnValueOnce(60).mockReturnValueOnce(65);
    const received: string[][] = [];
    try {
      const result = await runShallowAgenticCycle<{ round: number }>({
        run, onSnapshot: async () => signals,
        proposer: async (round, _prior, claims) => { received.push(claims); charge(round ? 5 : 3, round ? 0.05 : 0.03); return { round }; },
        critic: async (draft) => { charge(2, 0.02); return { score: draft.round ? 1 : 0.4,
          issues: draft.round ? [] : [{ issue_id: "i1", category: "structure", code: "missing",
            severity: "medium" as const, claim: "Add source quote", suggested_action: "Add quote" }] }; },
        judge: async (draft) => { charge(1, 0.01); return draft; },
      });
      expect(received).toEqual([[], ["Add source quote"]]);
      expect(events.map((event) => event.event_type)).toEqual(["snapshot", "critique", "snapshot", "critique", "judgment"]);
      expect(events[0]).toMatchObject({ latency_ms: 11, token_usage: { total_tokens: 3 }, cost_usd: 0.03 });
      expect(events[1]).toMatchObject({ latency_ms: 7, token_usage: { total_tokens: 2 }, cost_usd: 0.02 });
      expect(events[2]).toMatchObject({ latency_ms: 13, token_usage: { total_tokens: 5 }, cost_usd: 0.05 });
      expect(events[3]).toMatchObject({ score: 1, latency_ms: 5,
        token_usage: { total_tokens: 2 }, cost_usd: 0.02, completeness: { risk_level: "not_applicable" } });
      expect(events[4]).toMatchObject({ latency_ms: 5, token_usage: { total_tokens: 1 }, cost_usd: 0.01 });
      expect(events[4]).toMatchObject({ selected_iteration: 1 });
      expect(result.final).toEqual({ round: 1 });
    } finally { now.mockRestore(); }
  });

  it("assesses and pairs V0 before propagating a structural critic failure", async () => {
    const { run, events, charge } = recordingRun();
    const onCompleteness = vi.fn(async () => { charge(4, 0.04); return clean; });
    const judge = vi.fn(async (draft: { value: string }) => draft);
    await expect(runShallowAgenticCycle({ run, onSnapshot: async () => signals,
      proposer: async () => ({ value: "V0" }),
      critic: async () => { charge(2, 0.02); throw new Error("critic failed"); },
      onCompleteness, judge,
    })).rejects.toThrow("critic failed");
    expect(onCompleteness).toHaveBeenCalledWith({ value: "V0" }, []);
    expect(judge).not.toHaveBeenCalled();
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ event_type: "snapshot", output: { value: "V0" } });
    expect(events[1]).toMatchObject({ event_type: "critique", iteration: 0, score: null,
      issues: [], completeness: clean, token_usage: { total_tokens: 6 }, cost_usd: 0.06 });
  });

  it("keeps the structural error when completeness also fails", async () => {
    const { run, events } = recordingRun();
    await expect(runShallowAgenticCycle({ run, onSnapshot: async () => signals,
      proposer: async () => ({ value: "Exact V0" }),
      critic: async () => { throw new Error("structural critic failed"); },
      onCompleteness: async () => { throw new Error("completeness failed"); },
      judge: async (draft) => draft,
    })).rejects.toThrow("structural critic failed");
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ event_type: "snapshot", output: { value: "Exact V0" } });
    expect(events[1]).toMatchObject({ event_type: "critique", score: null,
      completeness: { risk_level: "check_failed" } });
  });

  it("critics the terminal revision and records its structural issues without revising again", async () => {
    const { run, events } = recordingRun();
    let criticCalls = 0;
    const terminalIssue = { issue_id: "terminal-1", category: "structure" as const,
      code: "missing-heading", severity: "medium" as const,
      claim: "V1 is missing a heading", suggested_action: "Add a heading" };

    const result = await runShallowAgenticCycle<{ round: number }>({
      run, onSnapshot: async () => signals, maxExchanges: 1,
      proposer: async (round) => ({ round }),
      critic: async () => {
        criticCalls++;
        return criticCalls === 1
          ? { score: 0.4, issues: [{ ...terminalIssue, issue_id: "initial-1" }] }
          : { score: 0.8, issues: [terminalIssue] };
      },
      judge: async (draft) => draft,
    });

    expect(result.final).toEqual({ round: 1 });
    expect(criticCalls).toBe(2);
    expect(events.map((event) => event.event_type)).toEqual([
      "snapshot", "critique", "snapshot", "critique", "judgment",
    ]);
    expect(events[3]).toMatchObject({ event_type: "critique", iteration: 1,
      score: 0.8, issues: [terminalIssue] });
  });
});
