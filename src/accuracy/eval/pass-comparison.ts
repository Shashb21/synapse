/** Derive conservative controlled-pass comparisons from retained experiment evidence. */
import { createHash } from "node:crypto";
import type { ExperimentRecord } from "@/accuracy/experiments/records";
import type { AgentEvent, AgentCritiqueEvent, AgentSnapshotEvent, CriticIssue } from "@/accuracy/kernel/agent-events";
import type { TokenUsage, RunStatus } from "@/accuracy/kernel/contracts";
import type { ExperimentItemOutcome, ExperimentVersionEvaluation } from "./experiment-gold";
import { experimentPackFingerprint } from "./experiment-gold";
import { mustFindForPack, type ReferenceMustFindTargets } from "./reference-gold";
import { executionCompatibility, type ExecutionEvidence } from "@/accuracy/kernel/execution-identity";

export const PASS_COMPARISON_EVALUATOR_VERSION = "pass-comparison-v2";
export type ComparisonRun = {
  call_id: string;
  module_id: string;
  module_version: string;
  route: unknown;
  status: RunStatus;
  duration_ms: number | null;
  cost_usd: number | null;
  token_usage: TokenUsage | null;
  events: AgentEvent[];
  execution_identity?: ExecutionEvidence | null;
};
export type ComparisonEvidence = {
  experiment: ExperimentRecord;
  runs: ComparisonRun[];
};
export type OutcomeCounts = {
  found: number;
  partial: number;
  missed: number;
  wrong: number;
};
export type ComparisonMetering = {
  token_usage: TokenUsage;
  cost_usd: number;
  latency_ms: number;
};
export type ComparedVersion = {
  version_index: number;
  evaluation: unknown;
  outcomes: ExperimentItemOutcome[];
  counts: OutcomeCounts;
  must_find: OutcomeCounts | null;
  exact_must_find_keys: string[] | null;
  recovered_from_v0: string[] | null;
  lost_from_v0: string[] | null;
  recovered_from_previous: string[] | null;
  lost_from_previous: string[] | null;
  delta_from_v0: OutcomeCounts;
  delta_from_previous: OutcomeCounts;
  regressions: string[];
  snapshot: AgentSnapshotEvent | null;
  critique: AgentCritiqueEvent | null;
  cumulative_metering: ComparisonMetering;
};
export type ComparedCall = {
  call_id: string;
  call_kind: string;
  lineage_key: string;
  runtime: ComparisonRun | null;
  versions: ComparedVersion[];
  requested_revision_passes: number | null;
  terminal_iteration: number | null;
  selected_iteration: number | null;
  quality_basis: "selected_raw_snapshot" | "retained_output" | "unavailable";
  full_call_metering: ComparisonMetering;
};
export type ComparedConditionTotals = ComparisonMetering & {
  summed_call_outcomes: OutcomeCounts;
  summed_call_must_find_outcomes: OutcomeCounts | null;
  distinct_exact_found_count: number;
  distinct_exact_found_keys: string[];
  distinct_exact_must_find_found_count: number | null;
  distinct_exact_must_find_keys: string[] | null;
};
export type ComparedCondition = {
  experiment_id: string;
  pass_count: number | null;
  status: string;
  identity: unknown;
  eligibility: "eligible" | "ineligible" | "unknown";
  reasons: string[];
  calls: ComparedCall[];
  totals: ComparedConditionTotals;
};
export type PassComparison = {
  comparison_evaluator_version: string;
  comparison_id: string | null;
  matched: boolean;
  mismatch_reasons: string[];
  conditions: ComparedCondition[];
  loaded_pack_identity: {
    pack_id: string;
    pack_fingerprint: string | null;
    matches_retained: boolean;
  } | null;
  recommendation: {
    experiment_id: string;
    pass_count: number;
    reason: string;
  } | null;
};

/** Canonical object keys preserve array order because request execution order matters. */
export function canonicalComparisonJson(value: unknown): string {
  const visit = (item: unknown): unknown => Array.isArray(item)
    ? item.map(visit)
    : item && typeof item === "object"
      ? Object.fromEntries(Object.entries(item)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, visit(child)]))
      : item;
  return JSON.stringify(visit(value));
}

/** Stable original-request identity, independent of JSON object insertion order. */
export function comparisonRequestFingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalComparisonJson(value)).digest("hex");
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function emptyCounts(): OutcomeCounts {
  return { found: 0, partial: 0, missed: 0, wrong: 0 };
}

function counts(outcomes: ExperimentItemOutcome[]): OutcomeCounts {
  const result = emptyCounts();
  for (const item of outcomes) {
    if (Object.hasOwn(result, item.outcome)) result[item.outcome]++;
  }
  return result;
}

function delta(a: OutcomeCounts, b: OutcomeCounts): OutcomeCounts {
  return {
    found: a.found - b.found,
    partial: a.partial - b.partial,
    missed: a.missed - b.missed,
    wrong: a.wrong - b.wrong,
  };
}

function addCounts(a: OutcomeCounts, b: OutcomeCounts): OutcomeCounts {
  return {
    found: a.found + b.found,
    partial: a.partial + b.partial,
    missed: a.missed + b.missed,
    wrong: a.wrong + b.wrong,
  };
}

function difference(a: string[], b: string[]): string[] {
  return a.filter(key => !b.includes(key)).sort();
}

function emptyMetering(): ComparisonMetering {
  return {
    cost_usd: 0,
    latency_ms: 0,
    token_usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

function addMetering(a: ComparisonMetering, b: ComparisonMetering): ComparisonMetering {
  return {
    cost_usd: a.cost_usd + b.cost_usd,
    latency_ms: a.latency_ms + b.latency_ms,
    token_usage: {
      prompt_tokens: a.token_usage.prompt_tokens + b.token_usage.prompt_tokens,
      completion_tokens: a.token_usage.completion_tokens + b.token_usage.completion_tokens,
      total_tokens: a.token_usage.total_tokens + b.token_usage.total_tokens,
    },
  };
}

/** Only explicit source-support categories/codes qualify; omission severity alone never does. */
function serious(issue: CriticIssue): boolean {
  const explicit = new Set([
    "false", "false_claim", "false_evidence", "unsupported", "unsupported_claim", "unsupported_content",
    "provenance", "invalid_provenance", "missing_provenance", "quote_invalid", "invalid_quote",
  ]);
  return issue.category !== "omission"
    && ["high", "critical"].includes(issue.severity)
    && (explicit.has(issue.category.toLowerCase()) || explicit.has(issue.code.toLowerCase()));
}

/** Positional issue IDs do not identify the underlying source-support evidence. */
function seriousFindingSignature(issue: CriticIssue): string {
  return canonicalComparisonJson({
    category: issue.category,
    code: issue.code,
    claim: issue.claim,
    source_ref: issue.source_ref ?? null,
  });
}

function originalSource(experiment: ExperimentRecord, input: unknown): string | null {
  const copied = record(input).source_file_id;
  if (typeof copied !== "string") return null;
  const rows = record(experiment.baseline_snapshot).source_files;
  if (!Array.isArray(rows)) return null;
  const mapping = rows.map(record).find(row => row.copied_id === copied);
  return typeof mapping?.original_id === "string" ? mapping.original_id : null;
}

function compareCondition(evidence: ComparisonEvidence, targets: ReferenceMustFindTargets | null): ComparedCondition {
  const { experiment, runs } = evidence;
  const condition = record(experiment.condition);
  const pass = condition.critic_revision_passes;
  const pass_count = typeof pass === "number" && [1, 2, 3].includes(pass) ? pass : null;
  const ineligible: string[] = [];
  const unknown: string[] = [];
  if (targets === null) unknown.push("Must-find targets are unavailable for the retained pack identity.");
  if (experiment.status !== "completed") ineligible.push(`Experiment status is ${experiment.status}.`);
  if (pass_count === null) ineligible.push("Invalid or missing pass condition.");
  const groups = new Map<string, ExperimentRecord["calls"]>();
  for (const row of experiment.calls) {
    groups.set(row.call_id, [...(groups.get(row.call_id) ?? []), row]);
  }
  if (!groups.size) ineligible.push("No retained calls.");
  const occurrences = new Map<string, number>();
  const calls = [...groups.entries()].map(([call_id, rows]): ComparedCall => {
    rows.sort((a, b) => a.version_index - b.version_index);
    const first = rows[0];
    const extraction = ["inventory_extract", "need_extract"].includes(first.call_kind);
    const source = originalSource(experiment, first.input);
    if (extraction && source === null) ineligible.push(`Unresolved original source for ${call_id}.`);
    const base = `${first.call_kind}:${source ?? "workspace"}`;
    const occurrence = occurrences.get(base) ?? 0;
    occurrences.set(base, occurrence + 1);
    const lineage_key = `${base}:${occurrence}`;
    const runtime = runs.find(run => run.call_id === call_id) ?? null;
    if (!runtime) {
      unknown.push(`Missing runtime for ${lineage_key}.`);
    } else {
      if (executionCompatibility(runtime.execution_identity) === null) unknown.push(`Missing execution code/prompt identity for ${lineage_key}.`);
      if (runtime.execution_identity?.completions.some(row => row.status !== "succeeded")) {
        unknown.push(`Failed or interrupted completion evidence for ${lineage_key}.`);
      }
      if (runtime.status !== "ok") ineligible.push(`Runtime ${lineage_key} is ${runtime.status}.`);
      if (runtime.cost_usd === null || runtime.duration_ms === null || runtime.token_usage === null) {
        unknown.push(`Missing runtime metering for ${lineage_key}.`);
      }
      if (rows.some(row => row.module_version !== runtime.module_version
        || canonicalComparisonJson(row.route) !== canonicalComparisonJson(runtime.route))) {
        ineligible.push(`Runtime identity disagrees with retained versions for ${lineage_key}.`);
      }
    }
    if (extraction && (pass_count === null || rows.length !== pass_count + 1
      || rows.some((row, index) => row.version_index !== index))) {
      ineligible.push(`Missing or extra requested versions for ${lineage_key}.`);
    }
    const events = runtime?.events ?? [];
    const snapshots = events.filter(event => event.event_type === "snapshot");
    const critiques = events.filter(event => event.event_type === "critique");
    const terminal_iteration = extraction
      ? snapshots.length ? Math.max(...snapshots.map(event => event.iteration)) : null
      : rows.at(-1)?.version_index ?? null;
    if (extraction && runtime && (terminal_iteration !== pass_count
      || snapshots.length > rows.length || critiques.length > rows.length
      || snapshots.some(event => !rows.some(row => row.version_index === event.iteration))
      || critiques.some(event => !rows.some(row => row.version_index === event.iteration)))) {
      ineligible.push(`Produced depth disagrees with requested versions for ${lineage_key}.`);
    }
    const judgments = events.filter(event => event.event_type === "judgment");
    const judgment = judgments[0];
    const exactJudgment = judgments.length === 1 && Number.isInteger(judgment.selected_iteration)
      && judgment.selected_iteration >= 0 && typeof judgment.reason === "string" && judgment.reason.trim().length > 0
      && rows.filter(row => row.version_index === judgment.selected_iteration).length === 1
      && snapshots.filter(event => event.iteration === judgment.selected_iteration).length === 1
      && critiques.filter(event => event.iteration === judgment.selected_iteration).length === 1;
    const selected_iteration = extraction ? exactJudgment ? judgment.selected_iteration : null : terminal_iteration;
    const quality_basis = extraction ? exactJudgment ? "selected_raw_snapshot" : "unavailable" : "retained_output";
    if (extraction && !exactJudgment) {
      unknown.push(`Missing or invalid exact selected judgment for ${lineage_key}.`);
    }
    let cumulative_metering = emptyMetering();
    const versions: ComparedVersion[] = [];
    for (const row of rows) {
      const evaluations = experiment.evaluations.filter(item =>
        item.call_id === call_id && item.version_index === row.version_index);
      const evaluation = evaluations.length === 1 ? evaluations[0].evaluation : null;
      const assessed = record(evaluation) as Partial<ExperimentVersionEvaluation>;
      if (!evaluation) {
        unknown.push(`Missing or duplicate evaluation for ${lineage_key} V${row.version_index}.`);
      } else if (row.output_error || !["scored", "gold_not_applicable"].includes(assessed.status ?? "")
        || !assessed.output_shape?.valid) {
        ineligible.push(`Invalid output/evaluation for ${lineage_key} V${row.version_index}.`);
      }
      if (evaluation && (assessed.pack_id !== experiment.pack_id
        || assessed.pack_fingerprint !== experiment.pack_fingerprint
        || assessed.evaluator_version !== experiment.evaluator_version
        || assessed.call_kind !== row.call_kind)) {
        ineligible.push(`Evaluation identity mismatch for ${lineage_key} V${row.version_index}.`);
      }
      const outcomes = Array.isArray(assessed.outcomes) ? assessed.outcomes : [];
      const mustKeys = targets === null ? []
        : first.call_kind === "need_extract" ? targets.gap_ids
          : first.call_kind === "inventory_extract" ? [...targets.tactic_identifiers, ...targets.tactic_numbers.map(String)]
            : [];
      const mustOutcomes = outcomes.filter(item => item.gold_item_key && mustKeys.includes(item.gold_item_key));
      const exact_must_find_keys = mustOutcomes.filter(item => item.outcome === "found").map(item => item.gold_item_key!).sort();
      const snapshot = events.find(event =>
        event.event_type === "snapshot" && event.iteration === row.version_index) as AgentSnapshotEvent | undefined;
      const critique = events.find(event =>
        event.event_type === "critique" && event.iteration === row.version_index) as AgentCritiqueEvent | undefined;
      if (extraction && (snapshots.filter(event => event.iteration === row.version_index).length !== 1
        || critiques.filter(event => event.iteration === row.version_index).length !== 1 || !critique || critique.score === null)) {
        unknown.push(`Missing assessment for ${lineage_key} V${row.version_index}.`);
      }
      if (extraction && snapshot && canonicalComparisonJson(snapshot.output) !== canonicalComparisonJson(row.output)) {
        ineligible.push(`Retained raw output disagrees with snapshot for ${lineage_key} V${row.version_index}.`);
      }
      const prior = versions.at(-1);
      const initial = versions[0];
      const regressions: string[] = [];
      if (snapshot) {
        if (snapshot.signals.quote_validity.invalid_count > 0) ineligible.push(`Invalid quotes in ${lineage_key} V${row.version_index}.`);
        if (snapshot.signals.invariant_failures.length) ineligible.push(`Invariant failures in ${lineage_key} V${row.version_index}.`);
        if (snapshot.signals.quote_validity.unchecked_count > 0) unknown.push(`Unchecked quotes in ${lineage_key} V${row.version_index}.`);
        if (prior?.snapshot && snapshot.signals.quote_validity.invalid_count > prior.snapshot.signals.quote_validity.invalid_count) {
          regressions.push("Invalid quote count increased.");
        }
        if (prior?.snapshot) {
          regressions.push(...difference(snapshot.signals.invariant_failures, prior.snapshot.signals.invariant_failures)
            .map(key => `New invariant failure: ${key}`));
        }
      }
      if (critique) {
        if (extraction && critique.structural_fate?.status !== "assessed") {
          unknown.push(`Structural disposition evidence is unavailable in ${lineage_key} V${row.version_index}.`);
        }
        if (critique.completeness.risk_level === "check_failed" || critique.completeness.unchecked_block_ids.length) {
          unknown.push(`Incomplete completeness assessment in ${lineage_key} V${row.version_index}.`);
        }
        const findings = critique.issues.filter(serious);
        if (findings.length) ineligible.push(`Serious source-support findings in ${lineage_key} V${row.version_index}.`);
        if (prior?.critique) {
          const priorSignatures = new Set(prior.critique.issues.filter(serious).map(seriousFindingSignature));
          for (const finding of findings) {
            if (!priorSignatures.has(seriousFindingSignature(finding))) {
              regressions.push(`New serious critic finding: ${finding.issue_id}`);
            }
          }
        }
      }
      for (const event of [snapshot, critique]) {
        if (event) cumulative_metering = addMetering(cumulative_metering, event);
      }
      const versionCounts = counts(outcomes);
      versions.push({
        version_index: row.version_index,
        evaluation,
        outcomes,
        counts: versionCounts,
        must_find: targets === null ? null : counts(mustOutcomes),
        exact_must_find_keys: targets === null ? null : exact_must_find_keys,
        recovered_from_v0: targets === null ? null
          : initial ? difference(exact_must_find_keys, initial.exact_must_find_keys ?? []) : [],
        lost_from_v0: targets === null ? null
          : initial ? difference(initial.exact_must_find_keys ?? [], exact_must_find_keys) : [],
        recovered_from_previous: targets === null ? null
          : prior ? difference(exact_must_find_keys, prior.exact_must_find_keys ?? []) : [],
        lost_from_previous: targets === null ? null
          : prior ? difference(prior.exact_must_find_keys ?? [], exact_must_find_keys) : [],
        delta_from_v0: delta(versionCounts, initial?.counts ?? versionCounts),
        delta_from_previous: delta(versionCounts, prior?.counts ?? versionCounts),
        regressions,
        snapshot: snapshot ?? null,
        critique: critique ?? null,
        cumulative_metering,
      });
    }
    const full_call_metering = runtime ? {
      cost_usd: runtime.cost_usd ?? 0,
      latency_ms: runtime.duration_ms ?? 0,
      token_usage: runtime.token_usage ?? emptyMetering().token_usage,
    } : emptyMetering();
    return { call_id, call_kind: first.call_kind, lineage_key, runtime, versions, full_call_metering,
      requested_revision_passes: extraction ? pass_count : null, terminal_iteration, selected_iteration, quality_basis };
  });
  // Request scope identifies missing pipeline stages even when another source completed.
  const request = record(condition.original_request_identity);
  const selected = Array.isArray(request.source_file_ids) ? request.source_file_ids : [];
  const expectedKinds = request.mode === "pipeline"
    ? ["inventory_extract", "need_extract"] : [record(request.call).call_kind].filter(Boolean);
  const expectedSources = request.mode === "pipeline"
    ? selected : [record(record(request.call).input).source_file_id].filter(Boolean);
  for (const source of expectedSources) {
    for (const kind of expectedKinds) {
      if (calls.filter(call => call.lineage_key.startsWith(`${kind}:${source}:`)).length !== 1) {
        ineligible.push(`Missing or duplicate selected call ${kind}:${source}.`);
      }
    }
  }
  if (request.mode === "pipeline") {
    for (const kind of ["merge_dedupe", "status_derive"]) {
      if (calls.filter(call => call.call_kind === kind).length !== selected.length) {
        ineligible.push(`Missing or duplicate pipeline ${kind} calls.`);
      }
    }
  }
  let metering = emptyMetering();
  let summed_call_outcomes = emptyCounts();
  let summed_call_must_find_outcomes = targets === null ? null : emptyCounts();
  const exactGoldKeys = new Set<string>();
  const exactMustFindKeys = new Set<string>();
  for (const call of calls) {
    const final = call.versions.find(version => version.version_index === call.selected_iteration);
    metering = addMetering(metering, call.full_call_metering);
    summed_call_outcomes = addCounts(summed_call_outcomes, final?.counts ?? emptyCounts());
    if (summed_call_must_find_outcomes !== null) {
      summed_call_must_find_outcomes = addCounts(summed_call_must_find_outcomes, final?.must_find ?? emptyCounts());
    }
    for (const outcome of final?.outcomes ?? []) {
      if (outcome.outcome === "found" && outcome.gold_item_key) {
        exactGoldKeys.add(`${call.call_kind}:${outcome.gold_item_key}`);
      }
    }
    for (const key of final?.exact_must_find_keys ?? []) {
      exactMustFindKeys.add(`${call.call_kind}:${key}`);
    }
  }
  const totals: ComparedConditionTotals = {
    ...metering,
    summed_call_outcomes,
    summed_call_must_find_outcomes,
    distinct_exact_found_count: exactGoldKeys.size,
    distinct_exact_found_keys: [...exactGoldKeys].sort(),
    distinct_exact_must_find_found_count: targets === null ? null : exactMustFindKeys.size,
    distinct_exact_must_find_keys: targets === null ? null : [...exactMustFindKeys].sort(),
  };
  const identity = {
    source_workspace_id: experiment.source_workspace_id,
    source_fingerprint: experiment.source_fingerprint,
    baseline_fingerprint: experiment.baseline_fingerprint,
    pack_id: experiment.pack_id,
    pack_fingerprint: experiment.pack_fingerprint,
    evaluator_version: experiment.evaluator_version,
    comparison_evaluator_version: condition.comparison_evaluator_version,
    original_request_identity: condition.original_request_identity,
    original_request_fingerprint: condition.original_request_fingerprint,
    calls: calls.map(call => ({
      lineage_key: call.lineage_key,
      module_id: call.runtime?.module_id,
      module_version: call.runtime?.module_version,
      route: call.runtime?.route,
      execution_identity: executionCompatibility(call.runtime?.execution_identity),
    })).sort((a, b) => a.lineage_key.localeCompare(b.lineage_key)),
  };
  return {
    experiment_id: experiment.id,
    pass_count,
    status: experiment.status,
    identity,
    eligibility: ineligible.length ? "ineligible" : unknown.length ? "unknown" : "eligible",
    reasons: [...new Set([...ineligible, ...unknown])],
    calls,
    totals,
  };
}

/** Compare pure retained evidence; no database or gold access occurs here. */
export function comparePassExperiments(evidence: ComparisonEvidence[], targets: ReferenceMustFindTargets | null): PassComparison {
  const conditions = evidence.map(item => compareCondition(item, targets))
    .sort((a, b) => (a.pass_count ?? 0) - (b.pass_count ?? 0));
  const mismatch_reasons: string[] = [];
  if (conditions.length !== 3 || canonicalComparisonJson(conditions.map(item => item.pass_count)) !== "[1,2,3]") {
    mismatch_reasons.push("Expected exactly one condition for each of one, two and three passes.");
  }
  const ids = evidence.map(item => record(item.experiment.condition).comparison_id);
  const comparison_id = typeof ids[0] === "string" ? ids[0] : null;
  if (!comparison_id || ids.some(id => id !== comparison_id)) mismatch_reasons.push("Comparison IDs do not match.");
  if (new Set(evidence.map(item => item.experiment.id)).size !== evidence.length) mismatch_reasons.push("Duplicate experiment IDs.");
  for (const condition of conditions) {
    const identity = record(condition.identity);
    if (identity.comparison_evaluator_version !== PASS_COMPARISON_EVALUATOR_VERSION
      || !identity.original_request_identity || !identity.original_request_fingerprint) {
      mismatch_reasons.push(`Missing or unsupported comparison identity for ${condition.experiment_id}.`);
    }
    if (conditions[0] && canonicalComparisonJson(condition.identity) !== canonicalComparisonJson(conditions[0].identity)) {
      mismatch_reasons.push(`Source, baseline, pack, evaluator, original request or actual module/route identity differs for ${condition.experiment_id}.`);
    }
  }
  const matched = mismatch_reasons.length === 0;
  const ranked = matched ? conditions.filter(item => item.eligibility === "eligible").sort((a, b) =>
    (b.totals.distinct_exact_must_find_found_count ?? 0) - (a.totals.distinct_exact_must_find_found_count ?? 0)
    || b.totals.distinct_exact_found_count - a.totals.distinct_exact_found_count
    || a.totals.summed_call_outcomes.wrong - b.totals.summed_call_outcomes.wrong
    || a.totals.summed_call_outcomes.partial - b.totals.summed_call_outcomes.partial
    || a.totals.cost_usd - b.totals.cost_usd
    || a.totals.latency_ms - b.totals.latency_ms
    || a.pass_count! - b.pass_count!) : [];
  const winner = ranked[0];
  return {
    comparison_evaluator_version: PASS_COMPARISON_EVALUATOR_VERSION,
    comparison_id,
    matched,
    mismatch_reasons: [...new Set(mismatch_reasons)],
    conditions,
    loaded_pack_identity: null,
    recommendation: winner ? {
      experiment_id: winner.experiment_id,
      pass_count: winner.pass_count!,
      reason: "Eligible matched condition ranked by distinct exact must-find keys, distinct exact gold keys, fewer summed wrong items, fewer summed partial items, cost, latency, then pass count. This is not deployment approval.",
    } : null,
  };
}

/** Load must-find targets only inside evaluation code, then derive the comparison. */
export function evaluatePassComparison(evidence: ComparisonEvidence[]): PassComparison {
  if (!evidence[0]) return comparePassExperiments(evidence, null);
  const pack_id = evidence[0].experiment.pack_id;
  let pack_fingerprint: string | null = null;
  let targets: ReferenceMustFindTargets | null = null;
  let matches_retained = false;
  let unavailableReason = "Current reference pack fingerprint differs from retained pack identity; must-find targets are unavailable.";
  try {
    pack_fingerprint = experimentPackFingerprint(pack_id);
    matches_retained = evidence.every(({ experiment }) =>
      experiment.pack_id === pack_id && experiment.pack_fingerprint === pack_fingerprint);
    if (matches_retained) {
      targets = mustFindForPack(pack_id);
      // Discard target membership if the files changed while they were read.
      const afterReadFingerprint = experimentPackFingerprint(pack_id);
      if (afterReadFingerprint !== pack_fingerprint) {
        pack_fingerprint = afterReadFingerprint;
        matches_retained = false;
        targets = null;
      }
    }
  } catch (error) {
    const expectedReadError = error instanceof Error && (
      error instanceof SyntaxError
      || ("code" in error && typeof error.code === "string")
      || error.message.startsWith("Unknown reference pack:")
    );
    if (!expectedReadError) throw error;
    targets = null;
    matches_retained = false;
    unavailableReason = `Current reference pack could not be read (${error.message}); must-find targets are unavailable.`;
  }
  const comparison = comparePassExperiments(evidence, targets);
  comparison.loaded_pack_identity = { pack_id, pack_fingerprint, matches_retained };
  if (!matches_retained) {
    comparison.matched = false;
    comparison.recommendation = null;
    comparison.mismatch_reasons.push(unavailableReason);
  }
  return comparison;
}
