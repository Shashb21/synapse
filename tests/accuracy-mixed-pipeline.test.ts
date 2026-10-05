import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { readAgentProgression } from "@/accuracy/kernel/agent-events";
import { readParseBlocksByIds } from "@/accuracy/store/parse-store";
import { captureMixedPipelineConfiguration, runMixedCandidatePipeline } from "@/accuracy/experiments/mixed-pipeline";
import { MIXED_GATE_POLICY, MIXED_GATE_POLICY_FINGERPRINT, MIXED_PIPELINE_STAGES, mixedCandidateEvidenceSchema, type MixedCandidateEvidence } from "@/accuracy/experiments/mixed-types";

const f = vi.hoisted(() => ({ calls: [] as Record<string, unknown>[], evaluations: [] as Record<string, unknown>[], inputs: [] as Record<string, unknown>[], drift: false, actualDrift: false, fail: "", overall: "full", review: false, evaluateFail: false, evaluateFailStage: "", emptyPairs: false, inventory: [] as Record<string, unknown>[] }));
vi.mock("@/accuracy", () => ({ registerAccuracyStack: vi.fn() }));
vi.mock("@/accuracy/kernel/registry", () => ({ activeAccuracyModule: async (kind: string) => ({ manifest: { id: `${kind}.fixture`, version: f.drift ? "2" : "1", agentic: ["coverage_decide", "coverage_critic", "ideate", "partial_split", "prioritize"].includes(kind) }, inputSchema: z.any(), outputSchema: z.any(), run: async () => ({}) }) }));
vi.mock("@/accuracy/kernel/routing", () => ({ resolveAccuracyRoute: async ({ call_kind, agent_role }: { call_kind: string; agent_role: string }) => ({ call_kind, role: agent_role, provider_id: "fixture", model: "fixture", params: { temperature: 0, max_tokens: 100 }, fallbacks: [], connected: false, auth: "none", degraded: false, reason: null, provider_label: "fixture" }), accuracyRouteConfig: async () => ({ provider_id: "fixture", model: "fixture", params: { temperature: 0, max_tokens: 100 }, fallbacks: [] }) }));
vi.mock("@/accuracy/kernel/observability", () => ({ reservedAccuracyRun: async () => null }));
vi.mock("@/accuracy/kernel/agent-events", () => ({ readAgentProgression: async () => ({ events: [] }) }));
vi.mock("@/accuracy/store/tenant", () => ({ getWorkspaceOrgId: async () => "copy-org" }));
vi.mock("@/accuracy/store/parse-store", () => ({ readParseBlocksByIds: async () => [{ id: "cb", workspace_id: "copy", source_file_id: "cs", index: 0, kind: "prose", heading: null, text: "Selected evidence." }] }));
vi.mock("@/accuracy/store/claim-store", () => ({ claimMetadata: (row: { metadata: object }) => row.metadata, getClaimsByIds: async (_: string, ids: string[]) => ids.map(id => ({ id, claim_type: id === "ct" ? "tactic" : "gap", validated: true, metadata: id === "ct" ? { tactic_status: "completed" } : {} })), listDownstreamClaims: async () => f.inventory.map(row => ({ id: row.claim_id, claim_type: row.claim_type, validated: true, statement: (row.payload as Record<string, unknown>).name ?? (row.payload as Record<string, unknown>).statement, metadata: row.payload })) }));
vi.mock("@/accuracy/store/coverage-store", () => ({ insertCoverageJoin: async (args: object) => ({ id: "coverage", ...args }), listCoverageJoins: async () => [] }));
vi.mock("@/accuracy/experiments/records", () => ({ getExperiment: async () => ({ calls: f.calls, evaluations: f.evaluations }), recordExperimentCall: async (args: Record<string, unknown>) => { const row = structuredClone({ ...args, output: args.output ?? null, output_error: args.output_error ?? null }); f.calls.push(row); return row; }, recordVersionEvaluation: async (args: Record<string, unknown>) => { if (f.evaluateFail || (args.evaluation as { call_kind: string }).call_kind === f.evaluateFailStage) throw new Error("evaluator unavailable"); f.evaluations.push(args); return args; } }));
vi.mock("@/accuracy/eval/experiment-gold", () => ({ evaluateExperimentVersion: (args: object) => ({ ...args, status: "gold_not_applicable" }) }));
vi.mock("@/accuracy/kernel/run", () => ({ runAccuracyModule: async (args: Record<string, unknown>) => {
  f.inputs.push(args); const kind = args.call_kind as string; if (f.fail === kind) throw new Error(`failed ${kind}`);
  const input = args.input as Record<string, unknown>;
  const output = kind === "pair_generate" ? { pairs: (input.fixture_empty || f.emptyPairs) ? [] : (f.inputs.some(row => (row.input as Record<string, unknown>).claim_ids && ((row.input as Record<string, unknown>).claim_ids as string[]).includes("cg")) ? [{ gap_id: "cg", tactic_id: "ct" }] : []) } :
    kind === "coverage_decide" ? { gap_id: "cg", tactic_id: "ct", overall: f.overall, confidence: 1, quote_block_ids: ["cb"], rationale: "Exact evidence" } :
    kind === "coverage_critic" ? { accept: !f.review, issues: f.review ? ["Model advisory"] : [] } :
    kind === "validation_gate" ? { claim_ids: input.claim_ids, action: "validate", validated: (input.claim_ids as string[]).length } :
    kind === "status_derive" ? { statuses: (input.gap_ids as string[]).map(gap_id => ({ gap_id, status: f.overall === "full" ? "addressed" : f.overall === "partial" ? "partial" : "open", computed: f.overall === "full" ? "addressed" : f.overall === "partial" ? "partial" : "open", override: false })), open: f.overall === "not_relevant" ? 1 : 0, partial: f.overall === "partial" ? 1 : 0, addressed: f.overall === "full" ? (input.gap_ids as string[]).length : 0 } :
    kind === "partial_split" ? { addressed_gap_id: "cg", open_residual_gap_id: "cg-R" } : kind === "prioritize" ? { placements: [] } :
    kind === "ideate" ? { mode: "stub", eligible_gap_ids: [], proposals: [] } : { workspace_id: "copy", activities: [{ id: "ACT-ct", tactic_id: "ct", start: "2026-01-01", end: String((f.inventory.find(row => row.claim_id === "ct")!.payload as Record<string, unknown>).end), readout: null, depends_on: [], gap_ids: f.inventory.some(row => row.claim_id === "cg") && f.overall !== "not_relevant" ? ["cg"] : [] }] };
  return { run_id: args.reserved_run_id, module_id: `${kind}.fixture`, module_version: f.actualDrift ? "2" : "1", output, route: { call_kind: kind, role: ["coverage_decide", "coverage_critic", "ideate", "partial_split", "prioritize"].includes(kind) ? "proposer" : "none", provider_id: "fixture", model: "fixture", params: { temperature: 0, max_tokens: 100 }, fallbacks: [], connected: false, auth: "none", degraded: false, reason: null, provider_label: "fixture" }, token_usage: { prompt_tokens: 1, completion_tokens: 2 }, cost_usd: 0 };
} }));
const actor = { name: "fixture", function: "medical_affairs" as const };
async function candidate(gap = false, end = "2026-12-01"): Promise<MixedCandidateEvidence> {
  const provenance = [{ source_file_id: "s", block_id: "b", quote: "Selected evidence." }];
  const payloads = [{ id: "t", name: "Selected tactic", type: "rwe_study", status: "completed", origin: "inventory", evidence_question: "Question?", provenance, start: "2026-01-01", end }, ...(gap ? [{ id: "g", statement: "Selected gap", external_id: null, provenance }] : [])];
  const items = payloads.map((payload, index) => ({ id: `v${index}`, claim_id: payload.id, run_id: `r${index}`, snapshot_id: null, iteration: null, item_index: 0, payload, source_file_id: "s", created_at: "now", claim_type: index ? "gap" : "tactic", canonical_claim_id: payload.id, reason: "Selected" }));
  const lineage = items.map(item => ({ kind: "selected", original_item_version_id: item.id, original_claim_id: item.claim_id, original_run_id: item.run_id, original_snapshot_id: null, original_iteration: null, original_item_index: 0, selection_reason: "Selected", copied_claim_id: `c${item.claim_id}`, copied_evidence_ids: [`p${item.id}`], original_payload: item.payload, copied_payload: { ...item.payload, id: `c${item.claim_id}`, provenance: [{ source_file_id: "cs", block_id: "cb", quote: "Selected evidence." }] } }));
  f.inventory = structuredClone(lineage.map((row, index) => ({ claim_id: row.copied_claim_id, claim_type: items[index].claim_type, payload: row.copied_payload })));
  return mixedCandidateEvidenceSchema.parse({ label: "mixed", status: "pending", primary_error: null, attempt_id: "attempt", copied_workspace_id: "copy", original_assembly: { id: "assembly", workspace_id: "source", created_at: "now", actor, fingerprint: "original", source_file_ids: ["s"], items, mappings: [], coverage: [], extraction_runs: null, linking_complete: true, output: { gaps: [], tactics: [] }, checks: { checker_version: "fixture", status: "passed", findings: [] } }, copy: { source_id_map: { s: "cs" }, block_id_map: { b: "cb" }, claim_id_map: Object.fromEntries(items.map(item => [item.claim_id, `c${item.claim_id}`])), provenance_id_map: {}, original_content_fingerprint: "original", remapped_content_fingerprint: "remapped" }, setup: { source_fingerprint: "source", baseline_fingerprint: "baseline", original_baseline_snapshot: {}, pack_fingerprint: "pack", evaluator_version: "eval", downstream_evaluator_version: "downstream", gate_policy: MIXED_GATE_POLICY, gate_policy_fingerprint: MIXED_GATE_POLICY_FINGERPRINT, code_identity: "code", configuration: await captureMixedPipelineConfiguration(), source_files: [{ id: "s", checksum: "checksum", content_fingerprint: "content" }], parse_blocks: [{ id: "b", source_file_id: "s", content_fingerprint: "block" }] }, lineage, entry_source_inventory: lineage.map((row, index) => ({ claim_id: row.copied_claim_id, claim_type: items[index].claim_type, payload: row.copied_payload, original_item_version_ids: [items[index].id], original_provenance: provenance })), final_source_inventory: null, final_outputs: null, gates: [], stages: MIXED_PIPELINE_STAGES.map(stage => ({ stage, status: "pending" })) });
}
async function run(evidence: MixedCandidateEvidence) { return runMixedCandidatePipeline({ evidence, actor, pack_id: "fixture-pack" }); }
beforeEach(() => { f.calls.length = 0; f.evaluations.length = 0; f.inputs.length = 0; f.drift = false; f.actualDrift = false; f.fail = ""; f.overall = "full"; f.review = false; f.evaluateFail = false; f.evaluateFailStage = ""; f.emptyPairs = false; });
describe("retained mixed pipeline", () => {
  it("reversed_plan_dates_block_before_approval_and_preserve_valid_peer", async () => {
    // Arrange: original, copied inventory, and native projection share the same reversed date.
    const input = await candidate(false, "2025-12-01");

    // Act: the deterministic projection is unchanged, but structurally invalid.
    const result = await run(input);

    // Assert: retain the native result and blocking findings without approving the plan.
    expect(result.status).toBe("blocked");
    expect(result.primary_error).toMatchObject({ code: "invalid_plan_structure", stage: "gantt_project" });
    expect(result.gates.filter(gate => gate.object_type === "plan")).toEqual([
      expect.objectContaining({ decision: "block", findings: expect.arrayContaining([
        expect.objectContaining({ code: "reversed_plan_dates", severity: "blocking", object_ids: ["ACT-ct"] }),
      ]) }),
    ]);
    expect(f.calls.find(row => row.call_kind === "gantt_project")!.output).toMatchObject({
      activities: [expect.objectContaining({ start: "2026-01-01", end: "2025-12-01" })],
    });
    expect(result.stages.find(row => row.stage === "gantt_project")).toMatchObject({
      status: "blocked", calls: [expect.objectContaining({ version_index: 0 })],
    });
    expect(result.final_outputs).toBeNull();

    const peer = await candidate();
    peer.attempt_id = "valid-peer";
    expect((await run(peer)).status).toBe("completed");
  });
  it("differing_in_scope_provenance_is_blocked_before_execution", async () => {
    const input = await candidate(true);
    input.copy!.block_id_map.alternate = "alternate-copy";
    input.setup!.parse_blocks.push({ id: "alternate", source_file_id: "s", content_fingerprint: "alternate-content" });
    for (const entry of input.entry_source_inventory) {
      entry.original_provenance = [{ source_file_id: "s", block_id: "alternate", quote: "Alternate evidence." }];
    }
    vi.spyOn(await import("@/accuracy/store/parse-store"), "readParseBlocksByIds").mockResolvedValueOnce([
      { id: "cb", workspace_id: "copy", source_file_id: "cs", index: 0, kind: "prose", heading: null, text: "Selected evidence.", parser: "fixture", created_at: "now" },
      { id: "alternate-copy", workspace_id: "copy", source_file_id: "cs", index: 1, kind: "prose", heading: null, text: "Alternate evidence.", parser: "fixture", created_at: "now" },
    ]);
    expect(mixedCandidateEvidenceSchema.safeParse(input).success).toBe(true);

    const result = await run(input);

    expect(result.status).toBe("blocked");
    expect(result.gates.flatMap(gate => gate.findings).some(row => row.code === "original_provenance_mismatch")).toBe(true);
    expect(f.inputs).toHaveLength(0);
    expect(readParseBlocksByIds).toHaveBeenCalled();
  });
  it("progression_failure_retains_native_success_and_retry_versions", async () => {
    const input = await candidate();
    const progression = vi.spyOn(await import("@/accuracy/kernel/agent-events"), "readAgentProgression");
    progression.mockRejectedValueOnce(new Error("progression metadata unavailable"));

    const failed = await run(input);
    const native = f.calls.find(row => row.call_kind === "validation_gate" && (row.output as { action?: string } | null)?.action === "validate");

    expect(failed.status).toBe("failed");
    expect(failed.primary_error?.message).toBe("progression metadata unavailable");
    expect(native).toMatchObject({ version_index: 0, output: { claim_ids: ["ct"], action: "validate", validated: 1 } });
    expect(failed.stages.find(row => row.stage === "validation_gate")).toMatchObject({
      calls: [{ call_id: native!.call_id, version_index: 0 }], run_ids: [native!.call_id],
    });

    const recovered: Awaited<ReturnType<typeof readAgentProgression>> = {
      run_id: String(native!.call_id), workspace_id: "copy",
      events: [{ id: "snapshot", run_id: String(native!.call_id), workspace_id: "copy", event_type: "snapshot", iteration: 0, recorded_at: "now",
        event: { event_type: "snapshot", iteration: 0, output: { earlier: "draft" }, evaluation_context: "experiment",
          signals: { quote_validity: { valid_count: 0, invalid_count: 0, unchecked_count: 0 }, invariant_failures: [], completeness: "not_checked" },
          latency_ms: 0, token_usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, cost_usd: 0 } }],
    };
    progression.mockResolvedValue(recovered);
    expect((await run(input)).status).toBe("completed");
    const retained = structuredClone(f.calls.filter(row => row.call_id === native!.call_id));
    expect(retained.map(row => ({ version: row.version_index, output: row.output }))).toEqual([
      { version: 0, output: native!.output }, { version: 1, output: { earlier: "draft" } },
    ]);
    expect((await run(input)).status).toBe("completed");
    expect(f.calls.filter(row => row.call_id === native!.call_id)).toEqual(retained);
    progression.mockRestore();
  });
  it("replay_reaches_final_gantt_without_extraction", async () => { const input = await candidate(); const result = await run(input); expect(result.status).toBe("completed"); expect(result.final_outputs?.plan.activities[0].tactic_id).toBe("ct"); expect(mixedCandidateEvidenceSchema.safeParse(result).success).toBe(true); expect(f.inputs.map(row => row.call_kind)).not.toContain("inventory_extract"); expect(input.status).toBe("pending"); expect(f.calls.length).toBe(f.evaluations.length); });
  it("blocking_gate_stops_only_its_candidate", async () => { const input = await candidate(); input.entry_source_inventory[0].payload.provenance = [{ source_file_id: "cs", block_id: "cb", quote: "Not in source" }]; const result = await run(input); expect(result.status).toBe("blocked"); expect(result.gates.some(g => g.decision === "block")).toBe(true); expect(f.inputs).toHaveLength(0); const peer = await candidate(); peer.attempt_id = "peer-attempt"; expect((await run(peer)).status).toBe("completed"); });
  it("advisories_are_recorded_without_content_edits", async () => { const input = await candidate(true); f.review = true; const result = await run(input); expect(result.status).toBe("completed"); expect(result.gates.flatMap(g => g.findings).some(row => row.severity === "advisory")).toBe(true); expect(result.final_source_inventory).toEqual(input.entry_source_inventory); const coverageInput = f.inputs.find(row => row.call_kind === "coverage_decide")!.input as Record<string, unknown>; expect(coverageInput.block_bundle_ids).toEqual(["cb"]); expect(coverageInput.selected_versions).toMatchObject({ gap_version_id: "v1", tactic_version_id: "v0", gap_payload: input.entry_source_inventory[1].payload }); expect(JSON.stringify(f.inputs)).not.toMatch(/gold|fixture-pack/); });
  it("empty_branches_have_retained_outputs", async () => { const result = await run(await candidate()); expect(result.status).toBe("completed"); for (const stage of ["coverage_decide", "coverage_critic", "partial_split", "prioritize", "ideate"]) expect(result.stages.find(row => row.stage === stage)?.status).toBe("skipped"); expect(result.final_outputs?.residuals).toEqual([]); });
  it("placeholder_partial_split_is_a_recorded_blocker", async () => { f.overall = "partial"; const result = await run(await candidate(true)); expect(result.status).toBe("blocked"); expect(result.primary_error?.code).toBe("missing_durable_residual"); expect(f.calls.some(row => row.call_kind === "partial_split" && row.output)).toBe(true); });
  it("placeholder_priority_is_a_recorded_blocker", async () => { f.overall = "not_relevant"; const result = await run(await candidate(true)); expect(result.status).toBe("blocked"); expect(result.primary_error?.code).toBe("missing_priority_placement"); });
  it("later_failure_preserves_successful_calls", async () => { f.fail = "gantt_project"; const result = await run(await candidate()); expect(result.status).toBe("failed"); expect(result.primary_error?.message).toBe("failed gantt_project"); expect(result.stages.find(row => row.stage === "status_derive")?.status).toBe("completed"); expect(f.calls.some(row => row.call_kind === "validation_gate" && row.output)).toBe(true); });
  it("configuration_drift_stops_before_module_execution", async () => { const input = await candidate(); f.drift = true; const result = await run(input); expect(result.primary_error?.code).toBe("configuration_drift"); expect(f.inputs).toHaveLength(0); });
  it("actual_configuration_drift_retains_successful_call", async () => { const input = await candidate(); f.actualDrift = true; const result = await run(input); expect(result.primary_error?.code).toBe("configuration_drift"); expect(f.calls.some(row => row.call_kind === "validation_gate" && row.output)).toBe(true); });
  it("unchanged_configuration_reaches_projection", async () => { const input = await candidate(); expect(await captureMixedPipelineConfiguration()).toEqual(input.setup?.configuration); expect((await run(input)).status).toBe("completed"); });
  it("native_empty_pair_stub_still_recomputes_all_selected_pairs", async () => { f.emptyPairs = true; const result = await run(await candidate(true)); expect(result.status).toBe("completed"); expect(result.final_outputs?.coverage).toHaveLength(1); expect(f.calls.filter(row => row.call_kind === "pair_generate").map(row => row.output)).toEqual([{ pairs: [] }, { pairs: [{ gap_id: "cg", tactic_id: "ct" }] }]); });
  it("critic_failure_retains_the_successful_coverage_call", async () => { f.fail = "coverage_critic"; const result = await run(await candidate(true)); expect(result.primary_error?.message).toBe("failed coverage_critic"); expect(result.stages.find(row => row.stage === "coverage_decide")?.status).toBe("completed"); expect(f.calls.some(row => row.call_kind === "coverage_decide" && row.output)).toBe(true); });
  it("error_evaluation_failure_preserves_primary_module_error", async () => { f.fail = "gantt_project"; f.evaluateFailStage = "gantt_project"; const result = await run(await candidate()); expect(result.primary_error?.message).toBe("failed gantt_project"); expect(f.calls.some(row => row.call_kind === "gantt_project" && row.output_error === "failed gantt_project")).toBe(true); });
  it("evaluator_failure_keeps_the_already_retained_call", async () => { f.evaluateFail = true; const result = await run(await candidate()); expect(result.status).toBe("failed"); expect(result.primary_error?.message).toBe("evaluator unavailable"); expect(f.calls).toHaveLength(1); });
});
