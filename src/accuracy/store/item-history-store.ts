/** Transactional, workspace-scoped persistence for generated alternatives and identity decisions. */
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Actor } from "@/accuracy/kernel/contracts";
import { ItemHistoryError, generatedItemFingerprint, type ItemHistory, type ItemVersion } from "@/accuracy/domain/item-history";
import { needExtractOutputSchema } from "@/accuracy/modules/need-extract/module";
import { inventoryExtractOutputSchema } from "@/accuracy/modules/inventory-extract/module";
import { newId, nowIso } from "@/modules/kernel/ids";
import { insertClaim, type AccuracyClaimType } from "./claim-store";
import { accuracyDb, ensureAccuracySchema, withAccuracyTransaction } from "./db";
import * as t from "./schema";

export { ItemHistoryError } from "@/accuracy/domain/item-history";
import { validateQuoteAgainstBlock } from "./quote-validator";

type ProposalKind = "same_item" | "split" | "merge";
type PublishArgs = {
  workspace_id: string; source_file_id: string; run_id: string; claim_type: AccuracyClaimType;
  final_claims: Array<Parameters<typeof insertClaim>[0]>;
};

/** Serialize with omission review and extraction batch writes for this workspace. */
async function lockWorkspace(workspace_id: string) {
  await accuracyDb().execute(sql`select pg_advisory_xact_lock(hashtextextended(${`omission:${workspace_id}`}, 0))`);
}

function requireReason(rationale: string, actor: Actor) {
  if (!rationale?.trim() || !actor?.name?.trim() || !actor?.function?.trim()) {
    throw new ItemHistoryError("invalid_input", "A contributor identity and reason are required.");
  }
}

function metadata(row: typeof t.accuracyClaims.$inferSelect): Record<string, unknown> {
  return row.metadata as Record<string, unknown>;
}

function finalItems(claim_type: AccuracyClaimType, output: unknown, workspace_id: string, source_file_id: string) {
  const parsed = claim_type === "gap" ? needExtractOutputSchema.safeParse(output) : inventoryExtractOutputSchema.safeParse(output);
  if (!parsed.success || parsed.data.workspace_id !== workspace_id || parsed.data.source_file_id !== source_file_id) {
    throw new ItemHistoryError("invalid_input", "Stored run final output is invalid for this source.");
  }
  // Zod validates the shape but strips unknown fields. Identity and history use the stored bytes.
  const stored = output as Record<string, unknown>;
  return stored[claim_type === "gap" ? "gaps" : "tactics"] as Record<string, unknown>[];
}

function rawItems(claim_type: AccuracyClaimType, output: unknown): Array<{ item: Record<string, unknown>; item_index: number }> {
  if (!output || typeof output !== "object" || Array.isArray(output)) return [];
  const items = (output as Record<string, unknown>)[claim_type === "gap" ? "gaps" : "tactics"];
  if (!Array.isArray(items)) return [];
  return items.flatMap((item, item_index) => item !== null && typeof item === "object" && !Array.isArray(item)
    ? [{ item: item as Record<string, unknown>, item_index }] : []);
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, field]) => [key, canonical(field)]));
  }
  return value;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

function itemStatement(type: AccuracyClaimType, payload: Record<string, unknown>) {
  return String(payload[type === "gap" ? "statement" : "name"]);
}

function reviewStatement(type: AccuracyClaimType, payload: Record<string, unknown>, item_index: number): string {
  const value = payload[type === "gap" ? "statement" : "name"];
  return typeof value === "string" && value.trim() ? value : `Untitled ${type} draft ${item_index + 1}`;
}

function sourceBacked(payload: Record<string, unknown>, source_file_id: string,
  blocks: Map<string, string>): boolean {
  if (!Array.isArray(payload.provenance) || payload.provenance.length === 0) return false;
  return payload.provenance.every(span => {
    if (!span || typeof span !== "object" || Array.isArray(span)) return false;
    const ref = span as Record<string, unknown>;
    const text = typeof ref.block_id === "string" ? blocks.get(ref.block_id) : undefined;
    return ref.source_file_id === source_file_id && typeof ref.quote === "string" &&
      ref.quote.trim().length > 0 && typeof text === "string" && validateQuoteAgainstBlock({ block: { text }, quote: ref.quote }).ok;
  });
}

async function allRelations(workspace_id: string) {
  const proposals = await accuracyDb().select().from(t.accuracyItemRelationshipProposals)
    .where(eq(t.accuracyItemRelationshipProposals.workspace_id, workspace_id));
  const decisions = await accuracyDb().select().from(t.accuracyItemRelationshipDecisions)
    .where(eq(t.accuracyItemRelationshipDecisions.workspace_id, workspace_id));
  return { proposals, decisions: new Map(decisions.map(row => [row.proposal_id, row])) };
}

/** Server-owned history membership; metadata edits cannot remove generated identity protection. */
export async function listVersionedClaimIds(workspace_id: string): Promise<Set<string>> {
  await ensureAccuracySchema();
  const rows = await accuracyDb().selectDistinct({ claim_id: t.accuracyItemVersions.claim_id })
    .from(t.accuracyItemVersions).where(eq(t.accuracyItemVersions.workspace_id, workspace_id));
  return new Set(rows.map(row => row.claim_id));
}

function canonicalId(claims: Map<string, typeof t.accuracyClaims.$inferSelect>, id: string): string {
  const visited = new Set<string>();
  let current = id;
  while (true) {
    if (visited.has(current)) throw new ItemHistoryError("conflict", "Cyclic identity is stored.");
    visited.add(current);
    const row = claims.get(current);
    const next = row && typeof metadata(row).merged_into === "string" ? metadata(row).merged_into as string : null;
    if (!next) return current;
    current = next;
  }
}

/** Read one visible identity, including immutable versions owned by retired claims. */
export async function readItemHistory(workspace_id: string, claim_id: string): Promise<ItemHistory | null> {
  await ensureAccuracySchema();
  const claims = await accuracyDb().select().from(t.accuracyClaims).where(eq(t.accuracyClaims.workspace_id, workspace_id));
  const byId = new Map(claims.map(row => [row.id, row]));
  if (!byId.has(claim_id)) return null;
  const canonical_claim_id = canonicalId(byId, claim_id);
  const ownedIds = claims.filter(row => canonicalId(byId, row.id) === canonical_claim_id).map(row => row.id);
  const versions = await accuracyDb().select().from(t.accuracyItemVersions)
    .where(and(eq(t.accuracyItemVersions.workspace_id, workspace_id), inArray(t.accuracyItemVersions.claim_id, ownedIds)));
  const { proposals, decisions } = await allRelations(workspace_id);
  const relationships = await Promise.all(proposals.filter(p => [...p.predecessor_ids, ...p.successor_ids].some(id => ownedIds.includes(id)))
    .map(async p => ({ id: p.id, kind: p.kind as ProposalKind, predecessor_ids: p.predecessor_ids,
      successor_ids: p.successor_ids, rationale: p.rationale,
      proposal_actor: { name: p.actor_name, function: p.actor_function },
      decision_actor: decisions.has(p.id) ? { name: decisions.get(p.id)!.actor_name, function: decisions.get(p.id)!.actor_function } : null,
      decision_rationale: decisions.get(p.id)?.rationale ?? null, stale: await proposalIsStale(workspace_id, p),
      decision: (decisions.get(p.id)?.action as "confirm" | "reject" | undefined) ?? null })));
  versions.sort((a, b) => a.created_at.localeCompare(b.created_at) || (a.iteration ?? Infinity) - (b.iteration ?? Infinity) || a.item_index - b.item_index);
  return { claim: byId.get(canonical_claim_id)!, versions: versions.map(row => ({ id: row.id, claim_id: row.claim_id,
    run_id: row.run_id, snapshot_id: row.snapshot_id, iteration: row.iteration, item_index: row.item_index,
    payload: row.payload, source_file_id: row.source_file_id, created_at: row.created_at } satisfies ItemVersion)),
    relationships, canonical_claim_id };
}

function validateIds(ids: string[], label: string) {
  if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length || ids.some(id => typeof id !== "string" || !id.trim())) {
    throw new ItemHistoryError("invalid_input", `${label} must contain distinct claim IDs.`);
  }
}

async function requireClaims(workspace_id: string, ids: string[]) {
  const rows = await accuracyDb().select().from(t.accuracyClaims)
    .where(and(eq(t.accuracyClaims.workspace_id, workspace_id), inArray(t.accuracyClaims.id, ids)));
  if (rows.length !== ids.length) throw new ItemHistoryError("not_found", "A referenced claim is outside this workspace.");
  const versions = await accuracyDb().select().from(t.accuracyItemVersions)
    .where(and(eq(t.accuracyItemVersions.workspace_id, workspace_id), inArray(t.accuracyItemVersions.claim_id, ids)));
  if (new Set(versions.map(row => row.claim_id)).size !== ids.length) {
    throw new ItemHistoryError("invalid_input", "Relationships require stored generated versions.");
  }
  if (new Set(rows.map(row => row.claim_type)).size !== 1) throw new ItemHistoryError("invalid_input", "Item types must match.");
  return rows;
}

/** Resolve every supplied alias and retain all immutable owners in each identity group. */
async function identityGroups(workspace_id: string) {
  const rows = await accuracyDb().select().from(t.accuracyClaims)
    .where(eq(t.accuracyClaims.workspace_id, workspace_id));
  const claims = new Map(rows.map(row => [row.id, row]));
  const canonical = new Map(rows.map(row => [row.id, canonicalId(claims, row.id)]));
  return { claims, canonical };
}

async function basisVersionIds(workspace_id: string, ids: string[]): Promise<string[]> {
  const { canonical } = await identityGroups(workspace_id);
  const owners = ids.flatMap(id => [id, ...[...canonical.keys()]
    .filter(owner => owner !== id && canonical.get(owner) === canonical.get(id)).sort()]);
  const versions = await accuracyDb().select().from(t.accuracyItemVersions).where(and(
    eq(t.accuracyItemVersions.workspace_id, workspace_id), inArray(t.accuracyItemVersions.claim_id, owners)));
  return [...new Set(owners)].flatMap(id => versions.filter(v => v.claim_id === id).map(v => v.id).sort());
}

/** Compare immutable proposal evidence with the current workspace-scoped version basis. */
async function proposalIsStale(workspace_id: string, proposal: typeof t.accuracyItemRelationshipProposals.$inferSelect): Promise<boolean> {
  const currentBasis = await basisVersionIds(workspace_id, [...proposal.predecessor_ids, ...proposal.successor_ids]);
  return JSON.stringify(currentBasis) !== JSON.stringify(proposal.basis_version_ids);
}

function validateShape(kind: ProposalKind, predecessors: string[], successors: string[]) {
  validateIds(predecessors, "Predecessors"); validateIds(successors, "Successors");
  if (predecessors.some(id => successors.includes(id))) throw new ItemHistoryError("invalid_input", "A claim cannot relate to itself.");
  if (kind === "same_item" && (predecessors.length !== 1 || successors.length !== 1))
    throw new ItemHistoryError("invalid_input", "Same-item needs one predecessor and one successor.");
  if (kind === "split" && (predecessors.length !== 1 || successors.length < 2))
    throw new ItemHistoryError("invalid_input", "Split needs one predecessor and at least two successors.");
  if (kind === "merge" && (predecessors.length < 2 || successors.length !== 1))
    throw new ItemHistoryError("invalid_input", "Merge needs at least two predecessors and one successor.");
  if (!["same_item", "split", "merge"].includes(kind)) throw new ItemHistoryError("invalid_input", "Unknown relationship kind.");
}

async function assertAvailable(workspace_id: string, kind: ProposalKind, predecessors: string[], successors: string[], exclude?: string) {
  await requireClaims(workspace_id, [...predecessors, ...successors]);
  const { claims, canonical } = await identityGroups(workspace_id);
  const resolve = (id: string) => canonical.get(id) ?? id;
  const before = predecessors.map(resolve);
  const after = successors.map(resolve);
  const ids = [...before, ...after];
  if (new Set(ids).size !== ids.length) throw new ItemHistoryError("conflict", "A canonical identity cannot relate to itself or appear twice.");
  const rows = ids.map(id => claims.get(id)!);
  if (kind !== "same_item" && after.some(id => metadata(claims.get(id)!).history_only !== true)) {
    throw new ItemHistoryError("invalid_input", "Ancestry successors must be new history-only entries.");
  }
  if (kind === "same_item" && rows.every(row => metadata(row).history_only !== true)) {
    throw new ItemHistoryError("conflict", "Two judged output entries cannot be joined automatically.");
  }
  const { proposals, decisions } = await allRelations(workspace_id);
  for (const proposal of proposals) {
    if (proposal.id === exclude || decisions.has(proposal.id)) continue;
    if (![...proposal.predecessor_ids, ...proposal.successor_ids].map(resolve).some(id => ids.includes(id))) continue;
    // Stale undecided proposals remain audit records and permit review on a fresh basis.
    if (await proposalIsStale(workspace_id, proposal)) continue;
    throw new ItemHistoryError("conflict", "An identity already participates in a pending relationship.");
  }
  const ancestry = proposals.filter(p => p.kind !== "same_item" && decisions.get(p.id)?.action === "confirm");
  if (kind !== "same_item") {
    // Existing descendants can become predecessors, but each ancestry operation needs new successors.
    if (ancestry.some(p => p.predecessor_ids.map(resolve).some(id => before.includes(id)) ||
      [...p.predecessor_ids, ...p.successor_ids].map(resolve).some(id => after.includes(id)))) {
      throw new ItemHistoryError("conflict", "Ancestry must continue into new descendants without reusing an existing operation.");
    }
  }
  // Test the resulting ancestry graph, including contraction of a proposed same-item group.
  const contract = (id: string) => {
    const root = resolve(id);
    return kind === "same_item" && root === before[0] ? after[0] : root;
  };
  const edges = new Map<string, Set<string>>();
  const incoming = new Set<string>();
  const outgoing = new Set<string>();
  const graph = kind === "same_item" ? ancestry : [...ancestry, { predecessor_ids: before, successor_ids: after, kind }];
  for (const relation of graph) {
    const from = [...new Set(relation.predecessor_ids.map(contract))];
    const to = [...new Set(relation.successor_ids.map(contract))];
    if ((relation.kind === "split" && (from.length !== 1 || to.length < 2)) ||
      (relation.kind === "merge" && (from.length < 2 || to.length !== 1)) ||
      from.some(id => outgoing.has(id)) || to.some(id => incoming.has(id))) {
      throw new ItemHistoryError("conflict", "Identity consolidation conflicts with recorded ancestry.");
    }
    for (const id of from) { outgoing.add(id); edges.set(id, new Set([...(edges.get(id) ?? []), ...to])); }
    for (const id of to) incoming.add(id);
  }
  const visiting = new Set<string>(); const visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new ItemHistoryError("conflict", "Relationship would create an ancestry cycle.");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const next of edges.get(id) ?? []) visit(next);
    visiting.delete(id); visited.add(id);
  };
  for (const id of edges.keys()) visit(id);
  return rows;
}

/** Record a review-only identity or ancestry proposal. */
export async function proposeItemRelationship(args: { workspace_id: string; kind: ProposalKind; predecessor_ids: string[];
  successor_ids: string[]; rationale: string; actor: Actor }): Promise<{ id: string }> {
  requireReason(args.rationale, args.actor);
  validateShape(args.kind, args.predecessor_ids, args.successor_ids);
  return withAccuracyTransaction(async () => {
    await lockWorkspace(args.workspace_id);
    await assertAvailable(args.workspace_id, args.kind, args.predecessor_ids, args.successor_ids);
    const basis_version_ids = await basisVersionIds(args.workspace_id, [...args.predecessor_ids, ...args.successor_ids]);
    const id = newId("irel");
    await accuracyDb().insert(t.accuracyItemRelationshipProposals).values({ id, workspace_id: args.workspace_id,
      kind: args.kind, predecessor_ids: args.predecessor_ids, successor_ids: args.successor_ids, basis_version_ids,
      rationale: args.rationale.trim(), actor_name: args.actor.name, actor_function: args.actor.function,
      created_at: nowIso() });
    return { id };
  });
}

/** Confirm or reject a proposal atomically; only confirmation changes visible identity. */
export async function decideItemRelationship(args: { workspace_id: string; proposal_id: string;
  action: "confirm" | "reject"; rationale: string; actor: Actor }): Promise<ItemHistory[]> {
  requireReason(args.rationale, args.actor);
  if (args.action !== "confirm" && args.action !== "reject") throw new ItemHistoryError("invalid_input", "Unknown decision.");
  return withAccuracyTransaction(async () => {
    await lockWorkspace(args.workspace_id);
    const [proposal] = await accuracyDb().select().from(t.accuracyItemRelationshipProposals)
      .where(and(eq(t.accuracyItemRelationshipProposals.id, args.proposal_id), eq(t.accuracyItemRelationshipProposals.workspace_id, args.workspace_id)));
    if (!proposal) throw new ItemHistoryError("not_found", "Relationship proposal not found.");
    const [prior] = await accuracyDb().select().from(t.accuracyItemRelationshipDecisions)
      .where(eq(t.accuracyItemRelationshipDecisions.proposal_id, proposal.id));
    if (prior) throw new ItemHistoryError("conflict", "Relationship has already been decided.");
    if (await proposalIsStale(args.workspace_id, proposal)) {
      throw new ItemHistoryError("conflict", "Relationship proposal is stale after new item versions.");
    }
    if (args.action === "confirm") {
      const rows = await assertAvailable(args.workspace_id, proposal.kind as ProposalKind, proposal.predecessor_ids, proposal.successor_ids, proposal.id);
      if (proposal.kind === "same_item") {
        const winner = rows.find(row => metadata(row).history_only !== true) ?? rows[1];
        const loser = rows.find(row => row.id !== winner.id)!;
        await accuracyDb().update(t.accuracyClaims).set({ status: "merged",
          metadata: { ...metadata(loser), merged_into: winner.id, merge_reason: args.rationale.trim() }, updated_at: nowIso() })
          .where(and(eq(t.accuracyClaims.id, loser.id), eq(t.accuracyClaims.workspace_id, args.workspace_id)));
      }
    }
    await accuracyDb().insert(t.accuracyItemRelationshipDecisions).values({ id: newId("idec"), workspace_id: args.workspace_id,
      proposal_id: proposal.id, action: args.action, rationale: args.rationale.trim(), actor_name: args.actor.name,
      actor_function: args.actor.function, created_at: nowIso() });
    const histories = await Promise.all([...new Set([...proposal.predecessor_ids, ...proposal.successor_ids])]
      .map(id => readItemHistory(args.workspace_id, id)));
    return histories.filter((h): h is ItemHistory => h !== null);
  });
}

/** Publish only items tied to a successful persisted extraction run and its own snapshots. */
export async function publishGeneratedItemHistory(args: PublishArgs): Promise<{ claim_ids: string[] }> {
  return withAccuracyTransaction(async () => {
    await lockWorkspace(args.workspace_id);
    const [source] = await accuracyDb().select().from(t.accuracySourceFiles).where(and(
      eq(t.accuracySourceFiles.id, args.source_file_id), eq(t.accuracySourceFiles.workspace_id, args.workspace_id)));
    const [run] = await accuracyDb().select().from(t.accuracyModuleRuns).where(and(
      eq(t.accuracyModuleRuns.id, args.run_id), eq(t.accuracyModuleRuns.workspace_id, args.workspace_id)));
    if (!source || !run || run.org_id !== source.org_id || run.status !== "ok" ||
      run.call_kind !== (args.claim_type === "gap" ? "need_extract" : "inventory_extract") ||
      (run.input as Record<string, unknown>)?.workspace_id !== args.workspace_id ||
      (run.input as Record<string, unknown>)?.source_file_id !== args.source_file_id) {
      throw new ItemHistoryError("invalid_input", "Run is not a successful extraction for this source and workspace.");
    }
    const finals = finalItems(args.claim_type, run.output, args.workspace_id, args.source_file_id);
    const sourceBlocks = await accuracyDb().select().from(t.accuracyParseBlocks).where(and(
      eq(t.accuracyParseBlocks.workspace_id, args.workspace_id), eq(t.accuracyParseBlocks.source_file_id, args.source_file_id)));
    const blockText = new Map(sourceBlocks.map(block => [block.id, block.text]));
    if (finals.some(item => !sourceBacked(item, args.source_file_id, blockText))) {
      throw new ItemHistoryError("invalid_input", "Final item provenance is not supported by stored source blocks.");
    }
    if (finals.length !== args.final_claims.length) throw new ItemHistoryError("invalid_input", "Final claims do not match stored output.");
    const snapshots = await accuracyDb().select().from(t.accuracyAgentEvents).where(and(
      eq(t.accuracyAgentEvents.workspace_id, args.workspace_id), eq(t.accuracyAgentEvents.run_id, args.run_id),
      eq(t.accuracyAgentEvents.event_type, "snapshot")));
    snapshots.sort((a, b) => (a.iteration ?? 0) - (b.iteration ?? 0));
    const claim_ids: string[] = [];
    const finalFingerprints = finals.map(item => generatedItemFingerprint(args.claim_type, item));
    const existingVersions = await accuracyDb().select().from(t.accuracyItemVersions).where(and(
      eq(t.accuracyItemVersions.workspace_id, args.workspace_id), eq(t.accuracyItemVersions.source_file_id, args.source_file_id),
      eq(t.accuracyItemVersions.claim_type, args.claim_type)));
    const currentClaims = await accuracyDb().select().from(t.accuracyClaims)
      .where(eq(t.accuracyClaims.workspace_id, args.workspace_id));
    const currentById = new Map(currentClaims.map(row => [row.id, row]));
    const owned = new Map<string, string>();
    const autoJoins: Array<{ predecessor_id: string; successor_id: string }> = [];
    const ambiguousMatches: Array<{ predecessor_ids: string[]; successor_id: string }> = [];
    for (const [index, item] of finals.entries()) {
      const draft = args.final_claims[index];
      if (draft.workspace_id !== args.workspace_id || draft.source_file_id !== args.source_file_id ||
        draft.claim_type !== args.claim_type || draft.id !== item.id || draft.statement !== itemStatement(args.claim_type, item)) {
        throw new ItemHistoryError("invalid_input", "Claim differs from stored final output.");
      }
      const sameBatchClaim = owned.get(finalFingerprints[index]);
      if (sameBatchClaim) {
        claim_ids.push(sameBatchClaim);
        continue;
      }
      if (existingVersions.some(v => v.run_id === args.run_id && v.fingerprint === finalFingerprints[index] && v.claim_id === draft.id)) {
        claim_ids.push(draft.id!);
        owned.set(finalFingerprints[index], draft.id!);
        continue;
      }
      const key = `final:${args.run_id}:${args.claim_type}:${index}`;
      const [priorOrigin] = await accuracyDb().select().from(t.accuracyItemVersions).where(and(
        eq(t.accuracyItemVersions.workspace_id, args.workspace_id), eq(t.accuracyItemVersions.origin_key, key)));
      if (priorOrigin) { claim_ids.push(priorOrigin.claim_id); owned.set(finalFingerprints[index], priorOrigin.claim_id); continue; }
      const matches = [...new Set(existingVersions.filter(v => v.fingerprint === finalFingerprints[index] &&
        sourceBacked(v.payload, args.source_file_id, blockText)).map(v => canonicalId(currentById, v.claim_id)))];
      const existingClaim = matches.length === 1 ? (await accuracyDb().select().from(t.accuracyClaims).where(and(
        eq(t.accuracyClaims.workspace_id, args.workspace_id), eq(t.accuracyClaims.id, matches[0]))))[0] : undefined;
      const reusable = existingClaim && existingClaim.status !== "merged" && metadata(existingClaim).history_only !== true;
      const claim_id = reusable ? existingClaim.id : draft.id!;
      if (!reusable) {
        const [sameId] = await accuracyDb().select().from(t.accuracyClaims).where(eq(t.accuracyClaims.id, claim_id));
        if (sameId) throw new ItemHistoryError("conflict", "Generated claim ID already exists.");
        await insertClaim(draft);
        if (existingClaim && existingClaim.status !== "merged" && metadata(existingClaim).history_only === true) {
          autoJoins.push({ predecessor_id: existingClaim.id, successor_id: claim_id });
        }
        if (matches.length > 1) ambiguousMatches.push({ predecessor_ids: matches, successor_id: claim_id });
      }
      claim_ids.push(claim_id);
      owned.set(finalFingerprints[index], claim_id);
    }
    const rawOrigins: Array<{ key: string; item: Record<string, unknown>; fingerprint: string;
      snapshot_id: string; iteration: number; item_index: number }> = [];
    for (const snapshot of snapshots) {
      const payload = snapshot.payload as Record<string, unknown>;
      const items = rawItems(args.claim_type, payload.output);
      for (const { item_index, item } of items) rawOrigins.push({ key: `snapshot:${snapshot.id}:${args.claim_type}:${item_index}`,
        item, fingerprint: generatedItemFingerprint(args.claim_type, item), snapshot_id: snapshot.id,
        iteration: snapshot.iteration!, item_index });
    }
    for (const origin of rawOrigins) {
      const [prior] = await accuracyDb().select().from(t.accuracyItemVersions).where(and(
        eq(t.accuracyItemVersions.workspace_id, args.workspace_id), eq(t.accuracyItemVersions.origin_key, origin.key)));
      if (prior) continue;
      let claim_id = owned.get(origin.fingerprint);
      if (!claim_id) {
        const matches = [...new Set(existingVersions.filter(v => v.fingerprint === origin.fingerprint &&
          sourceBacked(origin.item, args.source_file_id, blockText) && sourceBacked(v.payload, args.source_file_id, blockText))
          .map(v => canonicalId(currentById, v.claim_id)))];
        if (matches.length === 1) claim_id = matches[0];
      }
      if (!claim_id) {
        const claim = await insertClaim({ workspace_id: args.workspace_id, claim_type: args.claim_type,
          statement: reviewStatement(args.claim_type, origin.item, origin.item_index), source_file_id: args.source_file_id,
          metadata: { history_only: true, provenance: origin.item.provenance ?? [] } });
        claim_id = claim.id;
      }
      owned.set(origin.fingerprint, claim_id);
      await accuracyDb().insert(t.accuracyItemVersions).values({ id: newId("iver"), workspace_id: args.workspace_id,
        claim_id, run_id: args.run_id, snapshot_id: origin.snapshot_id, iteration: origin.iteration,
        item_index: origin.item_index, origin_key: origin.key, claim_type: args.claim_type,
        fingerprint: origin.fingerprint, payload: origin.item, source_file_id: args.source_file_id, created_at: nowIso() });
    }
    for (const [index, item] of finals.entries()) {
      const fingerprint = finalFingerprints[index];
      if (rawOrigins.some(raw => raw.fingerprint === fingerprint && sameJson(raw.item, item))) continue;
      const key = `final:${args.run_id}:${args.claim_type}:${index}`;
      const [prior] = await accuracyDb().select().from(t.accuracyItemVersions).where(and(
        eq(t.accuracyItemVersions.workspace_id, args.workspace_id), eq(t.accuracyItemVersions.origin_key, key)));
      if (prior) continue;
      await accuracyDb().insert(t.accuracyItemVersions).values({ id: newId("iver"), workspace_id: args.workspace_id,
        claim_id: claim_ids[index], run_id: args.run_id, snapshot_id: null, iteration: null, item_index: index,
        origin_key: key, claim_type: args.claim_type, fingerprint, payload: item,
        source_file_id: args.source_file_id, created_at: nowIso() });
    }
    for (const join of autoJoins) {
      try {
        await assertAvailable(args.workspace_id, "same_item", [join.predecessor_id], [join.successor_id]);
      } catch (error) {
        if (error instanceof ItemHistoryError && error.code === "conflict") continue;
        throw error;
      }
      const id = newId("irel");
      await accuracyDb().insert(t.accuracyItemRelationshipProposals).values({ id, workspace_id: args.workspace_id,
        kind: "same_item", predecessor_ids: [join.predecessor_id], successor_ids: [join.successor_id],
        basis_version_ids: await basisVersionIds(args.workspace_id, [join.predecessor_id, join.successor_id]),
        rationale: "Unique exact source-backed generated item match.", actor_name: "system",
        actor_function: "system", created_at: nowIso() });
      await accuracyDb().insert(t.accuracyItemRelationshipDecisions).values({ id: newId("idec"), workspace_id: args.workspace_id,
        proposal_id: id, action: "confirm", rationale: "Unique exact source-backed generated item match.",
        actor_name: "system", actor_function: "system", created_at: nowIso() });
      const [loser] = await accuracyDb().select().from(t.accuracyClaims).where(eq(t.accuracyClaims.id, join.predecessor_id));
      await accuracyDb().update(t.accuracyClaims).set({ status: "merged",
        metadata: { ...metadata(loser), merged_into: join.successor_id, merge_reason: "Unique exact source-backed generated item match." },
        updated_at: nowIso() }).where(and(eq(t.accuracyClaims.workspace_id, args.workspace_id), eq(t.accuracyClaims.id, join.predecessor_id)));
    }
    for (const ambiguity of ambiguousMatches) {
      for (const predecessor_id of ambiguity.predecessor_ids) {
        await accuracyDb().insert(t.accuracyItemRelationshipProposals).values({ id: newId("irel"),
          workspace_id: args.workspace_id, kind: "same_item", predecessor_ids: [predecessor_id],
          successor_ids: [ambiguity.successor_id],
          basis_version_ids: await basisVersionIds(args.workspace_id, [predecessor_id, ambiguity.successor_id]),
          rationale: "Multiple exact source-backed matches; contributor review must select one identity.",
          actor_name: "system", actor_function: "system", created_at: nowIso() });
      }
    }
    // A changed draft may be a revision, but shared source evidence alone cannot decide identity.
    // Record one inspectable proposal only when there is one plausible final target.
    const rawDraftIds = [...new Set(rawOrigins.filter(raw => !finalFingerprints.includes(raw.fingerprint) &&
      sourceBacked(raw.item, args.source_file_id, blockText)).map(raw => owned.get(raw.fingerprint)).filter((id): id is string => Boolean(id)))];
    for (const draftId of rawDraftIds) {
      const draftVersions = await accuracyDb().select().from(t.accuracyItemVersions).where(and(
        eq(t.accuracyItemVersions.workspace_id, args.workspace_id), eq(t.accuracyItemVersions.claim_id, draftId)));
      const draftBlocks = new Set(draftVersions.flatMap(v => Array.isArray(v.payload.provenance)
        ? v.payload.provenance.flatMap(span => span && typeof span === "object" && "block_id" in span && typeof span.block_id === "string" ? [span.block_id] : []) : []));
      const candidates = [...new Set(finals.flatMap((item, index) => {
        const overlaps = Array.isArray(item.provenance) && item.provenance.some(span => span && typeof span === "object" &&
          "block_id" in span && typeof span.block_id === "string" && draftBlocks.has(span.block_id));
        return overlaps && claim_ids[index] !== draftId ? [claim_ids[index]] : [];
      }))];
      if (candidates.length !== 1) continue;
      try {
        await assertAvailable(args.workspace_id, "same_item", [draftId], [candidates[0]]);
      } catch (error) {
        if (error instanceof ItemHistoryError && error.code === "conflict") continue;
        throw error;
      }
      const basis_version_ids = await basisVersionIds(args.workspace_id, [draftId, candidates[0]]);
      await accuracyDb().insert(t.accuracyItemRelationshipProposals).values({ id: newId("irel"), workspace_id: args.workspace_id,
        kind: "same_item", predecessor_ids: [draftId], successor_ids: [candidates[0]], basis_version_ids,
        rationale: "Possible revision sharing source evidence; contributor review required.",
        actor_name: "system", actor_function: "system", created_at: nowIso() });
    }
    return { claim_ids };
  });
}
