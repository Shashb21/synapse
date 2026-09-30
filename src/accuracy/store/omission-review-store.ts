/** Current extraction findings and their append-only contributor decision history. */
import { and, asc, desc, eq } from "drizzle-orm";
import { readAgentProgression } from "@/accuracy/kernel/agent-events";
import type { SnapshotCompletenessAssessment, SuspectedOmission } from "@/accuracy/modules/completeness-audit/snapshot-inspector";
import { accuracyDb, ensureAccuracySchema } from "./db";
import * as t from "./schema";

/** A persisted decision; its request fingerprint protects idempotent retries. */
export type OmissionAction = Omit<typeof t.accuracyOmissionActions.$inferSelect, "action" | "new_importance"> & {
  action: "add" | "link_existing" | "dismiss" | "reclassify";
  new_importance: "important" | "advisory" | null;
};
/** A source finding with the latest contributor decision and effective blocker state. */
export type OmissionReviewItem = {
  workspace_id: string; source_file_id: string; run_id: string;
  call_kind: "need_extract" | "inventory_extract";
  issue: SuspectedOmission; latest_action: OmissionAction | null; blocking: boolean;
};
type AppliedRun = typeof t.accuracyModuleRuns.$inferSelect & { source_file_id: string; call_kind: OmissionReviewItem["call_kind"] };

/** Shared decision rule: inferred findings remain advisory even when reclassified. */
function isBlocking(issue: SuspectedOmission, action: OmissionAction | null): boolean {
  if (action && action.action !== "reclassify") return false;
  return issue.basis === "explicit" && (action?.new_importance ?? issue.importance) === "important";
}

/** Find successfully applied runs whose persisted identity agrees with their batch. */
async function appliedRuns(workspace_id: string): Promise<AppliedRun[]> {
  await ensureAccuracySchema();
  const d = accuracyDb();
  const batches = await d.select().from(t.accuracyExtractionBatches).where(and(
    eq(t.accuracyExtractionBatches.workspace_id, workspace_id), eq(t.accuracyExtractionBatches.drafts_persisted, true)));
  const runs = await d.select().from(t.accuracyModuleRuns).where(and(
    eq(t.accuracyModuleRuns.workspace_id, workspace_id), eq(t.accuracyModuleRuns.status, "ok")))
    .orderBy(desc(t.accuracyModuleRuns.finished_at), desc(t.accuracyModuleRuns.id));
  return runs.flatMap((run): AppliedRun[] => {
    if (!run.finished_at || (run.call_kind !== "need_extract" && run.call_kind !== "inventory_extract")) return [];
    const input = run.input as Record<string, unknown> | null;
    if (!input || input.workspace_id !== workspace_id || typeof input.source_file_id !== "string"
      || (input.call_kind !== undefined && input.call_kind !== run.call_kind)) return [];
    const source_file_id = input.source_file_id;
    if (!batches.some((batch) => batch.source_file_id === source_file_id
      && batch.requested_kinds.includes(run.call_kind) && batch.run_ids.includes(run.id))) return [];
    return [{ ...run, source_file_id, call_kind: run.call_kind }];
  });
}

/** Select the newest successfully applied run separately for each source and kind. */
function currentRuns(runs: AppliedRun[]): AppliedRun[] {
  const seen = new Set<string>();
  return runs.filter((run) => {
    const key = JSON.stringify([run.source_file_id, run.call_kind]);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

/** Return immutable decisions oldest first, scoped to their parent workspace/run.
 * @param args - Workspace/run identity and optional individual issue.
 * @returns All matching persisted decisions, including those of superseded runs.
 */
export async function listOmissionActionHistory(args: {
  workspace_id: string; run_id: string; issue_id?: string;
}): Promise<OmissionAction[]> {
  await ensureAccuracySchema();
  const parent = await accuracyDb().select({ id: t.accuracyModuleRuns.id }).from(t.accuracyModuleRuns)
    .where(and(eq(t.accuracyModuleRuns.id, args.run_id), eq(t.accuracyModuleRuns.workspace_id, args.workspace_id))).limit(1);
  if (!parent.length) return [];
  const rows = await accuracyDb().select().from(t.accuracyOmissionActions).where(and(
    eq(t.accuracyOmissionActions.workspace_id, args.workspace_id), eq(t.accuracyOmissionActions.run_id, args.run_id),
    args.issue_id === undefined ? undefined : eq(t.accuracyOmissionActions.issue_id, args.issue_id)))
    .orderBy(asc(t.accuracyOmissionActions.created_at), asc(t.accuracyOmissionActions.id));
  return rows as OmissionAction[];
}

/** Overlay contributor decisions on the highest critique iteration. */
async function reviewsForRun(run: AppliedRun) {
  const progression = await readAgentProgression({ workspace_id: run.workspace_id, run_id: run.id });
  const critique = progression?.events.filter((record) => record.event.event_type === "critique")
    .sort((a, b) => b.iteration - a.iteration)[0]?.event;
  const completeness: SnapshotCompletenessAssessment | null = critique?.event_type === "critique" ? critique.completeness : null;
  const history = await listOmissionActionHistory({ workspace_id: run.workspace_id, run_id: run.id });
  const items = (completeness?.suspected_omissions ?? []).filter((issue) => issue.source_ref.source_file_id === run.source_file_id)
    .map((issue): OmissionReviewItem => {
      const latest_action = history.filter((action) => action.issue_id === issue.issue_id && action.source_file_id === run.source_file_id).at(-1) ?? null;
      return { workspace_id: run.workspace_id, source_file_id: run.source_file_id, run_id: run.id,
        call_kind: run.call_kind, issue, latest_action, blocking: isBlocking(issue, latest_action) };
    });
  return { items, completeness };
}

/** Read current findings for every source/kind in a workspace.
 * @param workspace_id - Required tenant scope.
 * @returns Both blocking and advisory findings, with decisions applied.
 */
export async function listCurrentOmissionReviews(workspace_id: string): Promise<OmissionReviewItem[]> {
  const result = await Promise.all(currentRuns(await appliedRuns(workspace_id)).map(reviewsForRun));
  return result.flatMap((run) => run.items);
}

/** Read only unresolved important explicit findings that pause downstream work.
 * @param workspace_id - Required tenant scope.
 * @returns Current effective blockers.
 */
export async function listBlockingOmissions(workspace_id: string): Promise<OmissionReviewItem[]> {
  return (await listCurrentOmissionReviews(workspace_id)).filter((item) => item.blocking);
}

/** Read an applied run's historical findings and whether it can still receive decisions.
 * @param args - Required workspace and run identity.
 * @returns Historical review and visible check state, or null for an ineligible run.
 */
export async function getOmissionReviewsForRun(args: { workspace_id: string; run_id: string }): Promise<{
  current: boolean; items: OmissionReviewItem[]; completeness: SnapshotCompletenessAssessment | null;
} | null> {
  const runs = await appliedRuns(args.workspace_id);
  const run = runs.find((candidate) => candidate.id === args.run_id);
  if (!run) return null;
  return { current: currentRuns(runs).some((candidate) => candidate.id === run.id), ...await reviewsForRun(run) };
}
