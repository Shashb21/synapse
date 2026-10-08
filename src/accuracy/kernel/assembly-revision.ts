import { coverageDecisionSchema } from "@/accuracy/modules/coverage-decide/schema";
/** Reasoned contributor revisions with atomic heads and durable provider recovery. */
import { and, eq, inArray } from "drizzle-orm";
import { AssemblyError, checkAssembly, type Assembly } from "@/accuracy/domain/assembly";
import { assemblyRevisionChangeSchema, type AssemblyRevision, type AssemblyRevisionAuthor, type AssemblyRevisionChange } from "@/accuracy/domain/assembly-revision";
import { generatedItemFingerprint, type HumanItemOrigin } from "@/accuracy/domain/item-history";
import { assemblyRevisionState } from "@/accuracy/store/assembly-revision-store";
import { approvedLiveInventory, assemblyReviewState, type AssemblyReviewState } from "@/accuracy/store/assembly-review-store";
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
      baseline_assembly_id: revision_state.baseline_assembly_id, baseline_assembly_ids: revision_state.revision?.baseline_assembly_ids, parent_assembly_id: parent.id,
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
      source_file_ids: parent.source_file_ids, selections, mappings, coverage_run_ids: retained.filter(pair => pair.mode !== "human").map(pair => pair.run_id),
      human_coverage: retained.filter(pair => pair.mode === "human"),
      extraction_runs: parent.extraction_runs, linking_complete: complete });
    await accuracyDb().insert(t.accuracyAssemblyRevisions).values({ id, workspace_id: args.workspace_id,
      baseline_assembly_id: revision.baseline_assembly_id, parent_assembly_id: parent.id, initial_assembly_id: initial.id, change: revision });
    await moveRevisionHeads(args.workspace_id, revision, initial.id);
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
  const coverageIds = initial.coverage.filter(pair => pair.mode !== "human").map(pair => pair.run_id);
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
      mappings, coverage_run_ids: coverageIds, human_coverage: initial.coverage.filter(pair => pair.mode === "human"), extraction_runs: initial.extraction_runs, linking_complete: linking_error === null });
    await accuracyDb().insert(t.accuracyAssemblyRevisionAttempts).values({ id: newId("ahra"), workspace_id: args.workspace_id,
      revision_id: revision.id, assembly_id: assembly.id, error: linking_error, created_at: nowIso() });
    await accuracyDb().update(t.accuracyAssemblyRevisionHeads).set({ assembly_id: assembly.id }).where(and(
      eq(t.accuracyAssemblyRevisionHeads.workspace_id, args.workspace_id), inArray(t.accuracyAssemblyRevisionHeads.baseline_assembly_id, revision.baseline_assembly_ids ?? [revision.baseline_assembly_id]),
    ));
    return assembly;
  });
  return { assembly, revision, review_state: await assemblyReviewState(args.workspace_id, assembly.id) };
}

/** Manual decisions bind the complete current selection, including independent source heads. */
async function manualParent(args: Omit<CreateAssemblyRevisionArgs, "change">) {
  const primary = await requireParent(args, args.parent_assembly_id);
  const live = await approvedLiveInventory(args.workspace_id);
  if (!live) return primary;
  const ids = [...new Set(live.bindings.map(binding => binding.assembly_id))];
  if (!ids.includes(primary.assembly.id)) throw new AssemblyError("conflict", "Manual parent is not an approved inventory head.");
  const parents = await Promise.all(ids.map(async id => (await readAssembly(args.workspace_id, id))!));
  const states = await Promise.all(ids.map(id => assemblyRevisionState(args.workspace_id, id)));
  const selected = new Set(live.selected_items.map(item => item.item_version_id));
  const items = [...new Map(parents.flatMap(parent => parent.items).filter(item => selected.has(item.id)).map(item => [item.id, item])).values()];
  const coverage = [...new Map(parents.flatMap(parent => parent.coverage).filter(pair => selected.has(pair.gap_version_id) && selected.has(pair.tactic_version_id))
    .map(pair => [`${pair.gap_version_id}:${pair.tactic_version_id}`, pair])).values()];
  const assembly: Assembly = { ...primary.assembly, items, coverage,
    source_file_ids: [...new Set(parents.flatMap(parent => parent.source_file_ids))],
    extraction_runs: [...new Map(parents.flatMap(parent => parent.extraction_runs ?? []).map(run => [run.run_id, run])).values()] };
  return { ...primary, assembly, parents: ids,
    baselines: [...new Set(states.flatMap(state => state.revision?.baseline_assembly_ids ?? [state.baseline_assembly_id]))] };
}

async function moveRevisionHeads(workspace_id: string, revision: AssemblyRevision, assembly_id: string) {
  for (const baseline_assembly_id of revision.baseline_assembly_ids ?? [revision.baseline_assembly_id]) {
    await accuracyDb().insert(t.accuracyAssemblyRevisionHeads).values({ workspace_id, baseline_assembly_id, assembly_id, revision_id: revision.id })
      .onConflictDoUpdate({ target: t.accuracyAssemblyRevisionHeads.baseline_assembly_id, set: { assembly_id, revision_id: revision.id } });
  }
}

/** Persist a reasoned version-bound coverage decision without invoking a model. */
export async function createCoverageAssemblyRevision(args: Omit<CreateAssemblyRevisionArgs, "change"> & {
  gap_version_id: string; tactic_version_id: string; overall: string; evidence: string[]; reason: string;
  intent?: "decision" | "rejection";
}): Promise<AssemblyRevisionResult> {
  requireAuthor(args.author);
  if (args.reason.trim().length < 3) throw new AssemblyError("invalid_input", "A reasoned coverage decision is required.");
  return withAssemblyWorkspaceLock(args.workspace_id, async () => {
    const selection = await manualParent(args);
    const { assembly: parent, revision_state } = selection;
    const gap = parent.items.find(item => item.id === args.gap_version_id && item.claim_type === "gap");
    const tactic = parent.items.find(item => item.id === args.tactic_version_id && item.claim_type === "tactic");
    if (!gap || !tactic) throw new AssemblyError("invalid_input", "Coverage endpoints must be selected versions of the parent.");
    const id = newId("ahr");
    const pair = humanCoverage(id, gap, tactic, args.overall, args.evidence, args.reason, args.intent);
    const coverage = [...parent.coverage.filter(row => row.gap_version_id !== gap.id || row.tactic_version_id !== tactic.id), pair];
    const revision: AssemblyRevision = { id, workspace_id: args.workspace_id, baseline_assembly_id: revision_state.baseline_assembly_id,
      parent_assembly_id: parent.id, baseline_assembly_ids: "baselines" in selection ? selection.baselines : undefined,
      parent_assembly_ids: "parents" in selection ? selection.parents : undefined, action: "coverage", reason: args.reason.trim(), author: args.author,
      predecessor_version_id: null, successor_version_id: null, source_file_id: gap.source_file_id,
      provenance: [], coverage: [pair], created_at: nowIso() };
    return saveManualSuccessor(args, parent, revision, parent.items.map(item => ({ item_version_id: item.id, reason: item.reason })), coverage);
  });
}

function humanCoverage(revision_id: string, gap: import("@/accuracy/domain/assembly").ResolvedAssemblyItem,
  tactic: import("@/accuracy/domain/assembly").ResolvedAssemblyItem, overall: string, evidence: string[], rationale: string,
  intent: import("@/accuracy/domain/assembly").AssemblyCoverageIntent = "decision"): import("@/accuracy/domain/assembly").AssemblyCoverage {
  const output = coverageDecisionSchema.parse({ gap_id: gap.id, tactic_id: tactic.id, overall,
    quote_block_ids: evidence, confidence: 1, rationale: rationale.trim() });
  if (output.overall === "pending" && evidence.length) throw new AssemblyError("invalid_input", "Pending coverage does not assert supporting evidence.");
  return { gap_version_id: gap.id, tactic_version_id: tactic.id, run_id: `${revision_id}:${gap.id}:${tactic.id}`,
    mode: "human", human_revision_id: revision_id, intent, output,
    input: { gap_id: gap.id, tactic_id: tactic.id, block_bundle_ids: evidence,
      selected_versions: { gap_version_id: gap.id, tactic_version_id: tactic.id, gap_payload: gap.payload, tactic_payload: tactic.payload } } };
}

async function saveManualSuccessor(args: { workspace_id: string; author: AssemblyRevisionAuthor }, parent: Assembly,
  revision: AssemblyRevision, selections: import("@/accuracy/domain/assembly").AssemblySelection[], coverage: import("@/accuracy/domain/assembly").AssemblyCoverage[]) {
  const chosen = await import("@/accuracy/store/assembly-store").then(owner => owner.resolveAssemblyItems(args.workspace_id, selections));
  const pending = [];
  for (const gap of chosen.filter(item => item.claim_type === "gap")) for (const tactic of chosen.filter(item => item.claim_type === "tactic")) {
    if (!coverage.some(pair => pair.gap_version_id === gap.id && pair.tactic_version_id === tactic.id)) {
      pending.push(humanCoverage(revision.id, gap, tactic, "pending", [], "This selected pair awaits assessment", "unassessed"));
    }
  }
  revision.coverage = [...(revision.coverage ?? []), ...pending];
  coverage = [...coverage, ...pending];
  const mappings = coverage.filter(pair => ["full", "partial", "limited"].includes(coverageDecisionSchema.parse(pair.output).overall))
    .map(pair => ({ gap_version_id: pair.gap_version_id, tactic_version_id: pair.tactic_version_id }));
  const assembly = await createAssembly({ workspace_id: args.workspace_id, actor: args.author.actor,
    source_file_ids: parent.source_file_ids, selections, mappings, extraction_runs: parent.extraction_runs,
    coverage_run_ids: coverage.filter(pair => pair.mode !== "human").map(pair => pair.run_id),
    human_coverage: coverage.filter(pair => pair.mode === "human"), linking_complete: true });
  if (assembly.checks.status !== "passed") throw new AssemblyError("invalid_input", `Successor checks failed: ${assembly.checks.findings.filter(f => f.severity === "blocking").map(f => f.code).join(", ")}`);
  await accuracyDb().insert(t.accuracyAssemblyRevisions).values({ id: revision.id, workspace_id: args.workspace_id,
    baseline_assembly_id: revision.baseline_assembly_id, parent_assembly_id: parent.id, initial_assembly_id: assembly.id, change: revision });
  await moveRevisionHeads(args.workspace_id, revision, assembly.id);
  return { assembly, revision, review_state: await assemblyReviewState(args.workspace_id, assembly.id) };
}

/** One confirmed split saves exactly two human item versions and a successor selection. */
export async function createSplitAssemblyRevision(args: Omit<CreateAssemblyRevisionArgs, "change"> & {
  operation_id: string; parent_claim_id: string; proposal: import("@/accuracy/store/partial-split-store").SplitProposal;
  children: Array<{ id: string; kind: "addressed" | "open"; metadata: Record<string, unknown> }>; reason: string;
}) {
  requireAuthor(args.author);
  return withAssemblyPreparation(() => withAssemblyWorkspaceLock(args.workspace_id, async () => {
    const selection = await manualParent(args);
    const { assembly: parent, revision_state } = selection;
    const predecessor = parent.items.find(item => item.canonical_claim_id === args.parent_claim_id && item.claim_type === "gap");
    if (!predecessor || args.children.length !== 2) throw new AssemblyError("invalid_input", "A split requires one selected parent and two children.");
    const id = newId("ahr"), created_at = nowIso();
    const items: import("@/accuracy/domain/assembly").ResolvedAssemblyItem[] = [];
    const origins: NonNullable<AssemblyRevision["item_origins"]> = [];
    for (const child of args.children) {
      const statement = child.kind === "addressed" ? args.proposal.addressed_statement : args.proposal.open_statement;
      const provenance = child.kind === "addressed" ? args.proposal.addressed_evidence : args.proposal.open_evidence;
      const source_file_id = predecessor.source_file_id;
      const version_id = newId("iver");
      const payload = { ...child.metadata, id: child.id, statement, external_id: null, provenance, split_role: child.kind };
      const origin: HumanItemOrigin = { kind: "human", revision_id: id, subject: args.author.subject, provider: args.author.provider,
        actor: args.author.actor, action: "split", reason: args.reason, parent_assembly_id: parent.id,
        predecessor_version_id: predecessor.id, source_file_id, provenance, created_at };
      await insertClaim({ id: child.id, workspace_id: args.workspace_id, claim_type: "gap", statement, source_file_id,
        metadata: { ...child.metadata, history_only: true } });
      await accuracyDb().insert(t.accuracyItemVersions).values({ id: version_id, workspace_id: args.workspace_id, claim_id: child.id,
        run_id: null, human_origin: origin, snapshot_id: null, iteration: null, item_index: items.length,
        origin_key: `human:${id}:${child.kind}`, claim_type: "gap", fingerprint: generatedItemFingerprint("gap", payload), payload, source_file_id, created_at });
      items.push({ id: version_id, claim_id: child.id, canonical_claim_id: child.id, claim_type: "gap", run_id: null,
        human_origin: origin, snapshot_id: null, iteration: null, item_index: items.length, payload, source_file_id, created_at, reason: args.reason });
      origins.push({ version_id, origin });
    }
    const coverage = parent.coverage.filter(pair => pair.gap_version_id !== predecessor.id);
    const additions: import("@/accuracy/domain/assembly").AssemblyCoverage[] = [];
    for (const child of items) for (const tactic of parent.items.filter(item => item.claim_type === "tactic")) {
      const addressed = child.payload.split_role === "addressed" && args.proposal.addressed_tactic_ids.includes(tactic.canonical_claim_id);
      additions.push(humanCoverage(id, child, tactic, addressed ? "full" : "pending",
        addressed ? args.proposal.addressed_evidence.map(span => span.block_id) : [], addressed ? args.reason : "Residual or unmapped slice requires assessment", addressed ? "decision" : "unassessed"));
    }
    const revision: AssemblyRevision = { id, workspace_id: args.workspace_id, baseline_assembly_id: revision_state.baseline_assembly_id,
      parent_assembly_id: parent.id, baseline_assembly_ids: "baselines" in selection ? selection.baselines : undefined,
      parent_assembly_ids: "parents" in selection ? selection.parents : undefined, action: "split", reason: args.reason, author: args.author,
      predecessor_version_id: predecessor.id, successor_version_id: null, successor_version_ids: items.map(item => item.id), item_origins: origins,
      operation_id: args.operation_id, source_file_id: predecessor.source_file_id, provenance: args.proposal.addressed_evidence,
      coverage: additions, created_at };
    const selections = [...parent.items.filter(item => item.id !== predecessor.id), ...items].map(item => ({ item_version_id: item.id, reason: item.reason }));
    return saveManualSuccessor(args, parent, revision, selections, [...coverage, ...additions]);
  }));
}

/** Inverse selects the original immutable content but always creates a fresh reviewable head. */
export async function createInverseAssemblyRevision(args: Omit<CreateAssemblyRevisionArgs, "change"> & {
  original_assembly_id: string; original_assembly_ids?: string[]; operation_id: string; reason: string;
}) {
  requireAuthor(args.author);
  return withAssemblyWorkspaceLock(args.workspace_id, async () => {
    const { assembly: parent, revision_state } = await requireParent(args, args.parent_assembly_id);
    const originals = await Promise.all((args.original_assembly_ids ?? [args.original_assembly_id]).map(id => readAssembly(args.workspace_id, id)));
    if (originals.some(row => !row)) throw new AssemblyError("not_found", "Original split selection is missing.");
    const original = { ...originals[0]!, items: [...new Map(originals.flatMap(row => row!.items).map(item => [item.id, item])).values()],
      coverage: [...new Map(originals.flatMap(row => row!.coverage).map(pair => [`${pair.gap_version_id}:${pair.tactic_version_id}`, pair])).values()] };
    if (!original) throw new AssemblyError("not_found", "Original split selection is missing.");
    const revision: AssemblyRevision = { id: newId("ahr"), workspace_id: args.workspace_id,
      baseline_assembly_id: revision_state.baseline_assembly_id, baseline_assembly_ids: revision_state.revision?.baseline_assembly_ids, parent_assembly_id: parent.id, action: "inverse", reason: args.reason,
      author: args.author, predecessor_version_id: null, successor_version_id: null, source_file_id: original.source_file_ids[0],
      provenance: [], operation_id: args.operation_id, created_at: nowIso() };
    return saveManualSuccessor(args, parent, revision, original.items.map(item => ({ item_version_id: item.id, reason: item.reason })), original.coverage);
  });
}
