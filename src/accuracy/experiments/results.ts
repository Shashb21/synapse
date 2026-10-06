/** Source-scoped, read-only assembly of retained experiment results. */
import { experimentPackFingerprint } from "@/accuracy/eval/experiment-gold";
import { loadReferenceGold } from "@/accuracy/eval/reference-gold";
import { comparePassExperiments, evaluatePassComparison, PASS_COMPARISON_EVALUATOR_VERSION } from "@/accuracy/eval/pass-comparison";
import { withAccuracyTransaction } from "@/accuracy/store/db";
import { z } from "zod";
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
    const gold = loadReferenceGold(pack_id);
    const gapShape = z.object({
      source_pack_id: z.literal(pack_id), source_filename: z.string().min(1),
      gaps: z.array(z.record(z.string(), z.unknown())),
      must_find_gap_ids: z.array(z.string()).optional(),
      must_find_tactic_identifiers: z.array(z.string()).optional(),
    });
    const tacticShape = z.object({
      source_pack_id: z.literal(pack_id), source_filename: z.string().min(1),
      tactics: z.array(z.record(z.string(), z.unknown())),
      must_find_tactic_numbers: z.array(z.number().finite()).optional(),
      must_find_tactic_identifiers: z.array(z.string()).optional(),
    });
    if (!gapShape.safeParse(gold.gaps).success || !tacticShape.safeParse(gold.tactics).success) return null;
    return fingerprint;
  }
  catch (error) {
    if (error instanceof SyntaxError) return null;
    if (error instanceof Error && error.message.startsWith("Unknown reference pack:")) return null;
    if (error instanceof Error && "code" in error && typeof error.code === "string"
      && ["ENOENT", "ENOTDIR", "EACCES", "EPERM", "EISDIR"].includes(error.code)) return null;
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
    const packIds = new Set([...experiments.map(row => row.pack_id), ...mixed_comparisons.map(row => row.header.request.pack_id)]);
    const loaded_pack_fingerprints = Object.fromEntries([...packIds].map(id => [id, currentPackFingerprint(id)]));
    const pass_comparisons = await Promise.all([...cohorts.values()].map(async rows => {
      const evidence = await loadPassComparisonEvidence(rows);
      const pack_id = rows[0].pack_id;
      if (loaded_pack_fingerprints[pack_id] !== null) return evaluatePassComparison(evidence);
      const comparison = comparePassExperiments(evidence, null);
      comparison.loaded_pack_identity = { pack_id, pack_fingerprint: null, matches_retained: false };
      comparison.matched = false;
      comparison.recommendation = null;
      comparison.mismatch_reasons.push("Current reference gold is unavailable or malformed; source-gold attribution is unavailable.");
      return comparison;
    }));
    const report = buildExperimentResultsReport({ source_workspace_id: args.source_workspace_id,
      experiments, pass_comparisons, mixed_comparisons, loaded_pack_fingerprints });
    report.entries.sort((a, b) => b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id));
    return report;
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
