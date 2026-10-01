/** Current extraction findings and their append-only contributor decision history. */
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { ACTOR_FUNCTIONS } from "@/lib/iegp/enums";
import type { AgentCritiqueEvent } from "@/accuracy/kernel/agent-events";
import { newId } from "@/modules/kernel/ids";
import { isActiveLedgerClaim } from "./claim-store";
import { claimToMergeCandidate } from "@/accuracy/modules/merge-dedupe/module";
import { identityKeys, normalizeStatement, packsMayMerge, sharedBlockIds, statementJaccard, tacticStatusesConflict, type MergeCandidate } from "@/accuracy/modules/merge-dedupe/engine";
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
type Executor = Pick<ReturnType<typeof accuracyDb>, "select" | "insert" | "update" | "execute">;
type AppliedRun = typeof t.accuracyModuleRuns.$inferSelect & { source_file_id: string; call_kind: OmissionReviewItem["call_kind"] };

/** Human importance decisions override the model default until a closing action. */
function isBlocking(issue: SuspectedOmission, action: OmissionAction | null): boolean {
  if (action && action.action !== "reclassify") return false;
  if (action?.action === "reclassify") return action.new_importance === "important";
  return issue.basis === "explicit" && issue.importance === "important";
}

/** Find successfully applied runs whose persisted identity agrees with their batch. */
async function appliedRuns(workspace_id: string, d: Executor = accuracyDb()): Promise<AppliedRun[]> {
  await ensureAccuracySchema();
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

/** Invalid requests, missing scoped records, and decision conflicts carry API status. */
export class OmissionActionError extends Error {
  constructor(public readonly status: 400 | 404 | 409, message: string) {
    super(message);
    this.name = "OmissionActionError";
  }
}

const requiredText = z.string().trim().min(1);
const actionBase = {
  workspace_id: requiredText, run_id: requiredText, issue_id: requiredText,
  reason: requiredText, idempotency_key: requiredText,
  actor: z.object({ name: requiredText, function: z.enum(ACTOR_FUNCTIONS) }),
};
/** Validate action-specific fields at both the HTTP and direct store boundaries. */
export const omissionActionInputSchema = z.discriminatedUnion("action", [
  z.object({ ...actionBase, action: z.literal("add"), statement: requiredText.optional(), confirmed_distinct: z.boolean().optional() }),
  z.object({ ...actionBase, action: z.literal("link_existing"), claim_id: requiredText }),
  z.object({ ...actionBase, action: z.literal("dismiss") }),
  z.object({ ...actionBase, action: z.literal("reclassify"), new_importance: z.enum(["important", "advisory"]) }),
]);
export type OmissionActionInput = z.infer<typeof omissionActionInputSchema>;

/** Decide whether a prior action closed the issue, independently of blocker severity. */
function isClosed(action: OmissionAction | undefined): boolean {
  return !!action && (action.action !== "reclassify" || action.new_importance === "advisory");
}

/** Compare using the merge engine's pack, identity, and lexical rules. */
function matchCandidate(finding: MergeCandidate, existing: MergeCandidate): "equivalent" | "ambiguous" | null {
  if (finding.claim_type !== existing.claim_type || !packsMayMerge(finding, existing)) return null;
  const ids = new Set(identityKeys(existing));
  const exact = normalizeStatement(finding.statement);
  if (identityKeys(finding).some((id) => ids.has(id)) || (exact && exact === normalizeStatement(existing.statement))) return "equivalent";
  // Block IDs alone are insufficient if two source files happen to reuse a block ID.
  const scopedExisting = { ...existing, provenance: existing.provenance.filter((span) => span.source_file_id === finding.source_file_id) };
  if (!sharedBlockIds(finding, scopedExisting).length) return null;
  const similarity = statementJaccard(finding.statement, existing.statement);
  if (similarity >= 0.9) return "equivalent";
  return similarity >= 0.5 ? "ambiguous" : null;
}

/**
 * Apply one contributor decision with claim mutation and immutable audit in one transaction.
 *
 * @param args - Scoped finding identity, action-specific input, reason, and trusted actor.
 * @returns Recorded decision; an identical idempotent retry returns the original decision.
 * @throws OmissionActionError for invalid input, missing scoped records, or conflicts.
 */
export async function applyOmissionAction(args: OmissionActionInput): Promise<OmissionAction> {
  const parsed = omissionActionInputSchema.safeParse(args);
  if (!parsed.success) throw new OmissionActionError(400, parsed.error.issues.map((issue) => issue.message).join("; "));
  const input = parsed.data;
  const fingerprint = JSON.stringify({ workspace_id: input.workspace_id, run_id: input.run_id, issue_id: input.issue_id,
    action: input.action, reason: input.reason, actor: input.actor,
    claim_id: input.action === "link_existing" ? input.claim_id : null,
    statement: input.action === "add" ? input.statement ?? null : null,
    confirmed_distinct: input.action === "add" ? input.confirmed_distinct ?? false : false,
    new_importance: input.action === "reclassify" ? input.new_importance : null });
  await ensureAccuracySchema();
  return accuracyDb().transaction(async (tx) => {
    // Serialize this workspace's omission decisions, including shared claim provenance and request keys.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`omission:${input.workspace_id}`}, 0))`);
    const parents = await tx.select().from(t.accuracyModuleRuns).where(and(
      eq(t.accuracyModuleRuns.workspace_id, input.workspace_id), eq(t.accuracyModuleRuns.id, input.run_id))).for("update");
    if (!parents.length) throw new OmissionActionError(404, "Unknown run in workspace.");
    const previousRequests = await tx.select().from(t.accuracyOmissionActions).where(and(
      eq(t.accuracyOmissionActions.workspace_id, input.workspace_id), eq(t.accuracyOmissionActions.idempotency_key, input.idempotency_key)));
    if (previousRequests.length) {
      if (previousRequests[0].request_fingerprint !== fingerprint) throw new OmissionActionError(409, "Idempotency key was already used for a different decision.");
      return previousRequests[0] as OmissionAction;
    }
    const runs = await appliedRuns(input.workspace_id, tx);
    const run = runs.find((row) => row.id === input.run_id);
    if (!run) throw new OmissionActionError(404, "Run has no applied extraction findings.");
    if (!currentRuns(runs).some((row) => row.id === input.run_id)) throw new OmissionActionError(409, "Run was superseded; review its current extraction instead.");
    const critiques = await tx.select().from(t.accuracyAgentEvents).where(and(
      eq(t.accuracyAgentEvents.workspace_id, input.workspace_id), eq(t.accuracyAgentEvents.run_id, input.run_id),
      eq(t.accuracyAgentEvents.event_type, "critique"))).orderBy(desc(t.accuracyAgentEvents.iteration)).limit(1);
    const critique = critiques[0]?.payload as AgentCritiqueEvent | undefined;
    const issues = critique?.completeness?.suspected_omissions.filter((issue) => issue.issue_id === input.issue_id
      && issue.source_ref.source_file_id === run.source_file_id) ?? [];
    if (issues.length !== 1) throw new OmissionActionError(404, "Unknown or ambiguous finding in run.");
    const issue = issues[0];
    const history = await tx.select().from(t.accuracyOmissionActions).where(and(
      eq(t.accuracyOmissionActions.workspace_id, input.workspace_id), eq(t.accuracyOmissionActions.run_id, input.run_id),
      eq(t.accuracyOmissionActions.issue_id, input.issue_id))).orderBy(desc(t.accuracyOmissionActions.created_at), desc(t.accuracyOmissionActions.id));
    if (isClosed(history[0] as OmissionAction | undefined)) throw new OmissionActionError(409, "Finding is already resolved.");
    const sources = await tx.select().from(t.accuracySourceFiles).where(and(
      eq(t.accuracySourceFiles.workspace_id, input.workspace_id), eq(t.accuracySourceFiles.id, run.source_file_id)));
    const blocks = await tx.select().from(t.accuracyParseBlocks).where(and(
      eq(t.accuracyParseBlocks.workspace_id, input.workspace_id), eq(t.accuracyParseBlocks.source_file_id, run.source_file_id),
      eq(t.accuracyParseBlocks.id, issue.source_ref.block_id)));
    if (!sources.length || !blocks.length || !issue.evidence_quote.trim() || !blocks[0].text.includes(issue.evidence_quote)) {
      throw new OmissionActionError(409, "Finding source block or verbatim evidence quote is invalid.");
    }
    const span = { ...issue.source_ref, quote: issue.evidence_quote };
    // Preserve append order even when requests share a millisecond or a prior clock ran ahead.
    const previousTime = Date.parse(history[0]?.created_at ?? "");
    const now = new Date(Math.max(Date.now(), Number.isFinite(previousTime) ? previousTime + 1 : 0)).toISOString();
    const actionId = newId("omission");
    let claim_id: string | null = null;
    if (input.action === "add" || input.action === "link_existing") {
      const sourceRows = await tx.select().from(t.accuracySourceFiles).where(eq(t.accuracySourceFiles.workspace_id, input.workspace_id));
      const packBySource = new Map(sourceRows.map((source) => [source.id, source.reference_pack_id]));
      const rows = await tx.select().from(t.accuracyClaims).where(eq(t.accuracyClaims.workspace_id, input.workspace_id)).for("update");
      const active = rows.filter(isActiveLedgerClaim).filter((row) => row.claim_type === issue.item_kind);
      const candidate: MergeCandidate = { id: actionId, claim_type: issue.item_kind, statement: issue.summary,
        validated: false, status: "draft", source_file_id: run.source_file_id, reference_pack_id: sources[0].reference_pack_id,
        external_id: null, tactic_status: null, provenance: [span] };
      if (input.action === "add") {
        const proposed = { ...candidate, statement: input.statement ?? issue.summary };
        for (const row of active) {
          const existing = claimToMergeCandidate(row, packBySource);
          const matches = [matchCandidate(candidate, existing), matchCandidate(proposed, existing)];
          const match = matches.includes("equivalent") ? "equivalent" : matches.find((value) => value === "ambiguous");
          if (!match) continue;
          if (tacticStatusesConflict(candidate, existing)) throw new OmissionActionError(409, "Equivalent tactic has conflicting lifecycle; review its status explicitly.");
          if (match === "equivalent") throw new OmissionActionError(409, `Equivalent claim ${row.id} already exists; link it instead.`);
          if (!input.confirmed_distinct) throw new OmissionActionError(409, `Ambiguous claim ${row.id}; confirm this is a distinct item before adding.`);
        }
        claim_id = newId(issue.item_kind === "gap" ? "gap" : "tac");
        await tx.insert(t.accuracyClaims).values({ id: claim_id, workspace_id: input.workspace_id, claim_type: issue.item_kind,
          statement: proposed.statement, status: "draft", validated: false, source_file_id: run.source_file_id,
          metadata: { provenance: [span], reference_pack_id: sources[0].reference_pack_id, origin: "contributor",
            omission_action_id: actionId, contributor: { name: input.actor.name, function: input.actor.function, reason: input.reason } },
          created_at: now, updated_at: now });
      } else {
        const target = rows.find((row) => row.id === input.claim_id);
        if (!target) throw new OmissionActionError(404, "Unknown claim in workspace.");
        if (!isActiveLedgerClaim(target) || target.claim_type !== issue.item_kind) throw new OmissionActionError(409, "Linked claim must be active and have the same item kind.");
        const existing = claimToMergeCandidate(target, packBySource);
        if (!packsMayMerge(candidate, existing)) throw new OmissionActionError(409, "Linked claim belongs to an incompatible reference pack.");
        if (tacticStatusesConflict(candidate, existing)) throw new OmissionActionError(409, "Linked tactic has conflicting lifecycle.");
        claim_id = target.id;
        if (!existing.provenance.some((entry) => entry.source_file_id === span.source_file_id && entry.block_id === span.block_id && entry.quote === span.quote)) {
          await tx.update(t.accuracyClaims).set({ metadata: { ...(target.metadata as Record<string, unknown>),
            provenance: [...existing.provenance, span] }, updated_at: now }).where(and(
            eq(t.accuracyClaims.workspace_id, input.workspace_id), eq(t.accuracyClaims.id, target.id)));
        }
      }
    }
    const action: OmissionAction = { id: actionId, workspace_id: input.workspace_id, source_file_id: run.source_file_id,
      run_id: input.run_id, issue_id: input.issue_id, action: input.action, claim_id,
      contributor_statement: input.action === "add" ? input.statement ?? null : null,
      new_importance: input.action === "reclassify" ? input.new_importance : null,
      reason: input.reason, actor_name: input.actor.name, actor_function: input.actor.function, created_at: now,
      idempotency_key: input.idempotency_key, request_fingerprint: fingerprint };
    await tx.insert(t.accuracyOmissionActions).values(action);
    return action;
  });
}
