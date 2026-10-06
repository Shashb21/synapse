/** Behavioral tests for conservative, read-only experiment results reporting. */
import { describe, expect, it } from "vitest";
import { buildExperimentResultsReport, serializeExperimentResultsReport } from "@/accuracy/experiments/results-report";
import type { PassComparison } from "@/accuracy/eval/pass-comparison";
import type { ExperimentRecord } from "@/accuracy/experiments/records";
import type { MixedComparisonRecord } from "@/accuracy/experiments/mixed-types";

const identity = { source_workspace_id: "source", source_fingerprint: "documents", baseline_fingerprint: "baseline", pack_id: "gold", pack_fingerprint: "gold-v1", evaluator_version: "experiment-evaluator-v1", comparison_evaluator_version: "pass-comparison-v1", original_request_identity: { source_file_ids: ["doc"], configuration: "config" }, original_request_fingerprint: "request-v1", calls: [{ lineage_key: "need_extract:doc:0", module_id: "extract", module_version: "v1", route: { model: "test" } }] };
function experiment(id: string, comparisonId: string, pass: number, status = "completed"): ExperimentRecord {
  return { id, source_workspace_id: "source", pack_id: "gold", pack_fingerprint: "gold-v1", evaluator_version: "experiment-evaluator-v1", source_fingerprint: "documents", baseline_fingerprint: "baseline", condition: { comparison_id: comparisonId, critic_revision_passes: pass }, status, created_at: "2026-10-06", calls: [{ call_id: `${id}-call`, input: { source_file_id: "copied", prompt: "raw input" }, output: { gaps: ["raw output"] }, version_index: 0 }], evaluations: [{ call_id: `${id}-call`, version_index: 0, evaluation: { status: "scored" } }] } as unknown as ExperimentRecord;
}
function passComparison(id: string, gain = true): PassComparison {
  const counts = (found: number) => ({ found, partial: 0, missed: 0, wrong: 0 });
  const condition = (pass: number, found: number) => ({ experiment_id: `${id}-${pass}`, pass_count: pass, status: "completed", identity: structuredClone(identity), eligibility: "eligible", reasons: [], calls: [{ call_id: `${id}-${pass}-call`, call_kind: "need_extract", versions: [{ version_index: pass, delta_from_v0: counts(found), regressions: [] }] }], totals: { distinct_exact_found_count: found, distinct_exact_found_keys: Array.from({ length: found }, (_, i) => `need_extract:key-${i}`), distinct_exact_must_find_found_count: found, distinct_exact_must_find_keys: Array.from({ length: found }, (_, i) => `need_extract:key-${i}`), summed_call_outcomes: counts(found), summed_call_must_find_outcomes: counts(found) } });
  return { comparison_id: id, comparison_evaluator_version: "pass-comparison-v1", matched: true, mismatch_reasons: [], loaded_pack_identity: { pack_id: "gold", pack_fingerprint: "gold-v1", matches_retained: true }, conditions: [condition(1, 1), condition(2, gain ? 2 : 1), condition(3, 1)] } as unknown as PassComparison;
}
function args(comparisons: PassComparison[]) {
  return { source_workspace_id: "source", experiments: comparisons.flatMap(c => [1, 2, 3].map(n => experiment(`${c.comparison_id}-${n}`, c.comparison_id!, n))), pass_comparisons: comparisons, mixed_comparisons: [], loaded_pack_fingerprints: { gold: "gold-v1" } };
}
function mixedComparison(id: string, gain = true): MixedComparisonRecord {
  const setup = { source_fingerprint: "documents", baseline_fingerprint: "baseline", original_baseline_snapshot: {}, pack_fingerprint: "gold-v1", evaluator_version: "experiment-evaluator-v1", downstream_evaluator_version: "mixed-downstream-v2", gate_policy: "deterministic_checks_pass_no_edits_v1", gate_policy_fingerprint: "policy", code_identity: "code", configuration: { fingerprint: "config", modules: [] }, source_files: [{ id: "doc", checksum: "checksum", content_fingerprint: "content" }], parse_blocks: [] };
  const original = (fingerprint: string) => ({ fingerprint });
  const evaluation = (candidate: "mixed" | "baseline", point: "entry" | "final", claim_type: "gap" | "tactic") => ({ candidate, point, claim_type, evaluation: { evaluator_version: "experiment-evaluator-v1", pack_id: "gold", pack_fingerprint: "gold-v1", call_kind: claim_type === "gap" ? "need_extract" : "inventory_extract", status: "scored", output_shape: { valid: true }, score: { found: 1, partial: 0, missed: 0, wrong: 0 }, outcomes: (candidate === "mixed" && point === "final" && claim_type === "gap" && gain ? ["one", "two"] : ["one"]).map(gold_item_key => ({ outcome: "found", gold_item_key })) } });
  return { header: { id, source_workspace_id: "source", created_at: "2026-10-06", request: { source_file_ids: ["doc"], pack_id: "gold", mixed: { fingerprint: "mixed-assembly" }, baseline: { fingerprint: "baseline-assembly" } }, original_assemblies: { mixed: original("mixed-assembly"), baseline: original("baseline-assembly") }, pack_fingerprint: "gold-v1", evaluator_version: "experiment-evaluator-v1", gate_policy: setup.gate_policy, gate_policy_fingerprint: setup.gate_policy_fingerprint }, status: "completed", links: { mixed_experiment_id: `${id}-mixed`, baseline_experiment_id: `${id}-baseline` }, attempts: { mixed: experiment(`${id}-mixed`, id, 0), baseline: experiment(`${id}-baseline`, id, 0) }, result: { evidence: { status: "completed", candidates: { mixed: { status: "completed", setup, original_assembly: original("mixed-assembly") }, baseline: { status: "completed", setup, original_assembly: original("baseline-assembly") } }, evaluation: { source_evaluations: (["mixed", "baseline"] as const).flatMap(candidate => (["entry", "final"] as const).flatMap(point => (["gap", "tactic"] as const).map(claim_type => evaluation(candidate, point, claim_type)))), applicability: [{ dimension: "source_gaps", status: "scored", reference_keys: ["one"] }, { dimension: "source_tactics", status: "scored", reference_keys: ["one"] }, { dimension: "plan", status: "unscored", reason: "No curated labels" }], changes: [] } } } } as unknown as MixedComparisonRecord;
}

describe("experiment results report", () => {
  it("keeps one gain candidate-specific and exports complete retained evidence", () => {
    const input = args([passComparison("first")]);
    const before = JSON.stringify(input);
    const report = buildExperimentResultsReport(input);
    const candidate = report.entries.find(e => e.id === "pass:first:2")!;
    expect(candidate.attribution.label).toBe("Observed gain");
    expect(report.entries.find(e => e.id === "pass:first:3")?.attribution.label).toBe("Matched results");
    expect(candidate.evidence.pass_comparison).toBe(input.pass_comparisons[0]);
    const line = JSON.parse(serializeExperimentResultsReport(report, "jsonl").split("\n")[0]);
    expect(line.entry.evidence.experiments[0].calls[0].input.prompt).toBe("raw input");
    expect(JSON.parse(serializeExperimentResultsReport(report, "json")).entries).toHaveLength(2);
    expect(JSON.stringify(input)).toBe(before);
    expect(() => serializeExperimentResultsReport(report, "csv" as "json")).toThrow();
  });

  it("requires every complete comparable repeat to gain and keeps failures in the series", () => {
    const positive = buildExperimentResultsReport(args([passComparison("first"), passComparison("second")]));
    expect(positive.entries.filter(e => e.attribution.label === "Consistent improvement")).toHaveLength(2);
    const neutral = buildExperimentResultsReport(args([passComparison("first"), passComparison("second", false)]));
    expect(neutral.entries.find(e => e.id === "pass:first:2")?.attribution.label).toBe("Observed gain");
    expect(neutral.repeat_series.find(s => s.member_ids.includes("pass:first:2"))?.member_ids).toContain("pass:second:2");
    const failedInput = args([passComparison("first"), passComparison("second")]);
    failedInput.pass_comparisons[1].conditions[1].status = "failed";
    expect(buildExperimentResultsReport(failedInput).entries.find(e => e.id === "pass:first:2")?.attribution.label).toBe("Observed gain");
  });

  it("downgrades missing identity, drift and unsafe outcome", () => {
    const input = args([passComparison("first")]);
    input.pass_comparisons[0].loaded_pack_identity!.matches_retained = false;
    expect(buildExperimentResultsReport(input).entries[0].attribution.label).toBe("Descriptive");
    input.pass_comparisons[0].loaded_pack_identity!.matches_retained = true;
    input.pass_comparisons[0].conditions[1].totals.summed_call_outcomes.wrong = 1;
    expect(buildExperimentResultsReport(input).entries[0].attribution.label).toBe("Matched results");
  });

  it("keeps standalone failed attempts descriptive and empty JSONL empty", () => {
    const report = buildExperimentResultsReport({ ...args([]), experiments: [experiment("alone", "none", 0, "failed")] });
    expect(report.entries[0].attribution.label).toBe("Descriptive");
    expect(report.entries[0].evidence.experiments[0].evaluations).toHaveLength(1);
    expect(serializeExperimentResultsReport({ ...report, entries: [] }, "jsonl")).toBe("");
  });

  it("limits mixed gain to scored source gold and retains unscored downstream evidence", () => {
    const record = mixedComparison("mixed-one");
    const report = buildExperimentResultsReport({ ...args([]), experiments: [record.attempts.mixed!, record.attempts.baseline!], mixed_comparisons: [record] });
    expect(report.entries).toHaveLength(1);
    expect(report.entries[0].attribution.label).toBe("Observed gain");
    expect(report.entries[0].evidence.mixed_comparison?.result?.evidence.evaluation?.applicability).toContainEqual({ dimension: "plan", status: "unscored", reason: "No curated labels" });
    const lost = mixedComparison("mixed-two");
    lost.result!.evidence.evaluation!.source_evaluations.find(row => row.candidate === "mixed" && row.point === "final" && row.claim_type === "gap")!.evaluation.outcomes = [{ outcome: "found", gold_item_key: "two", reason: "test" }];
    expect(buildExperimentResultsReport({ ...args([]), experiments: [], mixed_comparisons: [lost] }).entries[0].attribution.label).toBe("Matched results");
  });

  it("does not combine configuration drift or reused call IDs into a consistent claim", () => {
    const drift = args([passComparison("first"), passComparison("second")]);
    (drift.pass_comparisons[1].conditions[1].identity as typeof identity).calls[0].module_version = "v2";
    expect(buildExperimentResultsReport(drift).entries.find(row => row.id === "pass:first:2")?.attribution.label).toBe("Observed gain");
    const duplicate = args([passComparison("first"), passComparison("second")]);
    duplicate.experiments.find(row => row.id === "second-2")!.calls[0].call_id = "first-2-call";
    expect(buildExperimentResultsReport(duplicate).entries.find(row => row.id === "pass:first:2")?.attribution.label).toBe("Observed gain");
  });

  it.each(["source_fingerprint", "pack_fingerprint", "evaluator_version", "original_request_fingerprint"] as const)("separates %s drift across repeats", field => {
    const input = args([passComparison("first"), passComparison("second")]);
    for (const condition of input.pass_comparisons[1].conditions) (condition.identity as typeof identity)[field] = "changed";
    expect(buildExperimentResultsReport(input).entries.find(row => row.id === "pass:first:2")?.attribution.label).toBe("Observed gain");
  });

  it("treats missing actual route identity as an unknown repeat blocker", () => {
    const input = args([passComparison("first"), passComparison("second")]);
    for (const condition of input.pass_comparisons[1].conditions) (condition.identity as typeof identity).calls[0].route = null as unknown as typeof identity.calls[0]["route"];
    const report = buildExperimentResultsReport(input);
    expect(report.entries.find(row => row.id === "pass:first:2")?.attribution.label).toBe("Observed gain");
    expect(report.entries.find(row => row.id === "pass:second:2")?.repeat_key).toBeNull();
    expect(report.repeat_series.find(row => row.member_ids.includes("pass:first:2"))?.member_ids).toContain("pass:second:2");
  });

  it("keeps malformed pass identity and unavailable mixed results descriptive without throwing", () => {
    const input = args([passComparison("first")]);
    input.pass_comparisons[0].conditions[1].identity = null;
    expect(buildExperimentResultsReport(input).entries.find(row => row.id === "pass:first:2")?.attribution.label).toBe("Descriptive");
    const mixed = mixedComparison("unavailable");
    mixed.result = null;
    mixed.status = "running";
    expect(buildExperimentResultsReport({ ...args([]), mixed_comparisons: [mixed] }).entries.find(row => row.id === "mixed:unavailable")?.attribution.label).toBe("Descriptive");
  });
});
