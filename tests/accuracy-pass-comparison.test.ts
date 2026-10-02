/** Conservative pass comparisons over retained, controlled evidence. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { comparePassExperiments, comparisonRequestFingerprint, evaluatePassComparison, type ComparisonEvidence } from "@/accuracy/eval/pass-comparison";
import * as goldIdentity from "@/accuracy/eval/experiment-gold";
import * as referenceGold from "@/accuracy/eval/reference-gold";
import type { ExperimentRecord } from "@/accuracy/experiments/records";
import type { AgentEvent } from "@/accuracy/kernel/agent-events";

const targets = { gap_ids: ["a", "b"], tactic_numbers: [], tactic_identifiers: [] };
afterEach(() => vi.restoreAllMocks());
function cohort(): ComparisonEvidence[] {
  return [1, 2, 3].map(pass => {
    const call_id = `call-${pass}`;
    const events: AgentEvent[] = [];
    const calls = Array.from({ length: pass + 1 }, (_, version_index) => {
      events.push({ event_type: "snapshot", iteration: version_index, output: { gaps: [] }, evaluation_context: "experiment", signals: { quote_validity: { valid_count: 1, invalid_count: 0, unchecked_count: 0 }, invariant_failures: [], completeness: "not_checked" }, latency_ms: 2, cost_usd: 1, token_usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
      events.push({ event_type: "critique", iteration: version_index, score: 1, issues: [], completeness: { risk_level: "none_detected", checked_block_ids: ["block"], unchecked_block_ids: [], suspected_omissions: [], prior_issue_resolutions: [] }, latency_ms: 3, cost_usd: 2, token_usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
      return { id: `row-${pass}-${version_index}`, workspace_id: `copy-${pass}`, experiment_id: `experiment-${pass}`, call_id, call_kind: "need_extract", version_index, input: { source_file_id: `source-copy-${pass}` }, output: { gaps: [] }, output_error: null, module_version: "v1", route: { model: "local", nested: { b: 2, a: 1 } }, recorded_at: "now" };
    });
    events.push({ event_type: "judgment", selected_iteration: pass, reason: "latest", latency_ms: 4, cost_usd: 3, token_usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    const experiment = { id: `experiment-${pass}`, workspace_id: `copy-${pass}`, source_workspace_id: "source", source_fingerprint: "source-hash", baseline_fingerprint: "baseline", pack_id: "pack", pack_fingerprint: "pack-hash", evaluator_version: "eval-v1", baseline_snapshot: { source_files: [{ original_id: "source-original", copied_id: `source-copy-${pass}` }] }, condition: { critic_revision_passes: pass, comparison_id: "cohort", comparison_evaluator_version: "pass-comparison-v1", original_request_identity: { mode: "single_call", source_file_ids: ["source-original"] }, original_request_fingerprint: "request" }, status: "completed", calls, evaluations: calls.map(call => ({ id: `eval-${call.id}`, workspace_id: call.workspace_id, experiment_id: call.experiment_id, call_id, version_index: call.version_index, evaluator_version: "eval-v1", recorded_at: "now", evaluation: { evaluator_version: "eval-v1", pack_id: "pack", pack_fingerprint: "pack-hash", call_kind: "need_extract", status: "scored", output_shape: { valid: true }, outcomes: [{ outcome: "found", gold_item_key: "a", reason: "exact" }, { outcome: "missed", gold_item_key: "b", reason: "absent" }], errors: [] } })) } as ExperimentRecord;
    return { experiment, runs: [{ call_id, module_id: "module", module_version: "v1", route: calls[0].route, status: "ok", duration_ms: 20, cost_usd: 10, token_usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }, events }] };
  });
}

function multiSourceCohort(): ComparisonEvidence[] {
  return cohort().map(evidence => {
    const { experiment } = evidence;
    const pass = (experiment.condition as Record<string, unknown>).critic_revision_passes;
    const templateCalls = experiment.calls;
    const templateEvaluations = experiment.evaluations;
    const templateRun = evidence.runs[0];
    experiment.calls = []; experiment.evaluations = []; evidence.runs = [];
    experiment.baseline_snapshot = { source_files: [
      { original_id: "source-original", copied_id: `source-copy-${pass}` },
      { original_id: "second-source", copied_id: `second-copy-${pass}` },
    ] };
    experiment.condition = { ...experiment.condition as object, original_request_identity: { mode: "pipeline", source_file_ids: ["source-original", "second-source"] } };
    for (const [sourceIndex, source] of [`source-copy-${pass}`, `second-copy-${pass}`].entries()) {
      for (const call_kind of ["need_extract", "inventory_extract", "merge_dedupe", "status_derive"]) {
        const extraction = ["need_extract", "inventory_extract"].includes(call_kind);
        const call_id = `${templateRun.call_id}-${sourceIndex}-${call_kind}`;
        const rows = extraction ? templateCalls : templateCalls.slice(0, 1);
        experiment.calls.push(...rows.map(row => ({ ...row, id: `${row.id}-${sourceIndex}-${call_kind}`, call_id, call_kind,
          input: extraction ? { source_file_id: source } : {}, output: call_kind === "need_extract" ? { gaps: [] } : call_kind === "inventory_extract" ? { tactics: [] } : {} })));
        const evaluations = extraction ? templateEvaluations : templateEvaluations.slice(0, 1);
        experiment.evaluations.push(...evaluations.map(row => ({ ...row, id: `${row.id}-${sourceIndex}-${call_kind}`, call_id,
          evaluation: { ...row.evaluation as object, call_kind, status: extraction ? "scored" : "gold_not_applicable", outcomes: [] } })));
        const events = extraction ? structuredClone(templateRun.events) : [];
        for (const event of events) if (event.event_type === "snapshot") event.output = call_kind === "need_extract" ? { gaps: [] } : { tactics: [] };
        evidence.runs.push({ ...templateRun, call_id, events });
      }
    }
    return evidence;
  });
}

describe("retained pass comparison", () => {
  it("refuses changed current must-find targets without rewriting historical target outcomes", () => {
    const evidence = cohort();
    vi.spyOn(goldIdentity, "experimentPackFingerprint").mockReturnValue("pack-hash");
    vi.spyOn(referenceGold, "mustFindForPack").mockReturnValue(targets);
    const before = evaluatePassComparison(evidence);
    expect(before).toMatchObject({ matched: true, recommendation: { pass_count: 1 } });
    vi.spyOn(goldIdentity, "experimentPackFingerprint").mockReturnValue("changed-pack-hash");
    vi.spyOn(referenceGold, "mustFindForPack").mockImplementation(() => { throw new Error("Changed targets must not be read for historic scoring."); });
    const after = evaluatePassComparison(evidence);
    expect(after).toMatchObject({ matched: false, recommendation: null });
    expect(after.mismatch_reasons).toContain("Current reference pack fingerprint differs from retained pack identity; must-find targets are unavailable.");
    expect(after.conditions[0].calls[0].versions[1]).toMatchObject({ outcomes: [{ outcome: "found", gold_item_key: "a", reason: "exact" }, { outcome: "missed", gold_item_key: "b", reason: "absent" }], must_find: null, exact_must_find_keys: null, recovered_from_v0: null, lost_from_v0: null });
    expect(after.conditions[0].totals).toMatchObject({ summed_call_outcomes: { found: 1, missed: 1 }, summed_call_must_find_outcomes: null, distinct_exact_found_count: 1, distinct_exact_must_find_found_count: null, distinct_exact_must_find_keys: null });
    expect(after.loaded_pack_identity).toEqual({ pack_id: "pack", pack_fingerprint: "changed-pack-hash", matches_retained: false });
  });
  it.each(["missing_pack", "malformed_targets"])("keeps historical outcomes inspectable when current gold has %s", problem => {
    const evidence = cohort();
    vi.spyOn(goldIdentity, "experimentPackFingerprint").mockImplementation(() => {
      if (problem === "missing_pack") throw Object.assign(new Error("Current gold file missing"), { code: "ENOENT" });
      return "pack-hash";
    });
    vi.spyOn(referenceGold, "mustFindForPack").mockImplementation(() => { throw new SyntaxError("Current target JSON malformed"); });
    const result = evaluatePassComparison(evidence);
    expect(result).toMatchObject({ matched: false, recommendation: null });
    expect(result.mismatch_reasons.some(reason => reason.includes("Current reference pack could not be read"))).toBe(true);
    expect(result.conditions[0].calls[0].versions[1]).toMatchObject({ counts: { found: 1, missed: 1 }, must_find: null });
    expect(result.conditions[0].totals.distinct_exact_must_find_found_count).toBeNull();
  });
  it("makes must-find targets unavailable when the pack changes during target loading", () => {
    const evidence = cohort();
    vi.spyOn(goldIdentity, "experimentPackFingerprint").mockReturnValueOnce("pack-hash").mockReturnValue("changed-after-read");
    vi.spyOn(referenceGold, "mustFindForPack").mockReturnValue({ ...targets, gap_ids: ["changed-member"] });
    const result = evaluatePassComparison(evidence);
    expect(result).toMatchObject({ matched: false, recommendation: null });
    expect(result.conditions[0].calls[0].versions[1].must_find).toBeNull();
  });
  it("matches original source lineage across generated IDs and includes terminal costs", () => {
    const result = comparePassExperiments(cohort(), targets);
    expect(result.matched).toBe(true);
    expect(result.recommendation?.pass_count).toBe(1);
    expect(result.conditions[0].calls[0].lineage_key).toBe("need_extract:source-original:0");
    expect(result.conditions[0].calls[0].versions[1].cumulative_metering).toMatchObject({ cost_usd: 6, latency_ms: 10, token_usage: { total_tokens: 8 } });
    expect(result.conditions[0].totals).toMatchObject({ cost_usd: 10, latency_ms: 20, summed_call_must_find_outcomes: { found: 1, partial: 0, missed: 1, wrong: 0 } });
  });
  it.each(["source_workspace_id", "source_fingerprint", "baseline_fingerprint", "pack_fingerprint", "evaluator_version"] as const)("refuses attribution after %s changes", field => {
    const evidence = cohort(); evidence[1].experiment[field] = "changed";
    expect(comparePassExperiments(evidence, targets)).toMatchObject({ matched: false, recommendation: null });
  });
  it.each(["module_id", "module_version", "route"] as const)("compares actual runtime %s", field => {
    const evidence = cohort(); Object.assign(evidence[1].runs[0], { [field]: "changed" });
    expect(comparePassExperiments(evidence, targets).matched).toBe(false);
  });
  it("canonicalizes object key order but rejects changed original requests", () => {
    const evidence = cohort(); evidence[1].runs[0].route = { nested: { a: 1, b: 2 }, model: "local" };
    expect(comparePassExperiments(evidence, targets).matched).toBe(true);
    evidence[1].experiment.condition = { ...evidence[1].experiment.condition as object, original_request_identity: { mode: "pipeline" } };
    expect(comparePassExperiments(evidence, targets).matched).toBe(false);
  });
  it("rejects duplicate and absent pass conditions", () => {
    const evidence = cohort();
    expect(comparePassExperiments(evidence.slice(0, 2), targets).matched).toBe(false);
    evidence[2].experiment.condition = evidence[1].experiment.condition;
    expect(comparePassExperiments(evidence, targets).matched).toBe(false);
  });
  it("retains exact must-find recoveries and losses without counting partial or wrong as recovery", () => {
    const evidence = cohort();
    evidence[2].experiment.evaluations[1].evaluation = { ...(evidence[2].experiment.evaluations[1].evaluation as object), outcomes: [{ outcome: "partial", gold_item_key: "a" }, { outcome: "found", gold_item_key: "b" }, { outcome: "wrong" }] };
    evidence[2].experiment.evaluations[2].evaluation = { ...(evidence[2].experiment.evaluations[2].evaluation as object), outcomes: [{ outcome: "missed", gold_item_key: "a" }, { outcome: "partial", gold_item_key: "b" }] };
    const versions = comparePassExperiments(evidence, targets).conditions[2].calls[0].versions;
    expect(versions[1]).toMatchObject({ must_find: { found: 1, partial: 1, missed: 0, wrong: 0 }, recovered_from_v0: ["b"], lost_from_v0: ["a"], recovered_from_previous: ["b"], lost_from_previous: ["a"], delta_from_previous: { found: 0, partial: 1, missed: -1, wrong: 1 } });
    expect(versions[2].lost_from_previous).toEqual(["b"]);
  });
  it.each(["unsupported", "false_claim", "provenance"])("disqualifies new serious %s evidence and preserves its reasons", category => {
    const evidence = cohort(); const event = evidence[0].runs[0].events[3];
    if (event.event_type === "critique") event.issues = [{ issue_id: "bad", category, code: category, severity: "high", claim: "Bad evidence", source_ref: { source_file_id: "s", block_id: "b" }, suggested_action: "remove" }];
    const condition = comparePassExperiments(evidence, targets).conditions[0];
    expect(condition.eligibility).toBe("ineligible");
    expect(condition.calls[0].versions[1].regressions).toContain("New serious critic finding: bad");
    expect(condition.calls[0].versions[1].critique?.issues[0].source_ref).toEqual({ source_file_id: "s", block_id: "b" });
  });
  it.each(["claim", "source", "category", "code"])("detects changed serious %s evidence under a reused issue ID", changedField => {
    const evidence = cohort();
    const initial = evidence[0].runs[0].events[1]; const revision = evidence[0].runs[0].events[3];
    const issue = { issue_id: "position-0", category: "unsupported", code: "unsupported_claim", severity: "high" as const, claim: "Initial unsupported claim", source_ref: { source_file_id: "source-a", block_id: "block-a" }, suggested_action: "remove" };
    if (initial.event_type === "critique") initial.issues = [issue];
    if (revision.event_type === "critique") revision.issues = [{ ...issue,
      ...(changedField === "claim" ? { claim: "Different unsupported claim" } : {}),
      ...(changedField === "source" ? { source_ref: { source_file_id: "source-b", block_id: "block-b" } } : {}),
      ...(changedField === "category" ? { category: "provenance" } : {}),
      ...(changedField === "code" ? { code: "invalid_provenance" } : {}),
    }];
    expect(comparePassExperiments(evidence, targets).conditions[0].calls[0].versions[1].regressions).toEqual(["New serious critic finding: position-0"]);
  });
  it("does not report unchanged serious evidence as new when positional IDs change", () => {
    const evidence = cohort(); const initial = evidence[0].runs[0].events[1]; const revision = evidence[0].runs[0].events[3];
    const issue = { issue_id: "position-0", category: "unsupported", code: "unsupported_claim", severity: "high" as const, claim: "Same unsupported claim", source_ref: { source_file_id: "source-a", block_id: "block-a" }, suggested_action: "remove" };
    if (initial.event_type === "critique") initial.issues = [issue];
    if (revision.event_type === "critique") revision.issues = [{ ...issue, issue_id: "position-4", source_ref: { block_id: "block-a", source_file_id: "source-a" } }];
    const result = comparePassExperiments(evidence, targets).conditions[0];
    expect(result.calls[0].versions[1].regressions).toEqual([]);
    expect(result.eligibility).toBe("ineligible");
  });
  it("keeps omission risk and gold wrong items distinct from source falsity", () => {
    const evidence = cohort(); const event = evidence[0].runs[0].events[3];
    if (event.event_type === "critique") { event.issues = [{ issue_id: "omission", category: "omission", code: "missing_gap", severity: "high", claim: "Missing", suggested_action: "add" }]; event.completeness.risk_level = "important"; }
    evidence[0].experiment.evaluations[1].evaluation = { ...evidence[0].experiment.evaluations[1].evaluation as object, outcomes: [{ outcome: "wrong", reason: "No gold match" }] };
    expect(comparePassExperiments(evidence, targets).conditions[0].eligibility).toBe("eligible");
  });
  it.each(["invalid", "invariant", "unchecked", "check_failed", "missing_critique", "no_judgment", "failed", "incomplete", "invalid_output", "runtime_failed", "missing_runtime"])("handles %s conservatively", problem => {
    const evidence = cohort(); const run = evidence[0].runs[0]; const snapshot = run.events[0]; const critique = run.events[1];
    if (snapshot.event_type === "snapshot") { if (problem === "invalid") snapshot.signals.quote_validity.invalid_count = 1; if (problem === "invariant") snapshot.signals.invariant_failures = ["bad"]; if (problem === "unchecked") snapshot.signals.quote_validity.unchecked_count = 1; }
    if (critique.event_type === "critique" && problem === "check_failed") critique.completeness.risk_level = "check_failed";
    if (problem === "missing_critique") run.events.splice(1, 1);
    if (problem === "no_judgment") run.events.pop();
    if (problem === "failed") evidence[0].experiment.status = "failed";
    if (problem === "runtime_failed") run.status = "error";
    if (problem === "missing_runtime") evidence[0].runs = [];
    if (problem === "incomplete") evidence[0].experiment.calls.pop();
    if (problem === "invalid_output") evidence[0].experiment.evaluations[1].evaluation = { status: "invalid_output", output_shape: { valid: false }, outcomes: [] };
    expect(comparePassExperiments(evidence, targets).conditions[0].eligibility).toBe(["unchecked", "check_failed", "missing_critique", "no_judgment", "missing_runtime"].includes(problem) ? "unknown" : "ineligible");
  });
  it("ranks final exact quality before lower cost, then wrong and partial counts", () => {
    const evidence = cohort();
    const final = evidence[2].experiment.evaluations.at(-1)!;
    final.evaluation = { ...(final.evaluation as object), outcomes: [{ outcome: "found", gold_item_key: "a" }, { outcome: "found", gold_item_key: "b" }] };
    evidence[2].runs[0].cost_usd = 100;
    expect(comparePassExperiments(evidence, targets).recommendation?.pass_count).toBe(3);
  });
  it("fingerprints canonical objects while preserving requested execution order", () => {
    expect(comparisonRequestFingerprint({ b: 2, a: { y: 4, x: 3 } })).toBe(comparisonRequestFingerprint({ a: { x: 3, y: 4 }, b: 2 }));
    expect(comparisonRequestFingerprint(["a", "b"])).not.toBe(comparisonRequestFingerprint(["b", "a"]));
  });
  it("reports new invalid quotes and invariants as regressions", () => {
    const evidence = cohort(); const snapshot = evidence[0].runs[0].events[2];
    if (snapshot.event_type === "snapshot") { snapshot.signals.quote_validity.invalid_count = 1; snapshot.signals.invariant_failures = ["new-check"]; }
    expect(comparePassExperiments(evidence, targets).conditions[0].calls[0].versions[1].regressions).toEqual(["Invalid quote count increased.", "New invariant failure: new-check"]);
  });
  it.each(["wrong", "partial"] as const)("uses fewer %s items before cheaper cost", outcome => {
    const evidence = cohort();
    for (const condition of [evidence[0], evidence[2]]) {
      const final = condition.experiment.evaluations.at(-1)!;
      final.evaluation = { ...(final.evaluation as object), outcomes: [{ outcome: "found", gold_item_key: "a" }, { outcome, ...(outcome === "partial" ? { gold_item_key: "b" } : {}) }] };
      condition.runs[0].cost_usd = 0;
    }
    expect(comparePassExperiments(evidence, targets).recommendation?.pass_count).toBe(2);
  });
  it("uses lower latency and then fewer passes when quality and cost tie", () => {
    const evidence = cohort(); evidence[1].runs[0].duration_ms = 5;
    expect(comparePassExperiments(evidence, targets).recommendation?.pass_count).toBe(2);
    evidence[0].runs[0].duration_ms = 5;
    expect(comparePassExperiments(evidence, targets).recommendation?.pass_count).toBe(1);
  });
  it("marks partial completeness scope and a null critic score unknown", () => {
    const evidence = cohort(); const critique = evidence[0].runs[0].events[3];
    if (critique.event_type === "critique") { critique.completeness.unchecked_block_ids = ["unseen"]; critique.score = null; }
    expect(comparePassExperiments(evidence, targets).conditions[0].eligibility).toBe("unknown");
  });
  it("cannot recommend a pipeline that omits a selected source even if its observed versions completed", () => {
    const evidence = cohort();
    for (const item of evidence) item.experiment.condition = { ...item.experiment.condition as object, original_request_identity: { mode: "pipeline", source_file_ids: ["source-original", "missing-source"] } };
    const result = comparePassExperiments(evidence, targets);
    expect(result.conditions.map(item => item.eligibility)).toEqual(["ineligible", "ineligible", "ineligible"]); expect(result.recommendation).toBeNull();
  });
  it("disqualifies a serious finding already present at V0 even when the final critique is clean", () => {
    const evidence = cohort(); const critique = evidence[0].runs[0].events[1];
    if (critique.event_type === "critique") critique.issues = [{ issue_id: "old", category: "unsupported", code: "unsupported", severity: "critical", claim: "Existing false evidence", suggested_action: "remove" }];
    expect(comparePassExperiments(evidence, targets).conditions[0].eligibility).toBe("ineligible");
  });
  it("ranks non-must-find exact matches after equal must-find quality", () => {
    const evidence = cohort(); const final = evidence[1].experiment.evaluations.at(-1)!;
    final.evaluation = { ...final.evaluation as object, outcomes: [{ outcome: "found", gold_item_key: "a" }, { outcome: "found", gold_item_key: "optional" }] };
    evidence[1].runs[0].cost_usd = 50;
    expect(comparePassExperiments(evidence, targets).recommendation?.pass_count).toBe(2);
  });
  it("cannot rank an unassessed evaluation or missing runtime costs", () => {
    const evidence = cohort(); evidence[0].experiment.evaluations.pop(); evidence[1].runs[0].cost_usd = null;
    const result = comparePassExperiments(evidence, targets);
    expect(result.conditions.map(item => item.eligibility)).toEqual(["unknown", "unknown", "eligible"]); expect(result.recommendation?.pass_count).toBe(3);
  });
  it("ranks two distinct recovered targets above the same target recovered in two sources", () => {
    const evidence = multiSourceCohort();
    for (const [conditionIndex, item] of evidence.entries()) {
      const finals = item.experiment.evaluations.filter(row => row.version_index === conditionIndex + 1 && (row.evaluation as { call_kind: string }).call_kind === "need_extract");
      for (const [sourceIndex, final] of finals.entries()) final.evaluation = { ...final.evaluation as object, outcomes: conditionIndex === 2 ? [] : [{ outcome: "found", gold_item_key: conditionIndex === 1 && sourceIndex === 1 ? "b" : "a", reason: "exact" }] };
    }
    evidence[1].runs.forEach(run => { run.cost_usd = 100; });
    const result = comparePassExperiments(evidence, targets);
    expect(result.recommendation?.pass_count).toBe(2);
    expect(result.conditions[0].totals).toMatchObject({ summed_call_outcomes: { found: 2 }, summed_call_must_find_outcomes: { found: 2 }, distinct_exact_found_count: 1, distinct_exact_must_find_found_count: 1, distinct_exact_found_keys: ["need_extract:a"], distinct_exact_must_find_keys: ["need_extract:a"] });
    expect(result.conditions[1].totals).toMatchObject({ distinct_exact_found_count: 2, distinct_exact_must_find_found_count: 2, distinct_exact_must_find_keys: ["need_extract:a", "need_extract:b"] });
  });
  it("qualifies distinct exact keys by extraction kind and preserves non-must-find exact ranking", () => {
    const evidence = multiSourceCohort();
    for (const [conditionIndex, item] of evidence.entries()) {
      const finals = item.experiment.evaluations.filter(row => row.version_index === conditionIndex + 1);
      const need = finals.find(row => (row.evaluation as { call_kind: string }).call_kind === "need_extract")!;
      need.evaluation = { ...need.evaluation as object, outcomes: [{ outcome: "found", gold_item_key: "a", reason: "exact" }] };
      if (conditionIndex === 1) {
        const inventory = finals.find(row => (row.evaluation as { call_kind: string }).call_kind === "inventory_extract")!;
        inventory.evaluation = { ...inventory.evaluation as object, outcomes: [{ outcome: "found", gold_item_key: "a", reason: "exact" }, { outcome: "found", gold_item_key: "optional", reason: "exact" }] };
      }
    }
    const result = comparePassExperiments(evidence, { ...targets, tactic_identifiers: ["a"] });
    expect(result.recommendation?.pass_count).toBe(2);
    expect(result.conditions[1].totals).toMatchObject({ distinct_exact_found_count: 3, distinct_exact_must_find_found_count: 2, distinct_exact_found_keys: ["inventory_extract:a", "inventory_extract:optional", "need_extract:a"], distinct_exact_must_find_keys: ["inventory_extract:a", "need_extract:a"] });
  });
});
