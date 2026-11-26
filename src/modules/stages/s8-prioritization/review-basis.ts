import { enteredAssetDetails } from "@/lib/iegp/asset";
import { suppliedJudgementRecords } from "@/lib/iegp/judgement-references";
import { prioritizationContextFromState } from "@/lib/iegp/planning-context";
import type { IegpState } from "@/lib/iegp/types";
import { evidenceHash } from "@/modules/kernel/decision-replay";
import type { AxesConfig } from "./axes";

type MatrixContext = { x_axis?: string; y_axis?: string; setting?: string; displayed_axes?: unknown; context?: Record<string, unknown> };

/** Bind the subject, supplied priority facts and meaning of the reviewed quadrant. */
export function priorityReviewHash(state: IegpState, axes: AxesConfig, gapId: string, matrix: MatrixContext): string | null {
  const gap = state.gaps.find(row => row.id === gapId);
  if (!gap || !matrix.x_axis || !matrix.y_axis || matrix.x_axis === matrix.y_axis) return null;
  const pair = [matrix.x_axis, matrix.y_axis].map(id => axes.axes.find(axis => axis.id === id));
  if (pair.some(axis => !axis)) return null;
  if (matrix.displayed_axes !== undefined && evidenceHash(matrix.displayed_axes) !== evidenceHash(pair)) return null;
  return evidenceHash({
    version: 1, subject: gapId, domain: gap.domain, objective: gap.objective_id, settings: gap.settings,
    context_version: gap.priority_context_version ?? null,
    asset: enteredAssetDetails(state.asset), context: { ...prioritizationContextFromState(state), ...matrix.context },
    references: suppliedJudgementRecords(state, [gapId]), setting: matrix.setting ?? null,
    axes: axes.axes, pair: [matrix.x_axis, matrix.y_axis],
  });
}

/** Replay facts are persisted JSON. Old or incomplete records cannot establish a match. */
export function frozenPriorityReviewHash(snapshot: Record<string, unknown> | null | undefined, subject: string): string | null {
  if (!snapshot?.facts || !snapshot.input) return null;
  const { state, axesConfig } = snapshot.facts as { state: IegpState; axesConfig: AxesConfig };
  const input = snapshot.input as MatrixContext;
  try {
    return priorityReviewHash(state, axesConfig, subject, {
      ...input, x_axis: input.x_axis ?? axesConfig.x_axis, y_axis: input.y_axis ?? axesConfig.y_axis,
    });
  } catch {
    return null;
  }
}

export function priorityReviewExclusion(reviewHash: string | null | undefined, replay: Record<string, unknown> | null | undefined, subject: string) {
  if (!replay) return "No frozen originating stage input is available.";
  if (!reviewHash) return "Review evidence is missing. Refresh the matrix and confirm the priority with the current axes selected.";
  if (reviewHash !== frozenPriorityReviewHash(replay, subject)) {
    return "The reviewed priority context or matrix axes differ from the originating suggestion. Generate and review a suggestion on the same inputs.";
  }
  return null;
}
