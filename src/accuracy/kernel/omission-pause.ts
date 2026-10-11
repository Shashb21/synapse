/** Pause downstream accuracy work until important source omissions are resolved. */
import type { CallKind } from "./contracts";
import { currentOmissionReviewState, type OmissionReviewItem } from "../store/omission-review-store";

/** Every pipeline slot explicitly declares whether source omissions pause it. */
export const OMISSION_PAUSE_POLICY = {
  upload: false,
  parse: false,
  need_extract: false,
  inventory_extract: false,
  completeness_audit: false,
  merge_dedupe: true,
  pair_generate: true,
  coverage_decide: true,
  coverage_critic: true,
  validation_gate: true,
  status_derive: true,
  partial_split: true,
  prioritize: true,
  ideate: true,
  gantt_project: true,
} satisfies Record<CallKind, boolean>;

/** A recoverable conflict carrying only the requested workspace's current blockers. */
export class AccuracyPausedError extends Error {
  constructor(public readonly blockers: OmissionReviewItem[], public readonly invalid_lineage_run_ids: string[] = []) {
    super(invalid_lineage_run_ids.length ? "Accuracy work is paused: selected extraction lineage is invalid; rerun extraction before continuing."
      : "Accuracy work is paused: resolve important source omissions before continuing.");
    this.name = "AccuracyPausedError";
  }
}

/**
 * Check the current omission decisions before a downstream execution or direct write.
 * @param workspace_id - Trusted workspace scope, checked by the caller.
 * @param call_kind - Pipeline operation to apply the exhaustive policy to.
 * @throws AccuracyPausedError when important explicit findings or invalid current selected lineage remain.
 */
export async function assertAccuracyCanProgress(workspace_id: string, call_kind: CallKind): Promise<void> {
  if (!OMISSION_PAUSE_POLICY[call_kind]) return;
  const state = await currentOmissionReviewState(workspace_id);
  const blockers = state.items.filter(item => item.blocking);
  if (blockers.length || state.invalid_lineage_run_ids.length) throw new AccuracyPausedError(blockers, state.invalid_lineage_run_ids);
}
