/** Native generation contracts: exact IDs, explicit scoring and draft-only splitting. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccuracyModuleContext } from "@/accuracy/kernel/contracts";
const f = vi.hoisted(() => ({ claims: [] as Array<Record<string, unknown>>, coverage: [] as Array<Record<string, unknown>>, patches: [] as Array<Record<string, unknown>> }));
vi.mock("@/accuracy/store/claim-store", () => ({
  getClaimsByIds: async (_: string, ids: string[]) => f.claims.filter(row => ids.includes(String(row.id))),
  listDownstreamClaims: async () => f.claims,
  claimMetadata: (row: { metadata: object }) => row.metadata,
  updateClaimMetadata: async (args: Record<string, unknown>) => { f.patches.push(args); return args; },
}));
vi.mock("@/accuracy/store/coverage-store", () => ({ listCoverageJoins: async () => f.coverage }));
vi.mock("@/accuracy/store/parse-store", () => ({ readParseBlocksByIds: async () => [{ id: "b", source_file_id: "s", workspace_id: "w", text: "Registry supports survival evidence; quality of life remains missing." }] }));
import { withAssemblyExperiment } from "@/accuracy/kernel/assembly-context";
import { partialSplitModule, benchmarkPrioritizeModule as prioritizeModule, splitChildIds } from "@/accuracy/modules/partial-split/module";
const complete = vi.fn();
const ctx = { workspace_id: "w", run: { id: "run", note: vi.fn(), step: async (_name: string, operation: () => Promise<unknown>) => operation() }, route: { connected: true, auth: "api_key" }, complete } as unknown as AccuracyModuleContext;
beforeEach(() => {
  vi.stubEnv("SYNAPSE_TEST_STUB_LLM", "0"); complete.mockReset(); f.patches.length = 0;
  f.claims = [{ id: "g", claim_type: "gap", validated: true, statement: "Survival and quality of life evidence before launch", metadata: { statement: "Survival and quality of life evidence before launch", provenance: [{ source_file_id: "s", block_id: "b", quote: "quality of life remains missing" }] } }, { id: "t", claim_type: "tactic", validated: true, statement: "Survival registry", metadata: { name: "Survival registry", status: "planned" } }];
  f.coverage = [{ id: "c", gap_id: "g", tactic_id: "t", overall: "partial", validated: true, rationale: "Survival only" }];
});
import { materializeSplit } from "@/accuracy/modules/partial-split/materialize";

describe("native partial and priority modules", () => {
  it("child_ids_are_stable_for_retries_and_distinct_across_parents", () => {
    expect(splitChildIds("run", "g")).toEqual(splitChildIds("run", "g"));
    expect(splitChildIds("run", "g")).not.toEqual(splitChildIds("run", "other"));
  });
  it("production_cannot_materialize_even_a_passing_split", async () => {
    await expect(materializeSplit({ workspace_id: "w", run_id: "r", output: {} as never, passing_gate: true })).rejects.toThrow(/experiment-only/);
  });
  it("deterministic_priority_reuses_cues_with_explicit_evidence", async () => {
    vi.stubEnv("SYNAPSE_TEST_STUB_LLM", "1");
    const result = await withAssemblyExperiment(() => prioritizeModule.run({ workspace_id: "w", gap_ids: ["g"] }, ctx));
    expect(result.output).toMatchObject({ mode: "deterministic", placements: [{ gap_id: "g", mode: "deterministic", axis_scores: { decision_impact: 50, time_pressure: 50 } }] });
    expect(complete).not.toHaveBeenCalled();
  });
  it("scores_exact_requested_ids_and_persists_full_scoring_evidence", async () => {
    complete.mockImplementation(async request => { const input = JSON.parse(request.user);
      return { raw: JSON.stringify(input.placements ? { reviews: [{ gap_id: "g", verdict: "keep", confidence: 90, note: "Source supports each axis" }] }
        : { gaps: [{ gap_id: "g", scores: Object.fromEntries(input.axes.map((axis: { id: string }) => [axis.id, 90])), rationale: "Launch decision needs evidence." }] }) };
    });
    const result = await withAssemblyExperiment(() => prioritizeModule.run({ workspace_id: "w", gap_ids: ["g"] }, ctx));
    expect(result.output).toMatchObject({ mode: "llm", placements: [{ gap_id: "g", band: "high", score: 90, rationale: "Launch decision needs evidence." }] });
    expect(f.patches[0]).toMatchObject({ claim_id: "g", metadata: { priority_band: "high", priority: "high", priority_scoring: { axis_scores: { decision_impact: 90 }, mode: "llm" } } });
  });
  it("retained_benchmark_refuses_production_without_replacing_accepted_priority", async () => {
    vi.stubEnv("SYNAPSE_TEST_STUB_LLM", "1");
    f.claims[0].metadata = { ...(f.claims[0].metadata as object), priority: "low", priority_band: "low", priority_origin: "workshop" };
    await expect(prioritizeModule.run({ workspace_id: "w", gap_ids: ["g"] }, ctx)).rejects.toThrow(/experiment-only/);
    expect(f.patches).toEqual([]);
    expect(f.claims[0].metadata).toMatchObject({ priority: "low", priority_band: "low", priority_origin: "workshop" });
  });
  it("prioritizes_computed_addressed_gap_with_retained_open_override", async () => {
    vi.stubEnv("SYNAPSE_TEST_STUB_LLM", "1");
    f.claims[0].metadata = { ...(f.claims[0].metadata as object), computed_status: "addressed", status_override: { status: "open", rationale: "Review retained an open need." } };
    const result = await withAssemblyExperiment(() => prioritizeModule.run({ workspace_id: "w", gap_ids: ["g"] }, ctx));
    expect(result.output.placements.map(row => row.gap_id)).toEqual(["g"]);
    expect(f.patches[0]).toMatchObject({ metadata: { computed_status: "addressed", status_override: { status: "open" } } });
  });
  it("rejects_computed_open_gap_with_retained_addressed_override", async () => {
    vi.stubEnv("SYNAPSE_TEST_STUB_LLM", "1");
    f.claims[0].metadata = { ...(f.claims[0].metadata as object), computed_status: "open", status_override: { status: "addressed", rationale: "Review closed the need." } };
    await expect(withAssemblyExperiment(() => prioritizeModule.run({ workspace_id: "w", gap_ids: ["g"] }, ctx))).rejects.toThrow(/eligible/);
    expect(f.patches).toEqual([]);
  });
  it("rejects_missing_nonfinite_or_crossed_scores_before_mutation", async () => {
    complete.mockResolvedValue({ raw: JSON.stringify({ gaps: [{ gap_id: "other", scores: { decision_impact: 100 }, rationale: "Wrong gap" }] }) });
    await expect(withAssemblyExperiment(() => prioritizeModule.run({ workspace_id: "w", gap_ids: ["g"] }, ctx))).rejects.toThrow();
    expect(f.patches).toEqual([]);
  });
  it("proposes_two_distinct_children_bound_to_committed_support_without_mutating", async () => {
    complete.mockResolvedValue({ raw: JSON.stringify({ addressed: { statement: "Survival evidence from the registry" }, residual: { statement: "Quality of life evidence still needed" }, tactic_ids: ["t"], coverage_ids: ["c"], rationale: "Registry covers survival only", source_context: [{ source_file_id: "s", block_id: "b", quote: "quality of life remains missing" }] }) });
    const result = await withAssemblyExperiment(() => partialSplitModule.run({ workspace_id: "w", gap_id: "g" }, ctx));
    expect("addressed_gap_id" in result.output && result.output.addressed_gap_id).not.toBe("g");
    expect(result.output).toMatchObject({ addressed: { parent_gap_id: "g", branch: "addressed" }, residual: { parent_gap_id: "g", branch: "open" }, tactic_ids: ["t"], coverage_ids: ["c"] });
    expect(f.patches).toEqual([]);
  });
  it("refuses_proposed_only_partial_support", async () => {
    (f.claims[1].metadata as Record<string, unknown>).status = "proposed";
    await expect(withAssemblyExperiment(() => partialSplitModule.run({ workspace_id: "w", gap_id: "g" }, ctx))).rejects.toThrow(/committed/);
    expect(complete).not.toHaveBeenCalled();
  });
});
