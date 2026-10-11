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
  it.each([
    { passes: 1, versions: [0, 1] },
    { passes: 2, versions: [0, 1, 2] },
    { passes: 3, versions: [0, 1, 2, 3] },
  ])("retains exactly $passes revisions despite a clean critic and a zero module budget", async ({ passes, versions }) => {
    const { run, events, charge } = recordingRun();
    Object.assign(run, { evaluation_context: "experiment", experiment_cycle_control: { critic_revision_passes: passes } });
    const result = await runShallowAgenticCycle({ run, maxExchanges: 0, onSnapshot: async () => signals,
      proposer: async round => { charge(3, 0.03); return { round }; },
      critic: async () => { charge(2, 0.02); return { score: 1, issues: [] }; },
      onCompleteness: async () => clean, judge: async draft => draft,
    });
    expect(result.final).toEqual({ round: passes });
    expect(events.filter(event => event.event_type === "snapshot").map(event => event.iteration)).toEqual(versions);
    expect(events.filter(event => event.event_type === "critique").map(event => event.iteration)).toEqual(versions);
    expect(events.at(-1)).toMatchObject({ event_type: "judgment", selected_iteration: passes });
    expect(events.filter(event => event.event_type === "snapshot").every(event => event.evaluation_context === "experiment" && event.token_usage.total_tokens === 3)).toBe(true);
    expect(result.trace.filter(entry => entry.endsWith(":reviser"))).toHaveLength(passes);
  });

  it.each([
    { context: "production", passes: 1 },
    { context: "experiment", passes: 0 },
    { context: "experiment", passes: 4 },
    { context: "experiment", passes: 1.5 },
    { context: "experiment", passes: "2" },
    { context: "experiment", passes: null },
  ])("rejects invalid trusted control $context/$passes before proposal", async ({ context, passes }) => {
    const { run, events } = recordingRun();
    Object.assign(run, { evaluation_context: context, experiment_cycle_control: { critic_revision_passes: passes } });
    let proposed = false;
    await expect(runShallowAgenticCycle({ run, onSnapshot: async () => signals,
      proposer: async () => { proposed = true; return { value: "V0" }; },
      critic: async () => ({ score: 1, issues: [] }), judge: async draft => draft,
    })).rejects.toThrow();
    expect(proposed).toBe(false);
    expect(events).toEqual([]);
  });

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


describe("retained snapshot selection", () => {
  it("selects V0 on production early exit with only produced candidates and its exact assessment", async () => {
    const { run, events } = recordingRun();
    const result = await runShallowAgenticCycle({ run,
      onSnapshot: async () => signals,
      proposer: async round => ({ round, text: "V0 supported source" }),
      critic: async () => ({ score: 1, issues: [] }), onCompleteness: async () => clean,
      judge: async draft => draft,
      select: async candidates => {
        expect(candidates.map(candidate => candidate.iteration)).toEqual([0]);
        return { selected_iteration: 0, reason: "Produced V0 already passes all checks" };
      },
    });
    expect(result).toMatchObject({ final: { round: 0, text: "V0 supported source" }, selected_iteration: 0 });
    expect(result.selected_assessment).toEqual({ score: 1, issues: [], completeness: clean,
      structural_fate: { status: "assessed", check: null, prior_issue_resolutions: [] } });
    expect(events.map(event => event.event_type)).toEqual(["snapshot", "critique", "judgment"]);
    expect(events.at(-1)).toMatchObject({ selected_iteration: 0, reason: "Produced V0 already passes all checks" });
  });
  it("returns exact earlier content and assessment and records its explainable selection", async () => {
    // Break caught: judging only the terminal draft, or accepting replacement content.
    const { run, events } = recordingRun();
    Object.assign(run, { evaluation_context: "experiment", experiment_cycle_control: { critic_revision_passes: 3 } });
    const priors: unknown[] = [];
    const result = await runShallowAgenticCycle({ run, onSnapshot: async () => ({ ...signals, quote_validity: { valid_count: 1, invalid_count: 0, unchecked_count: 0 } }),
      proposer: async (round, prior) => { priors.push(prior); return { round, text: `V${round}` }; },
      critic: async () => ({ score: 1, issues: [] }), onCompleteness: async () => clean,
      judge: async draft => draft,
      select: async candidates => {
        expect(candidates.map(candidate => candidate.iteration)).toEqual([0, 1, 2, 3]);
        expect(candidates[1]).toMatchObject({ draft: { round: 1, text: "V1" }, assessment: { completeness: clean } });
        return { selected_iteration: 1, reason: "V1 retains the supported source claim" };
      },
    });
    expect(priors).toEqual([null, { round: 0, text: "V0" }, { round: 1, text: "V1" }, { round: 2, text: "V2" }]);
    expect(result.final).toEqual({ round: 1, text: "V1" });
    expect(result.selected_assessment).toMatchObject({ completeness: clean });
    expect(events.at(-1)).toMatchObject({ event_type: "judgment", selected_iteration: 1,
      reason: "V1 retains the supported source claim" });
  });
});


describe("validated selection failures", () => {
  it.each([
    { selected_iteration: 9, reason: "Missing version" },
    { selected_iteration: -1, reason: "Negative version" },
    { selected_iteration: 0.5, reason: "Fractional version" },
    { selected_iteration: 0, reason: "   " },
    { selected_iteration: 0, reason: "Replace it", content: { value: "fabricated" } },
    null,
  ])("rejects invalid decision %j without a judgment", async decision => {
    const { run, events } = recordingRun();
    await expect(runShallowAgenticCycle({ run, maxExchanges: 0, onSnapshot: async () => ({ ...signals, quote_validity: { valid_count: 1, invalid_count: 0, unchecked_count: 0 } }),
      proposer: async () => ({ value: "V0" }), critic: async () => ({ score: 1, issues: [] }),
      onCompleteness: async () => clean, judge: async draft => draft,
      select: async () => decision,
    })).rejects.toThrow();
    expect(events.map(event => event.event_type)).toEqual(["snapshot", "critique"]);
  });

  it.each(["invalid", "unchecked", "invariant", "failed", "unassessed", "uninspected"])("rejects %s evidence without a judgment", async kind => {
    const { run, events } = recordingRun();
    await expect(runShallowAgenticCycle({ run, maxExchanges: 0,
      onSnapshot: async () => ({ ...signals, quote_validity: { valid_count: 1,
        invalid_count: kind === "invalid" ? 1 : 0, unchecked_count: kind === "unchecked" ? 1 : 0 },
        invariant_failures: kind === "invariant" ? ["wrong_origin"] : [] }),
      proposer: async () => ({ value: "V0" }), critic: async () => ({ score: 1, issues: [] }),
      onCompleteness: kind === "unassessed" ? undefined : async () => kind === "failed"
        ? { ...clean, risk_level: "check_failed" } : kind === "uninspected" ? { ...clean, checked_block_ids: [] } : clean,
      judge: async draft => draft, select: async () => ({ selected_iteration: 0, reason: "Use V0" }),
    })).rejects.toThrow();
    expect(events.map(event => event.event_type)).toEqual(["snapshot", "critique"]);
  });

  it("propagates provider selection failure and preserves all preceding observations", async () => {
    const { run, events } = recordingRun();
    await expect(runShallowAgenticCycle({ run, maxExchanges: 0, onSnapshot: async () => ({ ...signals, quote_validity: { valid_count: 1, invalid_count: 0, unchecked_count: 0 } }),
      proposer: async () => ({ value: "V0" }), critic: async () => ({ score: 1, issues: [] }),
      onCompleteness: async () => clean, judge: async draft => draft,
      select: async () => { throw new Error("judge provider failed"); },
    })).rejects.toThrow("judge provider failed");
    expect(events.map(event => event.event_type)).toEqual(["snapshot", "critique"]);
  });

  it("isolates retained snapshots from sequential proposer mutation", async () => {
    const { run, events } = recordingRun();
    const reused = { value: "V0", nested: { quote: "source" } };
    const result = await runShallowAgenticCycle<typeof reused>({ run, maxExchanges: 1, onSnapshot: async () => ({ ...signals, quote_validity: { valid_count: 1, invalid_count: 0, unchecked_count: 0 } }),
      proposer: async (round, prior) => {
        if (round) { prior!.nested.quote = "mutated prior"; reused.value = "V1"; }
        return reused;
      },
      critic: async () => ({ score: 0.8, issues: [] }), onCompleteness: async () => clean,
      judge: async draft => draft, select: async candidates => {
        expect(Object.isFrozen(candidates[0].draft.nested)).toBe(true);
        return { selected_iteration: 0, reason: "Preserve V0 source" };
      },
    });
    reused.nested.quote = "external mutation";
    expect(result.final).toEqual({ value: "V0", nested: { quote: "source" } });
    expect(events[0]).toMatchObject({ output: { value: "V0", nested: { quote: "source" } } });
  });
});
