/** Reasoned contributor revisions with atomic heads and durable provider recovery. */
import { and, eq } from "drizzle-orm";
import { AssemblyError, checkAssembly, type Assembly } from "@/accuracy/domain/assembly";
import { assemblyRevisionChangeSchema, type AssemblyRevision, type AssemblyRevisionAuthor, type AssemblyRevisionChange } from "@/accuracy/domain/assembly-revision";
import { generatedItemFingerprint, type HumanItemOrigin } from "@/accuracy/domain/item-history";
import { assemblyRevisionState } from "@/accuracy/store/assembly-revision-store";
import { assemblyReviewState, type AssemblyReviewState } from "@/accuracy/store/assembly-review-store";
import { createAssembly, readAssembly } from "@/accuracy/store/assembly-store";
import { insertClaim } from "@/accuracy/store/claim-store";
import { accuracyDb, ensureAccuracySchema } from "@/accuracy/store/db";
import * as t from "@/accuracy/store/schema";
import type { ParseBlock } from "@/accuracy/store/quote-validator";
import { newId, nowIso } from "@/modules/kernel/ids";
import { withAssemblyPreparation, withAssemblyWorkspaceLock } from "./assembly-context";
import { evidenceBlockIds, reservedCoverageRunId, runCoverageDecision } from "./assembly-generation";

export type AssemblyRevisionResult = { assembly: Assembly; revision: AssemblyRevision; review_state: AssemblyReviewState };
export type CreateAssemblyRevisionArgs = {
  workspace_id: string; org_id: string; parent_assembly_id: string;
  expected_fingerprint: string; expected_head_id: string;
  author: AssemblyRevisionAuthor; change: AssemblyRevisionChange;
};
export type RetryAssemblyRevisionArgs = {
  workspace_id: string; org_id: string; assembly_id: string;
  expected_fingerprint: string; expected_head_id: string; author: AssemblyRevisionAuthor;
};

function requireAuthor(author: AssemblyRevisionAuthor) {
  if (author?.role !== "contributor" || !author.subject?.trim() || !author.provider?.trim()
    || !author.actor?.name?.trim() || !author.actor?.function?.trim()) {
    throw new AssemblyError("invalid_input", "An authenticated contributor identity is required.");
  }
}

async function requireParent(args: { workspace_id: string; org_id: string; expected_fingerprint: string; expected_head_id: string }, assembly_id: string, retry = false) {
  const [workspace] = await accuracyDb().select().from(t.accuracyWorkspaces).where(and(
    eq(t.accuracyWorkspaces.id, args.workspace_id), eq(t.accuracyWorkspaces.org_id, args.org_id),
  )).limit(1);
  if (!workspace) throw new AssemblyError("not_found", "Workspace not found.");
  const assembly = await readAssembly(args.workspace_id, assembly_id);
  if (!assembly) throw new AssemblyError("not_found", "Assembly not found.");
  const state = await assemblyReviewState(args.workspace_id, assembly_id);
  const revision_state = await assemblyRevisionState(args.workspace_id, assembly_id);
  if (assembly.fingerprint !== args.expected_fingerprint || revision_state.current_head_id !== args.expected_head_id
    || !revision_state.is_current || state.head_status !== "current" || (!retry && !assembly.linking_complete)) {
    throw new AssemblyError("conflict", "Parent assembly or revision head is stale or incomplete.");
  }
  return { assembly, revision_state };
}

/** Save one add, edit, or remove atomically, then link outside the database transaction. */
export async function createAssemblyRevision(args: CreateAssemblyRevisionArgs): Promise<AssemblyRevisionResult> {
  requireAuthor(args.author);
  const parsed = assemblyRevisionChangeSchema.safeParse(args.change);
  if (!parsed.success) throw new AssemblyError("invalid_input", "Invalid reasoned revision content.");
  const change = parsed.data;
  await ensureAccuracySchema();
  const saved = await withAssemblyPreparation(() => withAssemblyWorkspaceLock(args.workspace_id, async () => {
    const { assembly: parent, revision_state } = await requireParent(args, args.parent_assembly_id);
    const predecessor = change.action === "add" ? null : parent.items.find(item => item.id === change.item_version_id);
    if (change.action !== "add" && !predecessor) throw new AssemblyError("not_found", "Selected item version not found in parent assembly.");
    const content = change.action === "remove" ? null : change.content;
    const source_file_id = content?.source_file_id ?? predecessor!.source_file_id;
    if (content && (!parent.source_file_ids.includes(source_file_id)
      || !parent.extraction_runs?.some(run => run.source_file_id === source_file_id))) {
      throw new AssemblyError("invalid_input", "Human content is outside the parent's production extraction scope.");
    }
    if (predecessor && content && (predecessor.claim_type !== content.claim_type || predecessor.source_file_id !== source_file_id)) {
      throw new AssemblyError("invalid_input", "Edits must retain selected item type and source.");
    }
    const id = newId("ahr");
    const created_at = nowIso();
    const successor_version_id = content ? newId("iver") : null;
    const revision: AssemblyRevision = { id, workspace_id: args.workspace_id,
      baseline_assembly_id: revision_state.baseline_assembly_id, parent_assembly_id: parent.id,
      action: change.action, reason: change.reason, author: args.author,
      predecessor_version_id: predecessor?.id ?? null, successor_version_id,
      source_file_id, provenance: content?.payload.provenance ?? predecessor?.payload.provenance as unknown[] ?? [], created_at };
    if (content && successor_version_id) {
      const claim_id = predecessor?.claim_id ?? newId(content.claim_type === "gap" ? "gap" : "tac");
      const payload = { ...content.payload, id: predecessor?.payload.id ?? claim_id };
      const origin: HumanItemOrigin = { kind: "human", revision_id: id, subject: args.author.subject,
        provider: args.author.provider, actor: args.author.actor, action: change.action as "add" | "edit",
        reason: change.reason, parent_assembly_id: parent.id, predecessor_version_id: predecessor?.id ?? null,
        source_file_id, provenance: payload.provenance, created_at };
      const blocks = await accuracyDb().select().from(t.accuracyParseBlocks).where(and(
        eq(t.accuracyParseBlocks.workspace_id, args.workspace_id), eq(t.accuracyParseBlocks.source_file_id, source_file_id),
      ));
      // Validate quotes and payload before any durable history writes; pair linking is a later phase.
      const validation = checkAssembly({ items: [{ id: successor_version_id, claim_id, run_id: null,
        human_origin: origin, snapshot_id: null, iteration: null, item_index: 0, payload, source_file_id, created_at,
        claim_type: content.claim_type, canonical_claim_id: predecessor?.canonical_claim_id ?? claim_id, reason: change.reason }],
        source_file_ids: parent.source_file_ids, blocks: blocks as ParseBlock[], mappings: [], coverage: [], linking_complete: true });
      if (validation.status !== "passed") throw new AssemblyError("invalid_input", "Human payload or source quote is invalid.");
      if (!predecessor) await insertClaim({ id: claim_id, workspace_id: args.workspace_id, claim_type: content.claim_type,
        source_file_id, statement: "statement" in content.payload ? content.payload.statement : content.payload.name,
        metadata: { history_only: true } });
      await accuracyDb().insert(t.accuracyItemVersions).values({ id: successor_version_id, workspace_id: args.workspace_id,
        claim_id, run_id: null, human_origin: origin, snapshot_id: null, iteration: null, item_index: 0,
        origin_key: `human:${id}`, claim_type: content.claim_type, fingerprint: generatedItemFingerprint(content.claim_type, payload),
        payload, source_file_id, created_at });
    }
    const selections = parent.items.flatMap(item => item.id === predecessor?.id
      ? successor_version_id ? [{ item_version_id: successor_version_id, reason: change.reason }] : []
      : [{ item_version_id: item.id, reason: item.reason }]);
    if (change.action === "add") selections.push({ item_version_id: successor_version_id!, reason: change.reason });
    const selectedIds = new Set(selections.map(item => item.item_version_id));
    const retained = parent.coverage.filter(pair => selectedIds.has(pair.gap_version_id) && selectedIds.has(pair.tactic_version_id));
    const mappings = parent.mappings.filter(pair => selectedIds.has(pair.gap_version_id) && selectedIds.has(pair.tactic_version_id));
    const complete = change.action === "remove";
    const initial = await createAssembly({ workspace_id: args.workspace_id, actor: args.author.actor,
      source_file_ids: parent.source_file_ids, selections, mappings, coverage_run_ids: retained.map(pair => pair.run_id),
      extraction_runs: parent.extraction_runs, linking_complete: complete });
    await accuracyDb().insert(t.accuracyAssemblyRevisions).values({ id, workspace_id: args.workspace_id,
      baseline_assembly_id: revision.baseline_assembly_id, parent_assembly_id: parent.id, initial_assembly_id: initial.id, change: revision });
    await accuracyDb().insert(t.accuracyAssemblyRevisionHeads).values({ workspace_id: args.workspace_id,
      baseline_assembly_id: revision.baseline_assembly_id, assembly_id: initial.id, revision_id: id })
      .onConflictDoUpdate({ target: t.accuracyAssemblyRevisionHeads.baseline_assembly_id, set: { assembly_id: initial.id, revision_id: id } });
    if ((await assemblyReviewState(args.workspace_id, initial.id)).head_status !== "current") {
      throw new AssemblyError("conflict", "Revision overlaps an incompatible current extraction head.");
    }
    return { assembly: initial, revision };
  }));
  if (saved.assembly.linking_complete) return { ...saved, review_state: await assemblyReviewState(args.workspace_id, saved.assembly.id) };
  return finishRevision({ ...args, assembly_id: saved.assembly.id,
    expected_fingerprint: saved.assembly.fingerprint, expected_head_id: saved.assembly.id }, saved.revision);
}

/** Retry only missing version-bound pairs for an incomplete current revision. */
export async function retryAssemblyRevision(args: RetryAssemblyRevisionArgs): Promise<AssemblyRevisionResult> {
  requireAuthor(args.author);
  const { revision_state } = await withAssemblyWorkspaceLock(args.workspace_id, () => requireParent(args, args.assembly_id, true));
  if (!revision_state.revision || !revision_state.can_retry) throw new AssemblyError("conflict", "Revision is not retryable.");
  return finishRevision(args, revision_state.revision);
}

async function finishRevision(args: RetryAssemblyRevisionArgs, revision: AssemblyRevision): Promise<AssemblyRevisionResult> {
  const initial = await readAssembly(args.workspace_id, args.assembly_id);
  if (!initial) throw new AssemblyError("not_found", "Revision assembly not found.");
  const coverageIds = initial.coverage.map(pair => pair.run_id);
  const mappings = [...initial.mappings];
  const retainedPairs = new Set(initial.coverage.map(pair => `${pair.gap_version_id}\u0000${pair.tactic_version_id}`));
  let linking_error: string | null = null;
  try {
    await withAssemblyPreparation(async () => {
      for (const gap of initial.items.filter(item => item.claim_type === "gap")) {
        for (const tactic of initial.items.filter(item => item.claim_type === "tactic")) {
          if (retainedPairs.has(`${gap.id}\u0000${tactic.id}`)) continue;
          const result = await runCoverageDecision({ base_run_id: reservedCoverageRunId(revision.id, gap.id, tactic.id),
            input: { workspace_id: args.workspace_id, gap_id: gap.id, tactic_id: tactic.id,
              block_bundle_ids: evidenceBlockIds(gap, tactic), selected_versions: {
                gap_version_id: gap.id, tactic_version_id: tactic.id, gap_payload: gap.payload, tactic_payload: tactic.payload } },
            actor: args.author.actor, org_id: args.org_id, workspace_id: args.workspace_id, evaluation_context: "production" });
          coverageIds.push(result.run_id);
          if (result.output.overall !== "not_relevant") mappings.push({ gap_version_id: gap.id, tactic_version_id: tactic.id });
        }
      }
    });
  } catch (error) {
    // Provider messages may contain sensitive text: persist a stable user-facing recovery message only.
    linking_error = error instanceof AssemblyError && error.code === "conflict"
      ? "A linking attempt is in progress or conflicts. Refresh and retry." : "Automatic linking failed. Retry the saved revision.";
  }
  const assembly = await withAssemblyWorkspaceLock(args.workspace_id, async () => {
    await requireParent(args, initial.id, true); // New extraction or a competing head invalidates in-flight results.
    const assembly = await createAssembly({ workspace_id: args.workspace_id, actor: args.author.actor,
      source_file_ids: initial.source_file_ids, selections: initial.items.map(item => ({ item_version_id: item.id, reason: item.reason })),
      mappings, coverage_run_ids: coverageIds, extraction_runs: initial.extraction_runs, linking_complete: linking_error === null });
    await accuracyDb().insert(t.accuracyAssemblyRevisionAttempts).values({ id: newId("ahra"), workspace_id: args.workspace_id,
      revision_id: revision.id, assembly_id: assembly.id, error: linking_error, created_at: nowIso() });
    await accuracyDb().update(t.accuracyAssemblyRevisionHeads).set({ assembly_id: assembly.id }).where(and(
      eq(t.accuracyAssemblyRevisionHeads.workspace_id, args.workspace_id), eq(t.accuracyAssemblyRevisionHeads.baseline_assembly_id, revision.baseline_assembly_id),
    ));
    return assembly;
  });
  return { assembly, revision, review_state: await assemblyReviewState(args.workspace_id, assembly.id) };
}
