/** Resolve retained selected/terminal omission evidence without inventing a merged assessment. */
import { z } from "zod";
import type { SnapshotCompletenessAssessment, SuspectedOmission } from "../modules/completeness-audit/snapshot-inspector";

const text = z.string().min(1);
const omission = z.object({ issue_id: text, item_kind: z.enum(["gap", "tactic"]), summary: text,
  source_ref: z.object({ source_file_id: text, block_id: text }), evidence_quote: text,
  basis: z.enum(["explicit", "inferred"]), importance: z.enum(["important", "advisory"]), reason: text, suggested_action: text });
const completeness: z.ZodType<SnapshotCompletenessAssessment> = z.object({
  risk_level: z.enum(["not_applicable", "none_detected", "advisory", "important", "check_failed"]),
  checked_block_ids: z.array(text), unchecked_block_ids: z.array(text), suspected_omissions: z.array(omission),
  prior_issue_resolutions: z.array(z.object({ issue_id: text, outcome: z.enum(["unresolved", "partly_resolved", "resolved", "invalid"]),
    reason: text, matched_item_ref: text.optional() })),
});
const iteration = z.number().int().nonnegative();
const critique = z.object({ event_type: z.literal("critique"), iteration, score: z.number().min(0).max(1).nullable(), completeness });
const snapshot = z.object({ event_type: z.literal("snapshot"), iteration, output: z.unknown().refine(value => value !== undefined) });
const judgment = z.strictObject({ event_type: z.literal("judgment"), selected_iteration: iteration, reason: z.string().trim().min(1),
  latency_ms: z.number().finite().nonnegative(), cost_usd: z.number().finite().nonnegative(),
  token_usage: z.strictObject({ prompt_tokens: iteration, completion_tokens: iteration, total_tokens: iteration }) });
type RetainedAssessmentEvent = { event_type: string; iteration: number | null; payload: unknown };

export type EffectiveAssessment = {
  lineage: "selected" | "legacy_terminal" | "invalid";
  selected_iteration: number | null;
  terminal_iteration: number | null;
  selected_completeness: SnapshotCompletenessAssessment | null;
  terminal_completeness: SnapshotCompletenessAssessment | null;
  findings: SuspectedOmission[];
  ambiguous_issue_ids: string[];
  successful_coverage: boolean;
};

/** Compare actionable evidence; even a severity downgrade makes an ID ambiguous. */
function findingKey(issue: SuspectedOmission): string {
  return JSON.stringify([issue.item_kind, issue.summary, issue.source_ref.source_file_id, issue.source_ref.block_id,
    issue.evidence_quote, issue.basis, issue.importance]);
}
function covered(assessment: SnapshotCompletenessAssessment | null): boolean {
  return !!assessment && !["check_failed", "not_applicable"].includes(assessment.risk_level)
    && assessment.checked_block_ids.length > 0 && assessment.unchecked_block_ids.length === 0;
}

/** Missing historical judgment uses terminal evidence; a present invalid reference never does. */
export function resolveEffectiveAssessment(records: readonly RetainedAssessmentEvent[]): EffectiveAssessment {
  const payload = (row: RetainedAssessmentEvent): Record<string, unknown> => row.payload && typeof row.payload === "object" && !Array.isArray(row.payload)
    ? row.payload as Record<string, unknown> : {};
  const corrupt = records.some(row => {
    const event = payload(row);
    return event.event_type !== row.event_type || (row.event_type !== "judgment" && event.iteration !== row.iteration);
  });
  const critiqueRows = records.filter(row => row.event_type === "critique").map(row => {
    const event = payload(row);
    // Historical completeness-less observations remain explicitly unassessed.
    return "completeness" in event ? event : { ...event, completeness: { risk_level: "not_applicable",
      checked_block_ids: [], unchecked_block_ids: [], suspected_omissions: [], prior_issue_resolutions: [] } };
  });
  const assessments = critiqueRows.flatMap(event => {
    const parsed = critique.safeParse(event);
    return parsed.success ? [parsed.data] : [];
  });
  const snapshots = records.filter(row => row.event_type === "snapshot").map(payload).flatMap(event => {
    const parsed = snapshot.safeParse(event);
    return parsed.success ? [parsed.data] : [];
  });
  const produced = records.filter(row => ["snapshot", "critique"].includes(row.event_type)
    && row.iteration !== null && Number.isInteger(row.iteration) && row.iteration >= 0).map(row => row.iteration!);
  const terminal_iteration = produced.length ? Math.max(...produced) : null;
  const terminal = assessments.filter(event => event.iteration === terminal_iteration);
  const terminal_completeness = terminal.length === 1 ? terminal[0].completeness : null;
  const judgments = records.filter(row => row.event_type === "judgment").map(payload);
  const parsed = judgments.length === 1 ? judgment.safeParse(judgments[0]) : null;
  const selected_iteration = parsed?.success ? parsed.data.selected_iteration : null;
  const selected = assessments.filter(event => event.iteration === selected_iteration);
  const valid = !corrupt && !!parsed?.success && selected.length === 1
    && snapshots.filter(event => event.iteration === selected_iteration).length === 1
    && terminal.length === 1 && snapshots.filter(event => event.iteration === terminal_iteration).length === 1
    && assessments.length === critiqueRows.length;
  const lineage = !judgments.length && !corrupt && assessments.length === critiqueRows.length ? "legacy_terminal" : valid ? "selected" : "invalid";
  const selected_completeness = valid ? selected[0].completeness : null;
  // Each assessment already contains its locally unresolved findings. Resolutions in another
  // version describe different content and cannot close these findings.
  const active = lineage === "legacy_terminal" ? [terminal_completeness]
    : valid ? [selected_completeness, terminal_completeness] : assessments.map(event => event.completeness);
  const unique = new Map<string, SuspectedOmission>();
  const keysById = new Map<string, Set<string>>();
  for (const assessment of active) for (const issue of assessment?.suspected_omissions ?? []) {
    const key = findingKey(issue);
    unique.set(JSON.stringify([issue.issue_id, key]), issue);
    const keys = keysById.get(issue.issue_id) ?? new Set<string>();
    keys.add(key); keysById.set(issue.issue_id, keys);
  }
  const ambiguous_issue_ids = [...keysById].filter(([, keys]) => keys.size > 1).map(([id]) => id);
  return { lineage, selected_iteration, terminal_iteration, selected_completeness, terminal_completeness,
    findings: [...unique.values()], ambiguous_issue_ids,
    successful_coverage: assessments.length === critiqueRows.length && ambiguous_issue_ids.length === 0
      && (lineage === "legacy_terminal" ? terminal.length === 1 && terminal[0].score !== null && covered(terminal_completeness)
        : valid && selected[0].score !== null && terminal[0].score !== null
          && covered(selected_completeness) && covered(terminal_completeness)) };
}
