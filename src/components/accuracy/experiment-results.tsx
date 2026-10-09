"use client";

/** Read-only, source-scoped experiment history with readable evidence and full exports. */
import { useEffect, useState } from "react";
import type { ExperimentResultsEntry, ExperimentResultsReport } from "@/accuracy/experiments/results-report";
import type { ComparedCall, ComparedCondition, ComparedVersion, OutcomeCounts } from "@/accuracy/eval/pass-comparison";
import type { MixedCandidateEvidence, MixedComparisonEvaluation, MixedSourceEvaluation } from "@/accuracy/experiments/mixed-types";

const unknown = (value: string | number | null | undefined) => value === null || value === undefined ? "Unknown" : String(value);
const list = (values: readonly string[] | null | undefined) => values?.length ? values.join(", ") : "None";
const money = (value: number | null | undefined) => value === null || value === undefined ? "Unknown" : `$${value.toFixed(4)}`;
const milliseconds = (value: number | null | undefined) => value === null || value === undefined ? "Unknown" : `${value} ms`;
const delta = (value: number | null | undefined) => value === null || value === undefined ? "Unknown" : `${value >= 0 ? "+" : ""}${value}`;
const keyDifference = (left: readonly string[], right: readonly string[]) => left.filter(key => !right.includes(key));

function OutcomeDelta({ counts }: { counts: OutcomeCounts }) {
  return <>Found {delta(counts.found)}, partial {delta(counts.partial)}, missed {delta(counts.missed)}, wrong {delta(counts.wrong)}</>;
}

function PassVersionRow({ version, previous }: { version: ComparedVersion; previous?: ComparedVersion }) {
  const mustFindChange = previous?.exact_must_find_keys && version.exact_must_find_keys
    ? `recovered ${list(keyDifference(version.exact_must_find_keys, previous.exact_must_find_keys))}; lost ${list(keyDifference(previous.exact_must_find_keys, version.exact_must_find_keys))}`
    : "Unknown";
  return <tr className="border-b border-border align-top">
    <th scope="row" className="p-2">V{version.version_index}</th>
    <td className="p-2">{version.counts.found} / {version.counts.partial} / {version.counts.missed} / {version.counts.wrong}</td>
    <td className="p-2 break-all">{version.exact_must_find_keys ? list(version.exact_must_find_keys) : "Unknown"}; must-find from previous: {mustFindChange}</td>
    <td className="p-2"><OutcomeDelta counts={version.delta_from_previous} />; recovered {version.recovered_from_previous ? list(version.recovered_from_previous) : "Unknown"}; lost {version.lost_from_previous ? list(version.lost_from_previous) : "Unknown"}</td>
    <td className="p-2"><OutcomeDelta counts={version.delta_from_v0} />; recovered {version.recovered_from_v0 ? list(version.recovered_from_v0) : "Unknown"}; lost {version.lost_from_v0 ? list(version.lost_from_v0) : "Unknown"}</td>
    <td className="p-2">{list(version.regressions)}</td>
  </tr>;
}

function PassCallDetail({ condition, call, standalone = false }: { condition: ComparedCondition; call: ComparedCall; standalone?: boolean }) {
  return <details className="border-t border-border py-2">
    <summary className="cursor-pointer text-sm font-medium break-all">{standalone ? "Standalone" : `${condition.pass_count ?? "Unknown"} pass`} · {call.call_kind} · {call.call_id}</summary>
    <p className="mt-2 text-sm">Module: {unknown(call.runtime?.module_id)} / {unknown(call.runtime?.module_version)} · Cost: {money(call.runtime?.cost_usd)} · Latency: {milliseconds(call.runtime?.duration_ms)}</p>
    <p className="mt-2 text-sm">Requested revisions: {unknown(call.requested_revision_passes)} · Terminal: {call.terminal_iteration == null ? "Unknown" : `V${call.terminal_iteration}`} · Selected: {call.selected_iteration == null ? "Unknown" : `V${call.selected_iteration}`}</p>
    <p className="text-sm">Quality: {call.quality_basis === "selected_raw_snapshot" ? "selected raw snapshot" : call.quality_basis === "retained_output" ? "retained output" : "Unknown"} · Usage: entire run</p>
    <div className="overflow-x-auto"><table aria-label="Per-call version outcomes" className="mt-2 w-full min-w-[650px] border-collapse text-left text-sm">
      <caption className="mb-1 text-left">Per-call version outcomes</caption>
      <thead><tr className="border-b border-border"><th scope="col" className="p-2">Version</th><th scope="col" className="p-2">Found / partial / missed / wrong</th><th scope="col" className="p-2">Must-find keys</th><th scope="col" className="p-2">From previous</th><th scope="col" className="p-2">From V0</th><th scope="col" className="p-2">Regressions</th></tr></thead>
      <tbody>{call.versions.map((version, index) => <PassVersionRow key={version.version_index} version={version} previous={call.versions[index - 1]} />)}</tbody>
    </table></div>
    {call.versions.map(version => <details key={version.version_index} className="mt-2 text-sm">
      <summary className="cursor-pointer">V{version.version_index} item outcomes and reasons ({version.outcomes.length})</summary>
      {version.outcomes.length ? <div className="overflow-x-auto"><table aria-label={`${call.call_id} V${version.version_index} item outcomes`} className="mt-2 w-full min-w-[560px] border-collapse text-left">
        <thead><tr className="border-b border-border"><th scope="col" className="p-2">Outcome</th><th scope="col" className="p-2">Gold key</th><th scope="col" className="p-2">Model index</th><th scope="col" className="p-2">Reason</th></tr></thead>
        <tbody>{version.outcomes.map((outcome, index) => <tr key={index} className="border-b border-border align-top"><th scope="row" className="p-2">{outcome.outcome}</th><td className="p-2 break-all">{unknown(outcome.gold_item_key)}</td><td className="p-2">{unknown(outcome.model_item_index)}</td><td className="p-2">{outcome.reason}</td></tr>)}</tbody>
      </table></div> : <p className="mt-2">No retained item outcomes for this version.</p>}
    </details>)}
    <EvidenceJson label="Exact critic, judge, route and version evidence" value={{ requested_revision_passes: call.requested_revision_passes, terminal_iteration: call.terminal_iteration, selected_iteration: call.selected_iteration, quality_basis: call.quality_basis, route: call.runtime?.route, execution_identity: call.runtime?.execution_identity ?? null, events: call.runtime?.events, versions: call.versions }} />
  </details>;
}

function StandaloneEvidence({ entry }: { entry: ExperimentResultsEntry }) {
  const condition = entry.evidence.standalone_condition;
  if (!condition) return null;
  return <section aria-label="Standalone extraction details" className="mt-4 space-y-3 text-sm">
    <h3 className="font-medium">Standalone extraction details</h3>
    <p>Status: {condition.status} · Source-gold attribution: Descriptive · Evaluator: {unknown(entry.evidence.experiments[0]?.evaluator_version)}</p>
    <p>Distinct exact found: {condition.totals.distinct_exact_found_count} · {list(condition.totals.distinct_exact_found_keys)} · Must-find: {unknown(condition.totals.distinct_exact_must_find_found_count)}</p>
    {condition.reasons.length ? <ul className="list-disc pl-5">{condition.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul> : null}
    {condition.calls.map(call => <PassCallDetail key={call.call_id} condition={condition} call={call} standalone />)}
  </section>;
}

function PassConditionRow({ condition }: { condition: ComparedCondition }) {
  const measured = condition.calls.length > 0 && condition.calls.every(call => call.runtime?.cost_usd != null && call.runtime.duration_ms != null);
  return <tr className="border-b border-border align-top">
    <th scope="row" className="p-2 font-normal break-all">{condition.pass_count ?? "Unknown"} pass · {condition.experiment_id}</th>
    <td className="p-2">{condition.status} · {condition.eligibility}</td>
    <td className="p-2">{condition.totals.distinct_exact_found_count} · {list(condition.totals.distinct_exact_found_keys)}</td>
    <td className="p-2">{unknown(condition.totals.distinct_exact_must_find_found_count)} · {condition.totals.distinct_exact_must_find_keys ? list(condition.totals.distinct_exact_must_find_keys) : "Unknown"}</td>
    <td className="p-2">{condition.totals.summed_call_outcomes.wrong} / {condition.totals.summed_call_outcomes.partial}</td>
    <td className="p-2">{measured ? money(condition.totals.cost_usd) : "Unknown"}</td>
    <td className="p-2">{measured ? milliseconds(condition.totals.latency_ms) : "Unknown"}</td>
  </tr>;
}

type SourceEvaluationRow = MixedComparisonEvaluation["source_evaluations"][number];

function MixedItemOutcomes({ row }: { row: SourceEvaluationRow }) {
  const evaluation: MixedSourceEvaluation = row.evaluation;
  const label = `${row.candidate} ${row.point} ${row.claim_type} item outcomes`;
  return <details className="py-1">
    <summary className="cursor-pointer underline-offset-2 hover:underline">Item outcomes and reasons ({evaluation.outcomes.length})</summary>
    {evaluation.outcomes.length ? <div className="overflow-x-auto"><table aria-label={label} className="mt-2 w-full min-w-[560px] border-collapse text-left">
      <caption className="mb-1 text-left">{label}</caption>
      <thead><tr className="border-b border-border"><th scope="col" className="p-2">Outcome</th><th scope="col" className="p-2">Gold key</th><th scope="col" className="p-2">Model index</th><th scope="col" className="p-2">Reason</th></tr></thead>
      <tbody>{evaluation.outcomes.map((outcome, index) => <tr key={`${outcome.gold_item_key ?? "none"}:${outcome.model_item_index ?? "none"}:${index}`} className="border-b border-border align-top">
        <th scope="row" className="p-2">{outcome.outcome}</th><td className="p-2 break-all">{unknown(outcome.gold_item_key)}</td><td className="p-2">{unknown(outcome.model_item_index)}</td><td className="p-2">{outcome.reason}</td>
      </tr>)}</tbody>
    </table></div> : <p className="mt-2">No item outcomes; {evaluation.status === "gold_not_applicable" ? "gold not applicable" : evaluation.status === "scored" ? "no retained item rows" : `${evaluation.status.replaceAll("_", " ")} (unscored)`}.</p>}
    {evaluation.errors.length ? <p>Evaluation errors: {list(evaluation.errors)}</p> : null}
  </details>;
}

function MixedSourceRow({ row }: { row: SourceEvaluationRow }) {
  return <><tr className="border-b border-border">
    <th scope="row" className="p-2">{row.candidate} / {row.point}</th><td className="p-2">{row.claim_type}</td><td className="p-2">{row.evaluation.status}</td>
    <td className="p-2">{row.evaluation.score ? `${row.evaluation.score.found} / ${row.evaluation.score.partial} / ${row.evaluation.score.missed} / ${row.evaluation.score.wrong}` : "Unscored"}</td>
  </tr><tr className="border-b border-border"><td colSpan={4} className="p-2"><MixedItemOutcomes row={row} /></td></tr></>;
}

function MixedSourceTable({ evaluation }: { evaluation: MixedComparisonEvaluation }) {
  return <div className="overflow-x-auto"><table className="w-full min-w-[700px] border-collapse text-left">
    <caption className="mb-2 text-left font-medium">Scored source outcomes</caption>
    <thead><tr className="border-b border-border"><th scope="col" className="p-2">Candidate / point</th><th scope="col" className="p-2">Claim</th><th scope="col" className="p-2">Status</th><th scope="col" className="p-2">Found / partial / missed / wrong</th></tr></thead>
    <tbody>{evaluation.source_evaluations.map((row, index) => <MixedSourceRow key={`${row.candidate}:${row.point}:${row.claim_type}:${index}`} row={row} />)}</tbody>
  </table></div>;
}

function EvidenceJson({ label, value }: { label: string; value: unknown }) {
  return <details className="mt-2"><summary className="cursor-pointer text-sm underline-offset-2 hover:underline">{label}</summary>
    <pre className="mt-2 max-h-96 overflow-auto border border-border bg-card p-3 text-xs whitespace-pre-wrap break-all">{JSON.stringify(value, null, 2)}</pre>
  </details>;
}

function PassEvidence({ entry }: { entry: ExperimentResultsEntry }) {
  const comparison = entry.evidence.pass_comparison;
  if (!comparison) return null;
  return <section aria-label="Pass comparison" className="mt-4 space-y-3">
    <p className="text-sm">Comparison evaluator: {comparison.comparison_evaluator_version} · Gold: {unknown(comparison.loaded_pack_identity?.pack_id)} / {unknown(comparison.loaded_pack_identity?.pack_fingerprint)}</p>
    <div className="overflow-x-auto"><table className="w-full min-w-[700px] border-collapse text-left text-sm">
      <caption className="mb-2 text-left font-medium">Pass conditions and source-gold outcomes</caption>
      <thead><tr className="border-b border-border"><th scope="col" className="p-2">Condition</th><th scope="col" className="p-2">Status</th><th scope="col" className="p-2">Exact found</th><th scope="col" className="p-2">Must-find</th><th scope="col" className="p-2">Wrong / partial</th><th scope="col" className="p-2">Cost</th><th scope="col" className="p-2">Latency</th></tr></thead>
      <tbody>{comparison.conditions.map(condition => <PassConditionRow key={`${condition.experiment_id}:${condition.pass_count}`} condition={condition} />)}</tbody>
    </table></div>
    {comparison.conditions.flatMap(condition => condition.calls.map(call =>
      <PassCallDetail key={`${condition.experiment_id}:${call.call_id}`} condition={condition} call={call} />
    ))}
  </section>;
}

function MixedCandidateDetail({ label, candidate }: { label: "mixed" | "baseline"; candidate: MixedCandidateEvidence }) {
  return <details className="border-t border-border py-2"><summary className="cursor-pointer font-medium">{label} stages, gates, lineage and final outputs</summary>
      <p className="mt-2 break-all">Original assembly: {unknown(candidate.original_assembly?.fingerprint)} · Setup: {unknown(candidate.setup?.configuration.fingerprint)}</p>
      <ul className="list-disc pl-5">{candidate.stages.map((stage, index) => <li key={`${stage.stage}:${index}`}>{stage.stage}: {stage.status}{stage.status === "completed" ? ` · ${stage.module_id} ${stage.module_version} · ${money(stage.usage.estimated_cost)} · ${milliseconds(stage.usage.latency_ms)}` : ""}</li>)}</ul>
      <ul className="list-disc pl-5">{candidate.gates.map(gate => <li key={gate.id}>{gate.object_type}: {gate.decision} · {list(gate.object_ids)} · {gate.rationale}</li>)}</ul>
      <ul className="list-disc pl-5">{candidate.lineage.map((row, index) => <li key={index} className="break-all">{row.kind}: {"original_item_version_id" in row ? `${row.original_item_version_id} → ${row.copied_claim_id}` : "parent_claim_ids" in row ? `${list(row.parent_claim_ids)} → ${row.copied_claim_id}` : `${list(row.predecessor_claim_ids)} → ${list(row.successor_claim_ids)}`}</li>)}</ul>
      {candidate.final_source_inventory ? <div className="overflow-x-auto"><table className="mt-2 w-full min-w-[600px] border-collapse text-left"><caption className="mb-1 text-left">Final source inventory</caption><thead><tr className="border-b border-border"><th scope="col" className="p-2">Claim</th><th scope="col" className="p-2">Type</th><th scope="col" className="p-2">Original versions</th><th scope="col" className="p-2">Payload</th></tr></thead><tbody>{candidate.final_source_inventory.map(row => <tr key={row.claim_id} className="border-b border-border align-top"><th scope="row" className="p-2 break-all">{row.claim_id}</th><td className="p-2">{row.claim_type}</td><td className="p-2 break-all">{list(row.original_item_version_ids)}</td><td className="p-2 break-all">{JSON.stringify(row.payload)}</td></tr>)}</tbody></table></div> : null}
      {candidate.final_outputs ? <div className="overflow-x-auto"><table className="mt-2 w-full min-w-[600px] border-collapse text-left"><caption className="mb-1 text-left">Final downstream outputs (descriptive)</caption><thead><tr className="border-b border-border"><th scope="col" className="p-2">Output</th><th scope="col" className="p-2">Retained IDs / status</th></tr></thead><tbody>
        <tr className="border-b border-border"><th scope="row" className="p-2">Coverage</th><td className="p-2 break-all">{candidate.final_outputs.coverage.map(row => `${row.id}: ${row.overall}`).join(", ") || "None"}</td></tr>
        <tr className="border-b border-border"><th scope="row" className="p-2">Statuses</th><td className="p-2 break-all">{candidate.final_outputs.statuses.map(row => `${row.gap_id}: ${row.status}`).join(", ") || "None"}</td></tr>
        <tr className="border-b border-border"><th scope="row" className="p-2">Priorities</th><td className="p-2 break-all">{candidate.final_outputs.priorities.map(row => `${row.gap_id}: ${row.band}`).join(", ") || "None"}</td></tr>
        <tr className="border-b border-border"><th scope="row" className="p-2">Residuals</th><td className="p-2 break-all">{candidate.final_outputs.residuals.map(row => `${row.parent_gap_id} → ${row.addressed_gap_id}, ${row.open_residual_gap_id}`).join("; ") || "None"}</td></tr>
        <tr className="border-b border-border"><th scope="row" className="p-2">Proposals</th><td className="p-2 break-all">{candidate.final_outputs.proposals.map(row => `${row.gap_id}: ${row.name}`).join(", ") || "None"}</td></tr>
        <tr className="border-b border-border"><th scope="row" className="p-2">Plan activities</th><td className="p-2 break-all">{list(candidate.final_outputs.plan.activities.map(row => row.id))}</td></tr>
      </tbody></table></div> : null}
      <EvidenceJson label="Exact selected/generated lineage, stage inputs/outputs and final source outcomes" value={candidate} />
    </details>;
}

function MixedEvidence({ entry }: { entry: ExperimentResultsEntry }) {
  const mixed = entry.evidence.mixed_comparison;
  if (!mixed) return null;
  const result = mixed.result?.evidence;
  return <section aria-label="Mixed comparison" className="mt-4 space-y-3 text-sm">
    <p>Full pipeline: {mixed.status} · Source-gold claim: {entry.attribution.label} · Evaluator: {mixed.header.evaluator_version}</p>
    <p className="break-all">Original source: {mixed.header.source_workspace_id} · Gold: {mixed.header.request.pack_id} / {mixed.header.pack_fingerprint}</p>
    <div className="overflow-x-auto"><table className="w-full min-w-[700px] border-collapse text-left"><caption className="mb-2 text-left font-medium">Candidate and baseline attempts</caption><thead><tr className="border-b border-border"><th scope="col" className="p-2">Candidate</th><th scope="col" className="p-2">Attempt</th><th scope="col" className="p-2">Pipeline</th><th scope="col" className="p-2">Final source</th><th scope="col" className="p-2">Stages / gates</th></tr></thead><tbody>
      {(["mixed", "baseline"] as const).map(label => { const candidate = result?.candidates[label]; return <tr key={label} className="border-b border-border align-top"><th scope="row" className="p-2">{label}</th><td className="p-2 break-all">{unknown(mixed.attempts[label]?.id ?? candidate?.attempt_id)}</td><td className="p-2">{candidate?.status ?? "Unknown"}</td><td className="p-2">{candidate?.final_source_inventory ? `${candidate.final_source_inventory.length} retained items` : "Unknown"}</td><td className="p-2">{candidate ? `${candidate.stages.length} stages · ${candidate.gates.length} gates` : "Unknown"}</td></tr>; })}
    </tbody></table></div>
    {result?.evaluation ? <><MixedSourceTable evaluation={result.evaluation} />
      <div className="overflow-x-auto"><table className="w-full min-w-[600px] border-collapse text-left"><caption className="mb-2 text-left font-medium">Scored and unscored dimensions</caption><thead><tr className="border-b border-border"><th scope="col" className="p-2">Dimension</th><th scope="col" className="p-2">Status</th><th scope="col" className="p-2">Basis</th></tr></thead><tbody>{result.evaluation.applicability.map(row => <tr key={row.dimension} className="border-b border-border"><th scope="row" className="p-2">{row.dimension}</th><td className="p-2">{row.status}</td><td className="p-2">{row.status === "unscored" ? row.reason : list(row.reference_keys)}</td></tr>)}</tbody></table></div>
      <ul aria-label="Changes and regressions" className="list-disc pl-5">{result.evaluation.changes.map((row, index) => <li key={index}>{row.dimension} · {row.kind} · {row.severity}: {row.message} ({list(row.item_ids)})</li>)}</ul></> : <p>Source evaluation: Unknown</p>}
    {(["mixed", "baseline"] as const).map(label => {
      const candidate = result?.candidates[label];
      return candidate ? <MixedCandidateDetail key={label} label={label} candidate={candidate} /> : null;
    })}
  </section>;
}

function Entry({ entry, report }: { entry: ExperimentResultsEntry; report: ExperimentResultsReport }) {
  const series = report.repeat_series.filter(row => row.member_ids.includes(entry.id));
  return <article id={`entry-${encodeURIComponent(entry.id)}`} className="border-t border-border py-5 scroll-mt-8">
    <h2 className="text-base font-semibold break-all">{entry.kind.replaceAll("_", " ")} · {entry.id}</h2>
    <p className="mt-1 text-sm">{entry.attribution.label} · {entry.matched ? "matched" : "descriptive / unmatched"} · scope: source-gold only · {entry.created_at || "Time unknown"}</p>
    <p className="text-sm">Experiment IDs: {list(entry.experiment_ids)} · Call IDs: {list(entry.call_ids)}</p>
    {entry.attribution.reasons.length ? <ul aria-label="Attribution reasons" className="mt-2 list-disc pl-5 text-sm">{entry.attribution.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul> : null}
    {entry.mismatch_reasons.length ? <ul aria-label="Mismatch reasons" className="mt-2 list-disc pl-5 text-sm">{entry.mismatch_reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul> : null}
    {series.map((row, index) => <div key={index} className="mt-2 text-sm"><p>Repeat series: {row.rationale}</p><p>Retained members: {row.member_ids.map((id, memberIndex) => <span key={id}>{memberIndex ? ", " : ""}<a className="underline break-all" href={`#entry-${encodeURIComponent(id)}`}>{id}</a></span>)}</p></div>)}
    <p className="mt-2 text-sm break-all">Original identities: {entry.evidence.experiments.map(row => `${row.id}: document ${row.source_fingerprint}, baseline ${row.baseline_fingerprint}, gold ${row.pack_id} / ${row.pack_fingerprint}, evaluator ${row.evaluator_version}, status ${row.status}`).join("; ") || "Unknown"}</p>
    <PassEvidence entry={entry} /><MixedEvidence entry={entry} /><StandaloneEvidence entry={entry} />
    <EvidenceJson label="Complete retained inputs, outputs, evaluations and raw comparison" value={entry.evidence} />
  </article>;
}

/** Fetch an authorized source report and render its evidence without running experiments. */
export function ExperimentResults({ workspaceId }: { workspaceId: string }) {
  const [state, setState] = useState<{ workspaceId: string; report?: ExperimentResultsReport; error?: string }>({ workspaceId });
  useEffect(() => {
    if (!workspaceId) return;
    const controller = new AbortController();
    const url = `/api/accuracy/experiments/results?source_workspace_id=${encodeURIComponent(workspaceId)}&format=json`;
    fetch(url, { signal: controller.signal, cache: "no-store" }).then(async response => {
      if (!response.ok) { const body = await response.json().catch(() => null); throw new Error(body?.error ?? `Results request failed (${response.status})`); }
      return response.json() as Promise<ExperimentResultsReport>;
    }).then(report => { if (!controller.signal.aborted) setState({ workspaceId, report }); })
      .catch(error => { if (!controller.signal.aborted) setState({ workspaceId, error: error instanceof Error ? error.message : "Could not load experiment results" }); });
    return () => controller.abort();
  }, [workspaceId]);
  if (!workspaceId) return <p role="status" className="text-sm">Enter a source workspace ID to view experiments.</p>;
  if (state.workspaceId !== workspaceId || (!state.report && !state.error)) return <p role="status" className="text-sm">Loading experiment results…</p>;
  if (state.error) return <p role="alert" className="border border-destructive p-3 text-sm">{state.error}</p>;
  const report = state.report!;
  if (report.source_workspace_id !== workspaceId) return <p role="alert" className="border border-destructive p-3 text-sm">Results source workspace does not match the selected workspace.</p>;
  const base = `/api/accuracy/experiments/results?source_workspace_id=${encodeURIComponent(workspaceId)}`;
  return <section aria-label="Experiment results" className="space-y-4">
    <div className="flex flex-wrap gap-4 text-sm"><a className="underline" href={`${base}&format=json`} download={`experiments-${workspaceId}.json`}>Download full JSON</a><a className="underline" href={`${base}&format=jsonl`} download={`experiments-${workspaceId}.jsonl`}>Download full JSONL</a></div>
    <p className="text-sm text-muted-foreground">Attribution covers curated source-gold outcomes. Full-pipeline improvement remains unscored where downstream labels are absent. A single observed gain does not establish consistent improvement.</p>
    {report.entries.length ? report.entries.map(entry => <Entry key={entry.id} entry={entry} report={report} />) : <p role="status" className="text-sm">No retained experiments for this source workspace.</p>}
  </section>;
}
