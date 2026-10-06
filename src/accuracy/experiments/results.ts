/** Source-scoped, read-only assembly of retained experiment results. */
import { experimentPackFingerprint } from "@/accuracy/eval/experiment-gold";
import { loadReferenceGold } from "@/accuracy/eval/reference-gold";
import { evaluatePassComparison, PASS_COMPARISON_EVALUATOR_VERSION } from "@/accuracy/eval/pass-comparison";
import { withAccuracyTransaction } from "@/accuracy/store/db";
import { listExperimentsForSourceWorkspace, type ExperimentRecord } from "./records";
import { listMixedComparisonsForSourceWorkspace } from "./mixed-records";
import { loadPassComparisonEvidence } from "./pass-comparison";
import { buildExperimentResultsReport, type ExperimentResultsReport } from "./results-report";

/** Recognize a retained server-controlled pass condition; malformed rows remain standalone. */
function passCohortId(row: ExperimentRecord): string | null {
  const condition = row.condition;
  if (!condition || typeof condition !== "object" || Array.isArray(condition)) return null;
  const fields = condition as Record<string, unknown>;
  return typeof fields.comparison_id === "string" && fields.comparison_id.length > 0
    && fields.comparison_evaluator_version === PASS_COMPARISON_EVALUATOR_VERSION
    && typeof fields.original_request_fingerprint === "string" && fields.original_request_fingerprint.length > 0
    && [1, 2, 3].includes(fields.critic_revision_passes as number)
    ? fields.comparison_id : null;
}

/** Null only expected missing or malformed reference packs; propagate internal failures. */
function currentPackFingerprint(pack_id: string): string | null {
  try {
    const fingerprint = experimentPackFingerprint(pack_id);
    loadReferenceGold(pack_id);
    return fingerprint;
  }
  catch (error) {
    if (error instanceof SyntaxError || (error instanceof Error && (
      error.message.startsWith("Unknown reference pack:") || ("code" in error && typeof error.code === "string")
    ))) return null;
    throw error;
  }
}

/** Read coherent historical evidence without invoking an experiment runner or changing records. */
export async function readExperimentResults(args: { source_workspace_id: string }): Promise<ExperimentResultsReport> {
  return withAccuracyTransaction(async () => {
    const [experiments, mixed_comparisons] = await Promise.all([
      listExperimentsForSourceWorkspace(args), listMixedComparisonsForSourceWorkspace(args),
    ]);
    const cohorts = new Map<string, ExperimentRecord[]>();
    for (const row of experiments) {
      const id = passCohortId(row);
      if (id) cohorts.set(id, [...(cohorts.get(id) ?? []), row]);
    }
    const pass_comparisons = await Promise.all([...cohorts.values()].map(async rows =>
      evaluatePassComparison(await loadPassComparisonEvidence(rows))));
    const packIds = new Set([...experiments.map(row => row.pack_id), ...mixed_comparisons.map(row => row.header.request.pack_id)]);
    const loaded_pack_fingerprints = Object.fromEntries([...packIds].map(id => [id, currentPackFingerprint(id)]));
    const report = buildExperimentResultsReport({ source_workspace_id: args.source_workspace_id,
      experiments, pass_comparisons, mixed_comparisons, loaded_pack_fingerprints });
    report.entries.sort((a, b) => b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id));
    return report;
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
