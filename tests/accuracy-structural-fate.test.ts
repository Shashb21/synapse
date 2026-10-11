import { describe, expect, it } from "vitest";
import { runShallowAgenticCycle } from "@/accuracy/kernel/agentic";
import type { AgentEvent, CriticIssue } from "@/accuracy/kernel/agent-events";
import type { RunHandle } from "@/accuracy/kernel/contracts";
import { structuralIssueKey } from "@/accuracy/kernel/structural-fate";

const issue: CriticIssue = { issue_id: "pos:0", category: "support", code: "unsupported",
  severity: "high", claim: "Claim A lacks evidence in source/block", suggested_action: "Remove claim A",
  source_ref: { source_file_id: "source", block_id: "block" } };
const signals = { quote_validity: { valid_count: 1, invalid_count: 0, unchecked_count: 0 },
  invariant_failures: [], completeness: "not_checked" as const };
const completeness = { risk_level: "none_detected" as const, checked_block_ids: ["block"],
  unchecked_block_ids: [], suspected_omissions: [], prior_issue_resolutions: [] };
const zero = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

function runFixture() {
  const events: AgentEvent[] = [];
  const run: RunHandle = { id: "run", evaluation_context: "experiment", experiment_cycle_control: { critic_revision_passes: 1 },
    recordAgentEvent: async event => { events.push(event); }, usageSummary: () => ({ token_usage: zero, cost_usd: 0 }),
    step: async (_name, fn) => fn(), note: () => {}, steps: () => [] };
  return { run, events };
}

describe("structural issue fate through the retained cycle", () => {
  it("resolves deterministic findings only after a successful exhaustive rerun and keeps positional IDs independent", async () => {
    const { run, events } = runFixture();
    const second = { ...issue, issue_id: "pos:1", claim: "Claim B lacks evidence" };
    await runShallowAgenticCycle({ run, onSnapshot: async () => signals, proposer: async round => ({ round }),
      critic: async draft => ({ score: 1, issues: draft.round === 0 ? [issue, second] : [{ ...second, issue_id: "pos:0" }],
        check: { id: "support-v1", exhaustive: true } }), judge: async draft => draft });
    const assessed = events.find(event => event.event_type === "critique" && event.iteration === 1);
    expect(assessed).toMatchObject({ issues: [{ ...second, issue_id: "pos:0" }], structural_fate: {
      prior_issue_resolutions: [
        { issue, outcome: "resolved", evidence: { kind: "deterministic_rerun", check_id: "support-v1" }, reason: expect.stringContaining("reran successfully") },
        { issue: second, outcome: "unresolved", reason: expect.any(String) },
      ] } });
  });
  it.each(["resolved", "partly_resolved", "invalid", "unresolved"] as const)("retains an independently validated %s assessment", async outcome => {
    const { run, events } = runFixture();
    const result = await runShallowAgenticCycle({ run, onSnapshot: async () => signals,
      proposer: async round => ({ round, supported: round === 1 }), onCompleteness: async () => completeness,
      critic: async (draft, prior) => ({ score: 1, issues: draft.round === 0 ? [issue] : [],
        prior_issue_resolutions: prior.map(finding => ({ issue_key: structuralIssueKey(finding), issue: finding, outcome,
          reason: "Current source assessment supports this disposition", evidence: { kind: "validated_assessment", explanation: "Source/block reviewed against claim A" } })) }),
      validateStructuralResolution: async draft => draft.supported, judge: async draft => draft });
    expect(events.find(event => event.event_type === "critique" && event.iteration === 1)).toMatchObject({
      structural_fate: { prior_issue_resolutions: [{ issue, outcome, evidence: { kind: "validated_assessment" } }] } });
    expect(result.selected_assessment.issues).toHaveLength(["resolved", "invalid"].includes(outcome) ? 0 : 1);
  });
  it.each(["missing", "duplicate", "malformed", "invalid_evidence", "validation_failed", "check_failed"])("keeps every prior finding unresolved for %s", async failure => {
    const { run, events } = runFixture();
    const error = new Error("check failed");
    const work = runShallowAgenticCycle({ run, onSnapshot: async () => signals, proposer: async round => ({ round }),
      critic: async draft => {
        if (draft.round === 1 && failure === "check_failed") throw error;
        const disposition = { issue_key: structuralIssueKey(issue), issue, outcome: "resolved", reason: "assessed",
          evidence: { kind: "validated_assessment", explanation: "Source/block checked" } };
        return { score: 1, issues: draft.round === 0 ? [issue, { ...issue, issue_id: "other", claim: "Independent finding" }] : [],
          prior_issue_resolutions: failure === "missing" ? [] : failure === "duplicate" ? [disposition, disposition]
            : [{ ...disposition, ...(failure === "malformed" ? { outcome: "nonsense" } : {}),
              ...(failure === "invalid_evidence" ? { evidence: null } : {}) }] };
      }, validateStructuralResolution: async () => { if (failure === "validation_failed") throw new Error("invalid"); return false; },
      judge: async draft => draft });
    if (failure === "check_failed") await expect(work).rejects.toBe(error); else await work;
    const event = events.find(event => event.event_type === "critique" && event.iteration === 1);
    expect(event).toMatchObject({ issues: expect.arrayContaining([issue]), structural_fate: {
      prior_issue_resolutions: [{ outcome: "unresolved", reason: expect.any(String) }, { outcome: "unresolved", reason: expect.any(String) }] } });
  });
  it("retains a disappeared model blocker and rejects selection without a supported disposition", async () => {
    const { run, events } = runFixture();
    await expect(runShallowAgenticCycle({ run, onSnapshot: async () => signals,
      proposer: async round => ({ round }), onCompleteness: async () => completeness,
      critic: async draft => ({ score: 1, issues: draft.round === 0 ? [issue] : [] }),
      select: async () => ({ selected_iteration: 1, reason: "Disappeared" }),
    })).rejects.toThrow("inadmissible");
    expect(events.at(-1)).toMatchObject({ event_type: "critique", iteration: 1, issues: [issue],
      structural_fate: { status: "assessed", prior_issue_resolutions: [{ issue, outcome: "unresolved", reason: expect.any(String) }] } });
  });
});
