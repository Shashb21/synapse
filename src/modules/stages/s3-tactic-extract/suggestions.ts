import { TrustedApplicationError } from "@/modules/kernel/stage-errors";
import { withRelationshipChange } from "@/lib/iegp/relationship-change";
/** S3 source review: immutable model baseline, source provenance and atomic human decisions. */
import { currentSourceFindingKey, matchingSourceQuestions, reclassifiedFindings, scopeSourceFinding, sourceFindingActivity, sourceFindingKey } from "@/lib/ingest/source-findings";
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { reconcileHistoricalCitation } from "@/lib/iegp/engine";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db, ensureCurrentSchemaTables } from "@/lib/iegp/db";
import * as t from "@/lib/iegp/schema";
import { appendAudit, insertLibraryTactic, readState } from "@/lib/iegp/store";
import { acceptTacticExpansion, expansionScopeSchema, tacticVersion, type ExpansionTransaction } from "@/lib/iegp/tactic-expansions";
import { ACTOR_FUNCTIONS, TACTIC_STATUSES, TACTIC_TYPES } from "@/lib/iegp/enums";
import type { Actor, ExpansionScope, SeparateTacticOption, Tactic, TacticSuggestion } from "@/lib/iegp/types";
import { requireRationale } from "@/modules/kernel/edit-records";
import { newId, nowIso } from "@/modules/kernel/ids";
import { captureTacticSuggestionDecision } from "@/lib/iegp/learning-capture";
import { quotedBlock } from "../extraction-sections";
import { tacticCandidates, tacticSourceReferences, tacticSuggestions } from "./schema";

export const separateTacticOptionSchema = z.object({name: z.string().trim().min(1), type: z.enum(TACTIC_TYPES), status: z.enum(TACTIC_STATUSES), evidence_question: z.string().trim().min(1)}).strict();
const quoteKey = (quote: string) => quote.toLowerCase().replace(/\s+/g, " ").trim();
const blockQuoteKey = (blockId: string, quote: string) => JSON.stringify([blockId, quoteKey(quote)]);
function suggestionKey(sourceId: string, targetId: string, quote: string, blockId?: string | null, findingKey?: string) {
  const parts = [sourceId, targetId, findingKey ?? quoteKey(quote)];
  if (blockId) parts.push(blockId);
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/** Move tactic citations and suggestion identities within the source editor's locked transaction. */
export async function moveTacticSourceCitations(
  sourceId: string,
  original: { id: string; text: string },
  replacements: readonly { id: string; text: string }[],
) {
  const transaction = db();
  const references = await transaction.select().from(tacticSourceReferences)
    .where(eq(tacticSourceReferences.source_id, sourceId));
  const referenceKeys = new Map(references.map(reference => [JSON.stringify([reference.tactic_id, reference.quote_key]), reference]));
  for (const reference of references.filter(row => row.block_id === original.id)) {
    const blockId = quotedBlock(replacements, reference.source_quote, original.id);
    if (!blockId || blockId === original.id) continue;

    const updatedQuoteKey = blockQuoteKey(blockId, reference.source_quote);
    const key = JSON.stringify([reference.tactic_id, updatedQuoteKey]);
    const existing = referenceKeys.get(key);
    if (existing) {
      existing.finding_keys = [...new Set([...existing.finding_keys, ...reference.finding_keys])];
      await transaction.update(tacticSourceReferences).set({ finding_keys: existing.finding_keys })
        .where(eq(tacticSourceReferences.id, existing.id));
      await transaction.delete(tacticSourceReferences).where(eq(tacticSourceReferences.id, reference.id));
    } else {
      await transaction.update(tacticSourceReferences).set({ block_id: blockId, quote_key: updatedQuoteKey })
        .where(eq(tacticSourceReferences.id, reference.id));
      referenceKeys.set(key, reference);
    }
  }
  const suggestions = await transaction.select().from(tacticSuggestions).where(and(
    eq(tacticSuggestions.source_id, sourceId),
    sql`${tacticSuggestions.payload}->>'block_id' = ${original.id}`,
  )).for("update");
  for (const stored of suggestions) {
    const suggestion = stored.payload as TacticSuggestion;
    if (!quotedBlock([original], suggestion.source_quote)) continue;
    const blockId = quotedBlock(replacements, suggestion.source_quote, original.id);
    if (!blockId || blockId === original.id) continue;
    await transaction.update(tacticSuggestions).set({
      source_key: suggestionKey(sourceId, stored.target_tactic_id, suggestion.source_quote, blockId, suggestion.finding_key),
      payload: { ...suggestion, block_id: blockId },
    }).where(eq(tacticSuggestions.id, stored.id));
  }
}
function requireActor(actor: Actor) {
  if (!actor?.name?.trim() || !ACTOR_FUNCTIONS.includes(actor.function)) throw new TrustedApplicationError("A named actor with a known function is required.");
}
/** Bootstrap before reserving a transaction; never borrow a second reader from inside it. */
export async function ensureTacticSuggestionSchema() { await ensureCurrentSchemaTables(); }
/** Attach an exact source sentence once, leaving all parent fields and locks intact. */
export async function attachTacticSource(args: {tactic_id: string; source_id: string; source_quote: string; finding_key?: string; block_id?: string | null}, transaction?: ExpansionTransaction) {
  if (!args.source_quote.trim()) throw new TrustedApplicationError("Source quote is required.");
  const run = async (tx: ExpansionTransaction) => {
    const sourceQuery = tx.select({ id: t.sources.id }).from(t.sources).where(eq(t.sources.id, args.source_id));
    const [source] = await (args.block_id ? sourceQuery.for("update") : sourceQuery);
    const [parent] = await tx.select().from(t.tactics).where(eq(t.tactics.id, args.tactic_id)).for("update");
    if (!parent || !source) throw new TrustedApplicationError("Tactic or source not found in this workspace.", "not_found", 404);
    if (args.block_id) {
      const [block] = await tx.select({ text: t.sourceBlocks.text }).from(t.sourceBlocks)
        .where(and(eq(t.sourceBlocks.id, args.block_id), eq(t.sourceBlocks.source_id, args.source_id)));
      if (!block || !quoteKey(block.text).includes(quoteKey(args.source_quote))) {
        throw new TrustedApplicationError("The source passage changed during extraction. Rerun tactic extraction.");
      }
    }
    const { finding_key, ...reference } = args;
    const parentKey = sourceFindingKey(args.source_id, args.source_quote, parent.type, parent.evidence_question, parent.name);
    const finding = finding_key ? currentSourceFindingKey(finding_key) : parentKey;
    const findingsOf = (row: typeof tacticSourceReferences.$inferSelect) =>
      [...new Set([...(row.finding_keys.length ? row.finding_keys.map(key => currentSourceFindingKey(key, parent.name)) : [parentKey]), finding])];
    const legacyKey = quoteKey(args.source_quote);
    const key = args.block_id ? blockQuoteKey(args.block_id, args.source_quote) : legacyKey;
    const existing = await tx.select().from(tacticSourceReferences).where(and(
      eq(tacticSourceReferences.tactic_id, args.tactic_id),
      eq(tacticSourceReferences.source_id, args.source_id),
      args.block_id ? inArray(tacticSourceReferences.quote_key, [key, legacyKey]) : undefined,
    ));
    const exact = existing.find(row => row.quote_key === key || (!args.block_id && quoteKey(row.source_quote) === legacyKey));
    if (exact) {
      await tx.update(tacticSourceReferences).set({ finding_keys: findingsOf(exact) }).where(eq(tacticSourceReferences.id, exact.id));
      return;
    }
    if (args.block_id) {
      const legacy = existing.find(row => row.quote_key === legacyKey && !row.block_id);
      if (legacy) {
        const blocks = await tx.select().from(t.sourceBlocks).where(eq(t.sourceBlocks.source_id, args.source_id));
        const update = reconcileHistoricalCitation(blocks, legacy.source_quote, args.block_id, legacy.observed_block_ids);
        await tx.update(tacticSourceReferences).set({
          ...update, ...(update && "block_id" in update ? { quote_key: key } : {}), finding_keys: findingsOf(legacy),
        }).where(eq(tacticSourceReferences.id, legacy.id));
        return;
      }
    }
    await tx.insert(tacticSourceReferences).values({...reference, id: newId("TSRC"), quote_key: key, finding_keys: [finding], created_at: nowIso()}).onConflictDoNothing();
  };
  if (transaction) return run(transaction);
  await ensureTacticSuggestionSchema(); return db().transaction(run);
}
/** List all provenance for a tactic, including multiple documents and sentences. */
export async function listTacticSourceReferences(tacticId: string) {
  await ensureTacticSuggestionSchema();
  return db().select().from(tacticSourceReferences).where(eq(tacticSourceReferences.tactic_id, tacticId));
}
type SourcePassage = { source_id: string; source_quote: string; block_id?: string | null };
type ReviewReader = Pick<ExpansionTransaction, "select">;

/** Recover original finding keys using immutable proposals saved alongside legacy reviews. */
async function reviewedFindings(reader: ReviewReader, suggestions: TacticSuggestion[], incoming: SourcePassage[]) {
  const legacy = suggestions.filter(row => !row.finding_key || !sourceFindingActivity(row.finding_key));
  const originals = legacy.length ? await reader.select().from(tacticCandidates).where(and(
    inArray(tacticCandidates.run_id, legacy.map(row => row.run_id)), inArray(tacticCandidates.source_id, legacy.map(row => row.source_id)),
    eq(tacticCandidates.match, "overlaps"), eq(tacticCandidates.verdict, "accept"),
  )) : [];
  const result = new Map<TacticSuggestion, string>();
  for (const row of suggestions) {
    if (row.finding_key && sourceFindingActivity(row.finding_key)) {
      result.set(row, currentSourceFindingKey(row.finding_key));
      continue;
    }
    const matching = originals.filter(candidate => candidate.run_id === row.run_id && candidate.document_id === row.document_id
      && candidate.source_id === row.source_id && candidate.target_tactic_id === row.target_tactic_id && quoteKey(candidate.source_quote) === quoteKey(row.source_quote));
    if (!matching.length) {
      const baseline = sourceFindingKey(row.source_id, row.source_quote, row.original_separate.type, row.original_separate.evidence_question, row.original_separate.name);
      result.set(row, row.finding_key ? currentSourceFindingKey(row.finding_key, row.original_separate.name) : baseline);
      continue;
    }
    const baseline = { shared_scope: row.shared_scope, new_scope: row.new_scope, expansion: row.original_expansion, separate: row.original_separate };
    const matches = matching.length > 1 ? matching.filter(candidate => isDeepStrictEqual(candidate.matching, baseline)) : matching;
    const keys = new Set(matches.filter(candidate => !row.finding_key || currentSourceFindingKey(row.finding_key) ===
      sourceFindingKey(candidate.source_id, candidate.source_quote, candidate.type, candidate.evidence_question))
      .map(candidate => sourceFindingKey(candidate.source_id, candidate.source_quote, candidate.type, candidate.evidence_question, candidate.name)));
    if (keys.size === 1) {
      for (const key of keys) result.set(row, key);
    } else if (incoming.some(candidate => candidate.source_id === row.source_id && (!row.block_id || candidate.block_id === row.block_id) && quoteKey(candidate.source_quote) === quoteKey(row.source_quote))) {
      throw new TrustedApplicationError("A legacy review has several possible source findings. Review the original passage before retrying.", "ambiguous_source_finding", 409);
    }
  }
  return result;
}

/** Read every already-inventoried or reviewed sentence for the sources in a production rerun. */
export async function recordedTacticEvidence(sourceIds: string[], tactics: Tactic[], incoming: SourcePassage[] = []) {
  const references = await db().select()
    .from(tacticSourceReferences).where(inArray(tacticSourceReferences.source_id, sourceIds));
  const reviews = await db().select({ payload: tacticSuggestions.payload })
    .from(tacticSuggestions).where(inArray(tacticSuggestions.source_id, sourceIds));
  // A review's compared parent does not own the proposed separate activity.
  const findings = new Map<string, { owners: Set<string>; labels: Set<string> }>();
  const record = (key: string, owner?: string | null, labels: string[] = []) => {
    const entry = findings.get(key) ?? { owners: new Set<string>(), labels: new Set<string>() };
    if (owner) entry.owners.add(owner);
    for (const label of labels) entry.labels.add(label);
    findings.set(key, entry);
  };
  const byId = new Map(tactics.map(tactic => [tactic.id, tactic]));
  for (const reference of references) {
    const parent = byId.get(reference.tactic_id);
    if (reference.finding_keys.length) {
      for (const key of reference.finding_keys) record(scopeSourceFinding(currentSourceFindingKey(key, parent?.name), reference.block_id), reference.tactic_id);
    } else if (parent) {
      record(scopeSourceFinding(sourceFindingKey(reference.source_id, reference.source_quote, parent.type, parent.evidence_question, parent.name), reference.block_id), parent.id);
    }
  }
  const suggestions = reviews.map(review => review.payload as TacticSuggestion);
  const reviewed = await reviewedFindings(db(), suggestions, incoming);
  for (const [row, key] of reviewed) record(scopeSourceFinding(key, row.block_id), row.result_tactic_id, [row.original_separate.name, row.original_expansion.name]);
  // Older extracted tactics have no reference row. Only use their explicit source marker.
  const referenced = new Set(references.map(row => JSON.stringify([row.tactic_id, row.source_id, quoteKey(row.source_quote)])));
  const byMarker = new Map(sourceIds.map(id => [`Extracted from ${id}`, id]));
  for (const tactic of tactics) {
    const sourceId = byMarker.get(tactic.intended_use);
    if (sourceId && tactic.source_quote?.trim() && !referenced.has(JSON.stringify([tactic.id, sourceId, quoteKey(tactic.source_quote)]))) {
      record(scopeSourceFinding(sourceFindingKey(sourceId, tactic.source_quote, tactic.type, tactic.evidence_question, tactic.name), tactic.block_id), tactic.id);
    }
  }
  return findings;
}

/** Persist each distinct overlap and retain earlier human decisions on reruns. */
export async function createTacticSuggestion(args: {
  finding_key?: string; block_id?: string | null; run_id: string; document_id: string; source_id: string; source_quote: string; target_tactic_id: string;
  expected_tactic_version: string; shared_scope: string; new_scope: string; expansion: ExpansionScope; separate: SeparateTacticOption;
}, representedPriorKeys?: ReadonlySet<string>): Promise<TacticSuggestion> {
  const expansion = expansionScopeSchema.parse(args.expansion), separate = separateTacticOptionSchema.parse(args.separate);
  if (![args.run_id, args.document_id, args.source_quote, args.shared_scope, args.new_scope].every(s => s.trim())) throw new TrustedApplicationError("Overlap requires source lineage, quote, shared and added scope.");
  const source_key = suggestionKey(args.source_id, args.target_tactic_id, args.source_quote, args.block_id, args.finding_key);
  await ensureTacticSuggestionSchema();
  return db().transaction(async tx => {
    // S1 reparsing locks the same source before replacing any blocks.
    const [source] = await tx.select({ id: t.sources.id }).from(t.sources).where(eq(t.sources.id, args.source_id)).for("update");
    if (!source) throw new TrustedApplicationError("Source not found in this workspace.", "not_found", 404);
    const [parentRow] = await tx.select().from(t.tactics).where(eq(t.tactics.id, args.target_tactic_id)).for("update");
    if (!parentRow) throw new TrustedApplicationError("Target tactic not found in this workspace.", "not_found", 404);
    const state = await readState(tx), parent = state.tactics.find(p => p.id === args.target_tactic_id)!;
    if (args.block_id && !quotedBlock(state.blocks.filter(block => block.id === args.block_id && block.source_id === args.source_id), args.source_quote)) {
      throw new TrustedApplicationError("The source passage changed during extraction. Rerun tactic extraction.");
    }
    // A merge can bring together previously distinct suggestions. Keep their
    // histories and return a completed review first when extraction sees one block.
    const [existing] = await tx.select().from(tacticSuggestions).where(eq(tacticSuggestions.source_key, source_key))
      .orderBy(sql`${tacticSuggestions.status} = 'pending'`, tacticSuggestions.created_at, tacticSuggestions.id).limit(1);
    if (existing) return existing.payload as TacticSuggestion;
    const findingKey = args.finding_key;
    if (findingKey) {
      const prior = await tx.select({ payload: tacticSuggestions.payload }).from(tacticSuggestions).where(and(
        eq(tacticSuggestions.target_tactic_id, args.target_tactic_id), eq(tacticSuggestions.source_id, args.source_id),
      ));
      const samePassage = prior.map(record => record.payload as TacticSuggestion).filter(row => quoteKey(row.source_quote) === quoteKey(args.source_quote) && (!row.block_id || row.block_id === args.block_id));
      const reviewed = await reviewedFindings(tx, samePassage, [args]);
      // The exact hash above handles same-run retries. Two current proposals may
      // document different study types for the same question in a single sentence.
      // Legacy reviews lack an exact hash for their finding, so keep reconciling them.
      const previous = [...reviewed].filter(([row]) => row.run_id !== args.run_id || !row.finding_key);
      const labels = (key: string) => previous.filter(([, previousKey]) => previousKey === key)
        .flatMap(([row]) => [row.original_separate.name, row.original_expansion.name]);
      const keys = previous.map(([, key]) => key);
      // S3 holds the parent lock across its batch. Keep earlier questions that
      // the batch already recognised when deciding if this one is additional.
      const represented = keys.filter(key => representedPriorKeys?.has(scopeSourceFinding(key, args.block_id)));
      const matches = reclassifiedFindings([findingKey, ...represented], keys, labels);
      const matchingKeys = new Set(matches.has(findingKey) ? [matches.get(findingKey)] : matchingSourceQuestions(findingKey, keys, labels));
      const matching = previous.filter(([, key]) => matchingKeys.has(key));
      if (matching.length === 1) return matching[0]![0];
      if (matching.length > 1) throw new TrustedApplicationError("Several prior reviews match this source question. Review the original passage before retrying.", "ambiguous_source_finding", 409);
    }
    if (tacticVersion(parent) !== args.expected_tactic_version) throw new TrustedApplicationError("Tactic changed during extraction; rerun to review its current scope.");
    const at = nowIso();
    const row: TacticSuggestion = {...args, expansion, separate, id: newId("TSUG"), reviewed_parent: parent,
      original_expansion: expansion, original_separate: separate, gap_id: null, status: "pending",
      result_expansion_id: null, result_tactic_id: null, history: [], created_at: at, updated_at: at, version: newId("TSV")};
    await tx.insert(tacticSuggestions).values({id: row.id, source_key, target_tactic_id: row.target_tactic_id, source_id: row.source_id, status: row.status, payload: row, created_at: at, updated_at: at});
    return row;
  });
}
/** Review queue includes decided suggestions so rejection memory and history remain visible. */
export async function listTacticSuggestions(): Promise<TacticSuggestion[]> {
  await ensureTacticSuggestionSchema();
  return (await db().select().from(tacticSuggestions).orderBy(desc(tacticSuggestions.created_at))).map(r => r.payload as TacticSuggestion);
}
async function pending(tx: ExpansionTransaction, id: string, expectedVersion?: string) {
  const [stored] = await tx.select().from(tacticSuggestions).where(eq(tacticSuggestions.id, id)).for("update");
  if (!stored) throw new TrustedApplicationError("Tactic suggestion not found in this workspace.", "not_found", 404);
  const row = stored.payload as TacticSuggestion;
  if (stored.status !== "pending" || row.status !== "pending") throw new TrustedApplicationError("Suggestion already decided; refresh to see its history.");
  if (row.id !== stored.id || row.target_tactic_id !== stored.target_tactic_id || row.source_id !== stored.source_id) throw new TrustedApplicationError("Suggestion source lineage is invalid.");
  if (expectedVersion && row.version !== expectedVersion) throw new TrustedApplicationError("Suggestion changed; refresh before reviewing.");
  return row;
}
async function save(tx: ExpansionTransaction, row: TacticSuggestion) {
  await tx.update(tacticSuggestions).set({payload: row, status: row.status, updated_at: row.updated_at}).where(eq(tacticSuggestions.id, row.id));
}
/** Save editable scope/gap before deciding, without silently renewing the reviewed parent snapshot. */
export async function editTacticSuggestion(args: {id: string; gap_id?: string | null; expansion?: ExpansionScope; separate?: SeparateTacticOption; rationale: string; actor: Actor; expected_version?: string}): Promise<TacticSuggestion> {
  const rationale = requireRationale(args.rationale); requireActor(args.actor); await ensureTacticSuggestionSchema();
  return db().transaction(async tx => {
    const row = await pending(tx, args.id, args.expected_version);
    const expansion = args.expansion ? expansionScopeSchema.parse(args.expansion) : row.expansion;
    const separate = args.separate ? separateTacticOptionSchema.parse(args.separate) : row.separate;
    if (separate.status !== row.original_separate.status || separate.type !== row.original_separate.type) throw new TrustedApplicationError("Separate tactic type and lifecycle must retain the documented source values.");
    const gap_id = args.gap_id === undefined ? row.gap_id : args.gap_id || null;
    if (gap_id) {
      const state = await readState(tx);
      if (!state.gaps.some(g => g.id === gap_id && !g.retired && g.status !== "excluded" && !g.parked_at)) throw new TrustedApplicationError("Choose a live gap in this workspace.");
    }
    const at = nowIso(), updated: TacticSuggestion = {...row, expansion, separate, gap_id, updated_at: at, version: newId("TSV"), history: [...row.history, {action: "edit", actor: args.actor, rationale, at, expansion, separate, gap_id}]};
    await save(tx, updated); await appendAudit(args.actor.name, args.actor.function, "tactic_suggestion", row.id, "edit", rationale, tx);
    return updated;
  });
}
/** Lock the real pending source, validate current lineage, and decide with canonical mutation in one transaction. */
export async function decideTacticSuggestion(args: {id: string; decision: "expand" | "separate" | "reject"; rationale: string; actor: Actor; expected_version?: string}): Promise<TacticSuggestion> {
  const rationale = requireRationale(args.rationale); requireActor(args.actor);
  if (!["expand", "separate", "reject"].includes(args.decision)) throw new TrustedApplicationError("Unknown tactic suggestion decision.");
  await ensureTacticSuggestionSchema();
  const updated = await withRelationshipChange({ actor_name: args.actor.name, actor_function: args.actor.function, rationale }, () => db().transaction(async tx => {
    // The source editor locks the source before touching any suggestion rows.
    const owner = tx.select({ source_id: tacticSuggestions.source_id }).from(tacticSuggestions).where(eq(tacticSuggestions.id, args.id));
    const [source] = await tx.select().from(t.sources).where(inArray(t.sources.id, owner)).for("update");
    const row = await pending(tx, args.id, args.expected_version);
    if (!source) throw new TrustedApplicationError("Documented source no longer exists in this workspace.");
    const [parent] = await tx.select().from(t.tactics).where(eq(t.tactics.id, row.target_tactic_id)).for("update");
    if (!parent) throw new TrustedApplicationError("Target tactic no longer exists in this workspace.");
    let blockId = row.block_id;
    if (args.decision !== "reject") {
      const state = await readState(tx);
      const current = state.tactics.find(t => t.id === row.target_tactic_id)!;
      if (tacticVersion(current) !== row.expected_tactic_version) throw new TrustedApplicationError("Tactic changed; reject this obsolete suggestion or review a new source proposal before accepting.");
      if (blockId) {
        const blocks = state.blocks.filter(block => block.source_id === row.source_id);
        blockId = quotedBlock(blocks, row.source_quote, blockId);
        if (!blockId) {
          throw new TrustedApplicationError("The source passage changed or is ambiguous. Rerun tactic extraction before accepting.");
        }
      }
    }
    let result_expansion_id: string | null = null, result_tactic_id: string | null = null;
    if (args.decision === "expand") {
      if (!row.gap_id) throw new TrustedApplicationError("Choose a live gap before accepting the expansion.");
      const [gap] = await tx.select().from(t.gaps).where(eq(t.gaps.id, row.gap_id)).for("update");
      if (!gap || gap.retired || gap.status === "excluded" || gap.parked_at) throw new TrustedApplicationError("Choose a live gap in this workspace before accepting.");
      result_expansion_id = (await acceptTacticExpansion({proposal_id: `s3:${row.id}`, tactic_id: row.target_tactic_id, gap_id: row.gap_id, scope: row.expansion, expected_tactic_version: row.expected_tactic_version, rationale, actor: args.actor}, tx)).id;
      await attachTacticSource({ tactic_id: row.target_tactic_id, source_id: row.source_id, source_quote: row.source_quote, finding_key: row.finding_key, block_id: blockId }, tx);
    } else if (args.decision === "separate") {
      result_tactic_id = await insertLibraryTactic({...row.separate, description: `Separate source activity linked to ${row.target_tactic_id}.`, source_quote: row.source_quote, block_id: blockId, data_source: source.title,
        lifecycle_stage: "extracted", intended_use: `Source ${row.source_id}; related tactic ${row.target_tactic_id}`, actor_name: args.actor.name, actor_function: args.actor.function, audit_action: "accept_source_separate", note: rationale}, tx);
      await attachTacticSource({tactic_id: result_tactic_id, source_id: row.source_id, source_quote: row.source_quote, finding_key: row.finding_key, block_id: blockId}, tx);
    }
    const at = nowIso(), result: TacticSuggestion = {...row, status: args.decision === "expand" ? "expanded" : args.decision === "separate" ? "separate" : "rejected", result_expansion_id, result_tactic_id, updated_at: at, version: newId("TSV"), history: [...row.history, {action: args.decision, actor: args.actor, rationale, at, expansion: row.expansion, separate: row.separate, gap_id: row.gap_id}]};
    await save(tx, result); await appendAudit(args.actor.name, args.actor.function, "tactic_suggestion", row.id, args.decision, rationale, tx);
    return result;
  }));
  // The learning owner uses its own connection only after the source transaction commits.
  await captureTacticSuggestionDecision({suggestion: updated, decision: args.decision, rationale, actor: args.actor});
  return updated;
}
