/** Pure, conservative attribution and lossless presentation of retained experiment evidence. */
import { canonicalComparisonJson, type PassComparison, type ComparedCondition } from "../eval/pass-comparison";
import { MIXED_DOWNSTREAM_EVALUATOR_VERSION } from "../eval/mixed-comparison";
import type { ExperimentRecord } from "./records";
import type { MixedComparisonRecord, MixedComparisonEvaluation } from "./mixed-types";

export type ResultsAttribution = {
  label: "Descriptive" | "Matched results" | "Observed gain" | "Consistent improvement";
  reasons: string[];
  scope: "source_gold";
};
export type ExperimentResultsEntry = {
  id: string;
  kind: "pass_candidate" | "mixed_pair" | "standalone_attempt";
  created_at: string;
  attribution: ResultsAttribution;
  matched: boolean;
  mismatch_reasons: string[];
  repeat_key: string | null;
  experiment_ids: string[];
  call_ids: string[];
  evidence: {
    experiments: ExperimentRecord[];
    pass_comparison?: PassComparison;
    mixed_comparison?: MixedComparisonRecord;
    standalone_condition?: ComparedCondition;
  };
};
export type ExperimentResultsRepeatSeries = {
  repeat_key: string | null;
  member_ids: string[];
  rationale: string;
};
export type ExperimentResultsReport = {
  schema_version: "experiment-results-v1";
  source_workspace_id: string;
  entries: ExperimentResultsEntry[];
  repeat_series: ExperimentResultsRepeatSeries[];
};

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function nonempty(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function unique(values: string[]): string[] { return [...new Set(values)]; }
function ids(records: ExperimentRecord[]): string[] { return unique(records.flatMap(row => row.calls.map(call => call.call_id))); }
function exactKey(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return canonicalComparisonJson(value);
}
function attribution(label: ResultsAttribution["label"], reasons: string[]): ResultsAttribution {
  return { label, reasons: unique(reasons), scope: "source_gold" };
}
function passNominalKey(comparison: PassComparison, passCount: number): string | null {
  const identity = object(comparison.conditions.find(row => row.pass_count === 1)?.identity);
  if (!identity || !nonempty(identity.source_workspace_id) || !nonempty(identity.source_fingerprint)
    || !nonempty(identity.baseline_fingerprint) || !nonempty(identity.pack_id) || !nonempty(identity.pack_fingerprint)
    || !nonempty(identity.evaluator_version) || !nonempty(identity.original_request_fingerprint)) return null;
  return exactKey({ kind: "pass", source_workspace_id: identity.source_workspace_id,
    source_fingerprint: identity.source_fingerprint, baseline_fingerprint: identity.baseline_fingerprint,
    pack_id: identity.pack_id, pack_fingerprint: identity.pack_fingerprint,
    evaluator_version: identity.evaluator_version, original_request_fingerprint: identity.original_request_fingerprint,
    baseline_pass_count: 1, candidate_pass_count: passCount,
    comparison_evaluator_version: comparison.comparison_evaluator_version });
}
function passExactKey(comparison: PassComparison, baseline: ComparedCondition | undefined, candidate: ComparedCondition): string | null {
  const left = object(baseline?.identity); const right = object(candidate.identity);
  if (!left || !right || candidate.pass_count === null || !passNominalKey(comparison, candidate.pass_count)
    || !object(right.original_request_identity) || !Array.isArray(right.calls) || !right.calls.length
    || !Array.isArray(left.calls) || !left.calls.length
    || [...right.calls, ...left.calls].some(call => { const row = object(call); return !row || !nonempty(row.module_id) || !nonempty(row.module_version) || !object(row.route); })) return null;
  return exactKey({ nominal: passNominalKey(comparison, candidate.pass_count), original_request_identity: right.original_request_identity,
    configuration: right.calls, baseline_configuration: left.calls });
}
function passEntry(comparison: PassComparison, candidate: ComparedCondition, experiments: ExperimentRecord[], loaded: Record<string, string | null>, source_workspace_id: string): ExperimentResultsEntry {
  const baseline = comparison.conditions.find(row => row.pass_count === 1);
  const relevant = comparison.conditions.map(row => experiments.find(item => item.id === row.experiment_id)).filter((row): row is ExperimentRecord => !!row);
  const reasons = [...comparison.mismatch_reasons, ...candidate.reasons, ...(baseline?.reasons ?? [])];
  if (comparison.conditions.length !== 3 || [1, 2, 3].some(pass =>
    comparison.conditions.filter(row => row.pass_count === pass).length !== 1)) {
    reasons.push("Pass cohort lacks exactly one retained condition for each of one, two and three passes.");
  }
  const retained = relevant.length === comparison.conditions.length && relevant.every(row => row.source_workspace_id === source_workspace_id);
  if (!retained) reasons.push("A retained experiment in this pass cohort is unavailable.");
  const loadedIdentity = comparison.loaded_pack_identity;
  if (!loadedIdentity?.matches_retained || !nonempty(loadedIdentity.pack_fingerprint)
    || loaded[loadedIdentity.pack_id] !== loadedIdentity.pack_fingerprint) reasons.push("Loaded gold fingerprint does not match retained comparison identity.");
  if (!baseline || baseline.pass_count !== 1 || baseline.status !== "completed" || baseline.eligibility !== "eligible") reasons.push("One-pass baseline is not a completed eligible condition.");
  if (candidate.status !== "completed" || candidate.eligibility !== "eligible") reasons.push("Candidate is not a completed eligible condition.");
  const sameIdentity = baseline && exactKey(baseline.identity) === exactKey(candidate.identity);
  if (!sameIdentity) reasons.push("Baseline and candidate original request or actual route identity differs.");
  const matched = comparison.matched && retained && reasons.length === 0 && !!passExactKey(comparison, baseline, candidate);
  if (!matched && reasons.length === 0) reasons.push("Complete original request and actual call identity are required for attribution.");
  const base = baseline?.totals; const current = candidate.totals;
  const regression = candidate.calls.some(call => call.versions.some(version => version.regressions.length > 0));
  const gain = matched && !!base
    && current.distinct_exact_found_count > base.distinct_exact_found_count
    && current.distinct_exact_must_find_found_count !== null && base.distinct_exact_must_find_found_count !== null
    && current.distinct_exact_must_find_found_count >= base.distinct_exact_must_find_found_count
    && current.summed_call_outcomes.wrong <= base.summed_call_outcomes.wrong
    && current.summed_call_outcomes.partial <= base.summed_call_outcomes.partial
    && !regression;
  if (matched && !gain) reasons.push("No safe exact source-gold gain over the one-pass baseline is established.");
  const id = `pass:${comparison.comparison_id ?? "unknown"}:${candidate.pass_count ?? candidate.experiment_id}`;
  return { id, kind: "pass_candidate", created_at: relevant[0]?.created_at ?? "", attribution: attribution(!matched ? "Descriptive" : gain ? "Observed gain" : "Matched results", reasons),
    matched, mismatch_reasons: unique([...comparison.mismatch_reasons, ...(!matched ? reasons : [])]), repeat_key: passExactKey(comparison, baseline, candidate),
    experiment_ids: relevant.map(row => row.id), call_ids: ids(relevant), evidence: { experiments: relevant, pass_comparison: comparison } };
}

function partialPassEntry(comparison: PassComparison, experiments: ExperimentRecord[], source_workspace_id: string): ExperimentResultsEntry {
  const relevant = comparison.conditions.map(row => experiments.find(item => item.id === row.experiment_id))
    .filter((row): row is ExperimentRecord => !!row);
  const reasons = unique([...comparison.mismatch_reasons, ...comparison.conditions.flatMap(row => row.reasons),
    "Pass cohort has no retained candidate condition; exact source-gold attribution is unavailable.",
    ...(relevant.length !== comparison.conditions.length || relevant.some(row => row.source_workspace_id !== source_workspace_id)
      ? ["A retained experiment in this pass cohort is unavailable or belongs to a different source workspace."] : [])]);
  return { id: `pass:${comparison.comparison_id ?? "unknown"}:partial`, kind: "pass_candidate", created_at: relevant[0]?.created_at ?? "",
    attribution: attribution("Descriptive", reasons), matched: false, mismatch_reasons: reasons,
    repeat_key: null, experiment_ids: relevant.map(row => row.id), call_ids: ids(relevant),
    evidence: { experiments: relevant, pass_comparison: comparison } };
}

function mixedNominalKey(record: MixedComparisonRecord): string | null {
  const h = record.header;
  const nominations = h.request;
  if (!nonempty(h.pack_fingerprint) || !nonempty(h.evaluator_version) || !nominations?.mixed?.fingerprint || !nominations?.baseline?.fingerprint) return null;
  return exactKey({ kind: "mixed", source_workspace_id: h.source_workspace_id, source_file_ids: [...nominations.source_file_ids].sort(),
    pack_id: nominations.pack_id, pack_fingerprint: h.pack_fingerprint, evaluator_version: h.evaluator_version,
    mixed_assembly: nominations.mixed.fingerprint, baseline_assembly: nominations.baseline.fingerprint });
}
function mixedExactKey(record: MixedComparisonRecord): string | null {
  const evidence = record.result?.evidence;
  if (!mixedNominalKey(record) || !evidence || !evidence.candidates.mixed?.setup || !evidence.candidates.baseline?.setup) return null;
  const left = evidence.candidates.mixed.setup; const right = evidence.candidates.baseline.setup;
  if (exactKey(left) !== exactKey(right)) return null;
  return exactKey({ nominal: mixedNominalKey(record), setup: left,
    original_assemblies: { mixed: record.header.original_assemblies.mixed.fingerprint,
      baseline: record.header.original_assemblies.baseline.fingerprint } });
}
function scoredKeys(evaluation: MixedComparisonEvaluation, candidate: "mixed" | "baseline"): { keys: string[]; wrong: number; partial: number } | null {
  const result = { keys: [] as string[], wrong: 0, partial: 0 };
  for (const claim_type of ["gap", "tactic"] as const) {
    const rows = evaluation.source_evaluations.filter(row => row.candidate === candidate && row.point === "final" && row.claim_type === claim_type);
    if (rows.length !== 1 || rows[0].evaluation.status !== "scored" || !rows[0].evaluation.output_shape.valid || !rows[0].evaluation.score) return null;
    for (const outcome of rows[0].evaluation.outcomes) {
      if (outcome.outcome === "found" && outcome.gold_item_key) result.keys.push(`${claim_type}:${outcome.gold_item_key}`);
      if (outcome.outcome === "wrong") result.wrong++;
      if (outcome.outcome === "partial") result.partial++;
    }
  }
  result.keys = unique(result.keys);
  return result;
}
function mixedEntry(record: MixedComparisonRecord, loaded: Record<string, string | null>, source_workspace_id: string): ExperimentResultsEntry {
  const attempts = [record.attempts.mixed, record.attempts.baseline].filter((row): row is ExperimentRecord => !!row);
  const result = record.result?.evidence;
  const reasons: string[] = [];
  if (record.status !== "completed" || result?.status !== "completed") reasons.push("Mixed comparison is not completed.");
  if (attempts.length !== 2 || attempts.some(row => row.status !== "completed") || attempts[0]?.id === attempts[1]?.id
    || !record.links || record.links.mixed_experiment_id !== attempts[0]?.id || record.links.baseline_experiment_id !== attempts[1]?.id) reasons.push("Two distinct completed linked attempts are required.");
  if (attempts[0] && attempts[1] && ids([attempts[0]]).some(id => ids([attempts[1]]).includes(id))) reasons.push("Mixed and baseline attempts share a call identity.");
  const h = record.header;
  if (h.source_workspace_id !== source_workspace_id || h.source_workspace_id !== attempts[0]?.source_workspace_id || h.source_workspace_id !== attempts[1]?.source_workspace_id
    || attempts.some(row => row.pack_id !== h.request.pack_id || row.pack_fingerprint !== h.pack_fingerprint || row.evaluator_version !== h.evaluator_version)) reasons.push("Attempt source workspace, gold or evaluator identity differs from the comparison header.");
  if (loaded[h.request.pack_id] !== h.pack_fingerprint || h.evaluator_version !== result?.candidates.mixed?.setup?.evaluator_version) reasons.push("Loaded gold or evaluator identity differs from retained mixed comparison.");
  if (!mixedExactKey(record)) reasons.push("Captured document, assembly, evaluator or configuration identity is incomplete or mismatched.");
  if (result?.status === "completed") {
    if (result.candidates.mixed.status !== "completed" || result.candidates.baseline.status !== "completed") reasons.push("Both captured candidates must complete.");
    const setup = result.candidates.mixed.setup;
    if (setup.pack_fingerprint !== h.pack_fingerprint || setup.evaluator_version !== h.evaluator_version
      || setup.gate_policy !== h.gate_policy || setup.gate_policy_fingerprint !== h.gate_policy_fingerprint
      || setup.source_fingerprint !== attempts[0]?.source_fingerprint || setup.source_fingerprint !== attempts[1]?.source_fingerprint
      || setup.baseline_fingerprint !== attempts[0]?.baseline_fingerprint || setup.baseline_fingerprint !== attempts[1]?.baseline_fingerprint
      || exactKey([...setup.source_files.map(row => row.id)].sort()) !== exactKey([...h.request.source_file_ids].sort())
      || result.candidates.mixed.original_assembly.fingerprint !== h.original_assemblies.mixed.fingerprint
      || result.candidates.baseline.original_assembly.fingerprint !== h.original_assemblies.baseline.fingerprint) reasons.push("Captured setup differs from header or linked attempt identity.");
    const evaluations = result.evaluation;
    if (evaluations.evaluator_version !== setup.downstream_evaluator_version
      || evaluations.evaluator_version !== MIXED_DOWNSTREAM_EVALUATOR_VERSION) reasons.push("Retained downstream evaluator identity differs from captured setup or supported evaluator.");
    for (const dimension of ["source_gaps", "source_tactics"] as const) if (!evaluations.applicability.some(row => row.dimension === dimension && row.status === "scored")) reasons.push(`${dimension} source gold is unscored.`);
    const evaluatedSlots = evaluations.source_evaluations.map(row => `${row.candidate}:${row.point}:${row.claim_type}`);
    if (evaluations.source_evaluations.length !== 8 || unique(evaluatedSlots).length !== 8 || evaluations.source_evaluations.some(row => row.evaluation.pack_id !== h.request.pack_id || row.evaluation.pack_fingerprint !== h.pack_fingerprint || row.evaluation.evaluator_version !== h.evaluator_version || row.evaluation.call_kind !== (row.claim_type === "gap" ? "need_extract" : "inventory_extract") || row.evaluation.status !== "scored" || !row.evaluation.output_shape.valid || !row.evaluation.score)) reasons.push("Retained source evaluations are missing or have mismatched identities.");
    if (evaluations.changes.some(row => row.proven_error || row.severity === "blocking")) reasons.push("A proven error or blocking regression is retained.");
    if (evaluations.changes.some(row => row.message.startsWith("Matched gain unavailable:"))) reasons.push("Retained evaluator reports a mismatch.");
  }
  const matched = reasons.length === 0;
  const mixed = result?.status === "completed" ? scoredKeys(result.evaluation, "mixed") : null;
  const baseline = result?.status === "completed" ? scoredKeys(result.evaluation, "baseline") : null;
  const gain = matched && !!mixed && !!baseline && mixed.keys.length > baseline.keys.length
    && baseline.keys.every(key => mixed.keys.includes(key)) && mixed.wrong <= baseline.wrong && mixed.partial <= baseline.partial;
  if (matched && !gain) reasons.push("No safe exact final source-gold gain without baseline reference loss is established.");
  return { id: `mixed:${h.id}`, kind: "mixed_pair", created_at: h.created_at,
    attribution: attribution(!matched ? "Descriptive" : gain ? "Observed gain" : "Matched results", reasons), matched,
    mismatch_reasons: matched ? [] : reasons, repeat_key: mixedExactKey(record), experiment_ids: attempts.map(row => row.id), call_ids: ids(attempts),
    evidence: { experiments: attempts, mixed_comparison: record } };
}

/** Derive one complete, source-scoped report without calls to evaluators, runners or persistence. */
export function buildExperimentResultsReport(args: {
  source_workspace_id: string; experiments: ExperimentRecord[]; pass_comparisons: PassComparison[];
  mixed_comparisons: MixedComparisonRecord[]; loaded_pack_fingerprints: Record<string, string | null>;
  standalone_conditions?: Record<string, ComparedCondition>;
}): ExperimentResultsReport {
  const entries: ExperimentResultsEntry[] = [];
  const consumed = new Set<string>();
  const nominalByEntry = new Map<string, string[]>();
  for (const comparison of args.pass_comparisons) {
    const candidates = comparison.conditions.filter(row => row.pass_count !== 1);
    const missing = [2, 3].filter(pass => !candidates.some(candidate => candidate.pass_count === pass));
    if (!candidates.length) {
      const entry = partialPassEntry(comparison, args.experiments, args.source_workspace_id);
      entries.push(entry); nominalByEntry.set(entry.id, [2, 3].flatMap(pass => passNominalKey(comparison, pass) ?? []));
      entry.experiment_ids.forEach(id => consumed.add(id));
    }
    for (const [index, candidate] of candidates.entries()) {
      const entry = passEntry(comparison, candidate, args.experiments, args.loaded_pack_fingerprints, args.source_workspace_id);
      const represented = candidate.pass_count === null ? [] : [candidate.pass_count];
      // One retained candidate represents absent conditions for this incomplete cohort.
      // This keeps the history in each nominal series without duplicating a candidate.
      if (index === 0) represented.push(...missing);
      entries.push(entry); nominalByEntry.set(entry.id, unique(represented.flatMap(pass => passNominalKey(comparison, pass) ?? [])));
      entry.experiment_ids.forEach(id => consumed.add(id));
    }
  }
  for (const comparison of args.mixed_comparisons) {
    const entry = mixedEntry(comparison, args.loaded_pack_fingerprints, args.source_workspace_id);
    entries.push(entry); nominalByEntry.set(entry.id, [mixedNominalKey(comparison)].filter((key): key is string => !!key));
    entry.experiment_ids.forEach(id => consumed.add(id));
  }
  for (const row of args.experiments) if (!consumed.has(row.id)) entries.push({
    id: `experiment:${row.id}`, kind: "standalone_attempt", created_at: row.created_at,
    attribution: attribution("Descriptive", ["Standalone retained attempt; no matched comparison supports attribution."]),
    matched: false, mismatch_reasons: [], repeat_key: null, experiment_ids: [row.id], call_ids: ids([row]),
    evidence: { experiments: [row], standalone_condition: args.standalone_conditions?.[row.id] },
  });
  const groups = new Map<string, ExperimentResultsEntry[]>();
  for (const entry of entries) {
    for (const nominal of nominalByEntry.get(entry.id) ?? []) groups.set(nominal, [...(groups.get(nominal) ?? []), entry]);
  }
  const repeat_series: ExperimentResultsRepeatSeries[] = [];
  for (const members of groups.values()) {
    const keys = unique(members.flatMap(entry => entry.repeat_key ? [entry.repeat_key] : []));
    const allComplete = members.every(entry => entry.repeat_key !== null && entry.matched);
    const allGain = members.every(entry => entry.attribution.label === "Observed gain");
    const disjoint = members.every((entry, index) => members.slice(index + 1).every(other =>
      entry.id !== other.id && !entry.experiment_ids.some(id => other.experiment_ids.includes(id)) && !entry.call_ids.some(id => other.call_ids.includes(id))));
    const consistent = members.length >= 2 && keys.length === 1 && allComplete && allGain && disjoint;
    const rationale = consistent
      ? "At least two independent complete matched comparisons share exact document, gold, evaluator, configuration and candidate conditions; every comparable member gains exact source-gold recovery without a known regression. This is a descriptive pattern, not statistical significance or deployment approval."
      : "Consistency is unavailable: the complete comparable series needs at least two disjoint, fully identified matched gains; neutral, failed, blocked, mismatched or identity-drift members prevent a repeated claim.";
    repeat_series.push({ repeat_key: keys.length === 1 ? keys[0] : null, member_ids: members.map(row => row.id), rationale });
    if (consistent) for (const entry of members) entry.attribution = attribution("Consistent improvement", [...entry.attribution.reasons, rationale]);
  }
  return { schema_version: "experiment-results-v1", source_workspace_id: args.source_workspace_id, entries, repeat_series };
}

/** Export the complete report or one complete evidence-bearing entry per JSONL line. */
export function serializeExperimentResultsReport(report: ExperimentResultsReport, format: "json" | "jsonl"): string {
  if (format === "json") return JSON.stringify(report);
  if (format === "jsonl") return report.entries.map(entry => JSON.stringify({ schema_version: report.schema_version,
    source_workspace_id: report.source_workspace_id, entry,
    repeat_series: report.repeat_series.filter(series => series.member_ids.includes(entry.id)) })).join("\n") + (report.entries.length ? "\n" : "");
  throw new TypeError("Unsupported experiment results export format.");
}
