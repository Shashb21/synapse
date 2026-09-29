import { describe, expect, it, vi } from "vitest";
import { inspectQuoteSpans, runShallowAgenticCycle } from "@/accuracy/kernel/agentic";
import type { AgentEvent, ProductionSignals } from "@/accuracy/kernel/agent-events";
import type { RunHandle, TokenUsage } from "@/accuracy/kernel/contracts";

const zero: TokenUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
const signals: ProductionSignals = {
  quote_validity: { valid_count: 0, invalid_count: 0, unchecked_count: 0 },
  invariant_failures: [], completeness: "not_checked",
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
      judge: async (draft) => { charge(1, 0.01); return draft; },
    });
    expect(result.final).toEqual({ value: "exact V0" });
    expect(events.map((event) => event.event_type)).toEqual(["snapshot", "critique", "judgment"]);
    expect(events[0]).toMatchObject({ iteration: 0, output: { value: "exact V0" },
      evaluation_context: "production", signals, token_usage: { total_tokens: 3 }, cost_usd: 0.03 });
    expect(events[1]).toMatchObject({ iteration: 0, token_usage: { total_tokens: 2 }, cost_usd: 0.02 });
    expect(events[2]).toMatchObject({ selected_iteration: 0, token_usage: { total_tokens: 1 }, cost_usd: 0.01 });
    expect(JSON.stringify(events)).not.toMatch(/precision|recall|f1/i);
  });

  it("records a revision and passes human-readable claims to proposer", async () => {
    const { run, events, charge } = recordingRun();
    const now = vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValueOnce(11)
      .mockReturnValueOnce(20).mockReturnValueOnce(27)
      .mockReturnValueOnce(30).mockReturnValueOnce(43)
      .mockReturnValueOnce(50).mockReturnValueOnce(55);
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
      expect(events.map((event) => event.event_type)).toEqual(["snapshot", "critique", "snapshot", "judgment"]);
      expect(events[0]).toMatchObject({ latency_ms: 11, token_usage: { total_tokens: 3 }, cost_usd: 0.03 });
      expect(events[1]).toMatchObject({ latency_ms: 7, token_usage: { total_tokens: 2 }, cost_usd: 0.02 });
      expect(events[2]).toMatchObject({ latency_ms: 13, token_usage: { total_tokens: 5 }, cost_usd: 0.05 });
      expect(events[3]).toMatchObject({ latency_ms: 5, token_usage: { total_tokens: 1 }, cost_usd: 0.01 });
      expect(events[3]).toMatchObject({ selected_iteration: 1 });
      expect(result.final).toEqual({ round: 1 });
    } finally { now.mockRestore(); }
  });

  it("keeps V0 when the critic fails", async () => {
    const { run, events } = recordingRun();
    await expect(runShallowAgenticCycle({ run, onSnapshot: async () => signals,
      proposer: async () => ({ value: "V0" }), critic: async () => { throw new Error("critic failed"); },
      judge: async (draft) => draft,
    })).rejects.toThrow("critic failed");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event_type: "snapshot", output: { value: "V0" } });
  });
});
