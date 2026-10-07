/** Shared production/experiment paging. Only the inference callback runs outside transactions. */
import { and, eq, inArray } from "drizzle-orm";
import { newId } from "@/modules/kernel/ids";
import { buildSourcePages, sourceHash, sourcePromptBudget, locatePageEvidence, resolveSourcePage, sourceEntityIdentities, type SourceProgress } from "../domain/source-pages";
import { emptyGapStructuredFields, emptyTacticStructuredFields, readStructuredFields, mergeStructuredFields, validateFieldEvidence, type RejectedCandidate } from "../domain/structured-fields";
import type { ParseBlock } from "./quote-validator";
import type { NeedExtractOutput } from "../modules/need-extract/module";
import type { InventoryExtractOutput } from "../modules/inventory-extract/module";
import type { AccuracyRunResult } from "../kernel/run";
import { siThemeFromGapId } from "../domain/ledger-filters";
import { identityKeys, normalizeStatement, packsMayMerge } from "../modules/merge-dedupe/engine";
import { claimToMergeCandidate } from "../modules/merge-dedupe/module";
import { claimMetadata, insertClaim, listActiveSourceClaims, persistClaimPatch, type AccuracyClaimMetadata } from "./claim-store";
import { humanLockedFields, preserveHumanLocks } from "./claim-edit";
import { accuracyDb, accuracyTransactionActive } from "./db";
import * as t from "./schema";
import { applyExtractionPage, createExtractionBatch, currentSourceRevision, ExtractionBatchError, getExtractionBatch, parseSourceCursor, refreshSourceProgress, reserveExtractionPage, type ExtractionBatch } from "./extraction-batch-store";

export type SourceExtractKind = "need_extract" | "inventory_extract";
export type SourceExtractOutput = NeedExtractOutput | InventoryExtractOutput;
export type SourceExtractionRun = { call_kind: string; run_id: string; summary: string; count: number; rejected_candidates?: RejectedCandidate[] };

/** Stable identity is stored separately from editable model/human facts. Never match statement alone. */
function entityIdentity(draft: Parameters<typeof insertClaim>[0]): string {
  const metadata = draft.metadata!;
  if (typeof metadata.external_id === "string" && metadata.external_id.trim()) return sourceHash([draft.claim_type, "external", metadata.external_id.trim().toLowerCase()]);
  const structured = metadata.structured;
  const context = draft.claim_type === "gap" && structured && "indication" in structured
    ? [structured.indication, structured.disease_setting].map(field => field.state === "known" ? field.value.trim().toLowerCase() : null) : [];
  const provenance = (Array.isArray(metadata.provenance) ? metadata.provenance : []).map(span => span).sort((a, b) => sourceHash(a).localeCompare(sourceHash(b)));
  return sourceHash([draft.claim_type, normalizeStatement(draft.statement), provenance, metadata.type ?? null, context]);
}

async function upsertSourceDraft(draft: Parameters<typeof insertClaim>[0], revision: string, identity: string) {
  const active = await listActiveSourceClaims(draft.workspace_id, draft.source_file_id!, { for_update: true });
  let matches = active.filter(c => sourceEntityIdentities(claimMetadata(c)).some(alias => alias.source_revision === revision && alias.identity === identity) && c.claim_type === draft.claim_type);
  if (!matches.length) {
    // Reuse the existing merge owner's strong identities for cross-revision source matching.
    const packBySource = new Map([[draft.source_file_id!, String(draft.metadata?.reference_pack_id ?? "") || null]]);
    const candidate = claimToMergeCandidate({ ...draft, id: draft.id!, status: draft.status ?? "draft", validated: false, source_file_id: draft.source_file_id!, metadata: draft.metadata!, created_at: "", updated_at: "" }, packBySource);
    const keys = new Set(identityKeys(candidate));
    if (keys.size) matches = active.filter(c => c.claim_type === draft.claim_type && claimMetadata(c).extraction_source_revision !== revision
      && packsMayMerge(candidate, claimToMergeCandidate(c, packBySource)) && identityKeys(claimToMergeCandidate(c, packBySource)).some(key => keys.has(key)));
  }
  if (matches.length > 1) throw new Error("ambiguous_source_identity");
  const existing = matches[0];
  const modelMetadata: AccuracyClaimMetadata = { ...draft.metadata, extraction_source_revision: revision, extraction_identity: identity };
  if (!existing) return (await insertClaim({ ...draft, metadata: modelMetadata })).id;
  const previous = claimMetadata(existing);
  const sameRevision = sourceEntityIdentities(previous).some(alias => alias.source_revision === revision);
  const combined: AccuracyClaimMetadata = { ...previous, ...modelMetadata };
  if (sameRevision) {
    const spans = [...(Array.isArray(previous.provenance) ? previous.provenance : []), ...(Array.isArray(modelMetadata.provenance) ? modelMetadata.provenance : [])];
    combined.provenance = [...new Map(spans.map(span => [sourceHash(span), span])).values()];
    combined.structured = mergeStructuredFields(readStructuredFields(existing), [modelMetadata.structured!]);
  }
  const next = preserveHumanLocks(previous, combined);
  const locked = humanLockedFields(previous);
  const lifecycleLocked = locked.includes("tactic_status") || locked.includes("structured.lifecycle");
  // Human lifecycle edits may deliberately leave field evidence unknown; their mirrors take precedence.
  if (draft.claim_type === "tactic" && !lifecycleLocked && next.structured && "lifecycle" in next.structured) {
    next.tactic_status = next.structured.lifecycle.state === "known" ? next.structured.lifecycle.value : "unknown";
  }
  const statement = locked.includes("statement") ? existing.statement : draft.statement;
  const status = existing.validated || lifecycleLocked ? existing.status : draft.claim_type === "tactic" ? String(next.tactic_status) : draft.status;
  // Retain conflicting inference for review without changing human-locked facts or validation tokens.
  if (statement !== draft.statement || Object.keys(modelMetadata).some(key => (key !== "provenance" || locked.includes("provenance")) && sourceHash(next[key]) !== sourceHash(modelMetadata[key]))) {
    const suggestions = Array.isArray(previous.extraction_suggestions) ? [...previous.extraction_suggestions] : [];
    const suggestion = { source_revision: revision, identity, statement: draft.statement, structured: modelMetadata.structured, tactic_status: modelMetadata.tactic_status ?? null, metadata: modelMetadata };
    if (!suggestions.some(s => sourceHash(s) === sourceHash(suggestion))) suggestions.push(suggestion);
    next.extraction_suggestions = suggestions;
  }
  return (await persistClaimPatch({ workspace_id: draft.workspace_id, claim_id: existing.id, statement, status, metadata: next })).id;
}

/** Extract all remaining declared pages; on failure return the retained checkpoint and cursor. */
export async function extractSourcePages(args: {
  workspace_id: string; source_file_id: string; kinds: SourceExtractKind[]; block_ids?: string[]; cursor?: string;
  run: (kind: SourceExtractKind, input: Record<string, unknown>, run_id: string) => Promise<AccuracyRunResult<SourceExtractOutput>>;
}): Promise<{ batch: ExtractionBatch; runs: SourceExtractionRun[]; failure?: unknown }> {
  if (accuracyTransactionActive()) throw new Error("Source extraction must start outside every Accuracy transaction.");
  const snapshot = await currentSourceRevision(args.workspace_id, args.source_file_id);
  if (!snapshot.blocks.length) throw new Error("No parse blocks for this source — upload/re-parse before extracting.");
  const kinds = [...new Set(args.kinds)];
  if (!kinds.length || kinds.some(k => k !== "need_extract" && k !== "inventory_extract")) throw new Error("Invalid extraction kinds.");
  if (args.block_ids && (!args.block_ids.length || new Set(args.block_ids).size !== args.block_ids.length || args.block_ids.some(id => !snapshot.blocks.some(b => b.id === id)))) throw new Error("block_ids must be unique original blocks from this workspace/source.");
  let batch: ExtractionBatch;
  if (args.cursor) {
    const [batch_id, page_id] = parseSourceCursor(args.cursor);
    batch = await getExtractionBatch(args.workspace_id, args.source_file_id, batch_id);
    const progress = batch.source_progress;
    if (!progress || progress.source_revision !== snapshot.revision || !progress.pages.some(p => p.id === page_id)
      || sourceHash([...batch.requested_kinds].sort()) !== sourceHash([...kinds].sort())
      || (args.block_ids && sourceHash([...args.block_ids].sort()) !== sourceHash([...progress.block_ids].sort()))) throw new ExtractionBatchError("stale_batch", "Cursor does not match the source revision or declared selection.");
  } else {
    const selected = args.block_ids ? snapshot.blocks.filter(b => args.block_ids!.includes(b.id)) : snapshot.blocks;
    const budget = sourcePromptBudget();
    const pages = buildSourcePages(selected as ParseBlock[], budget);
    const progress: SourceProgress = { version: 1, source_revision: snapshot.revision, selection_scope: args.block_ids ? "selected" : "all",
      block_ids: selected.map(b => b.id), expected_blocks: selected.length, expected_units: pages.reduce((sum, p) => sum + p.units.length * kinds.length, 0),
      processed_units: 0, failed_units: 0, budget, complete: false, full_source_complete: false, next_cursor: null,
      upstream_dropped_units: snapshot.dropped.map(d => ({ id: d.id, location: d.location, reason: d.reason, text: d.text })),
      pages: pages.map(p => ({ id: p.id, index: p.index, units: p.units.map(({ block_id, char_start, char_end }) => ({ block_id, char_start, char_end })),
        attempts: Object.fromEntries(kinds.map(k => [k, { state: "pending" as const }])) })) };
    batch = await createExtractionBatch(args.workspace_id, args.source_file_id, kinds, progress);
  }
  let failure: unknown;
  outer: for (const page of batch.source_progress!.pages) {
    for (const kind of kinds) {
      const run_id = newId("arun");
      const token = await reserveExtractionPage({ ...args, batch_id: batch.id, page_id: page.id, kind, run_id });
      if (!token) continue;
      const input = { workspace_id: args.workspace_id, source_file_id: args.source_file_id, block_ids: page.units.map(u => u.block_id), source_page: { id: page.id, units: page.units } };
      try {
        const result = await args.run(kind, input, run_id);
        const output = result.output;
        if ((kind === "need_extract") !== ("gaps" in output) || output.workspace_id !== args.workspace_id || output.source_file_id !== args.source_file_id) throw new Error("Extractor output source/workspace mismatch.");
        const rejected = [...(output.rejected_candidates ?? [])];
        const drafts: Parameters<typeof insertClaim>[0][] = "gaps" in output ? output.gaps.map(g => ({ id: g.id, workspace_id: args.workspace_id, source_file_id: args.source_file_id,
          claim_type: "gap", statement: g.statement, status: "draft", metadata: { origin: "need_extract", source_badge: "extract", external_id: g.external_id,
            si_theme: siThemeFromGapId(g.external_id)?.slug ?? null, provenance: g.provenance, structured: g.structured ?? emptyGapStructuredFields(), reference_pack_id: snapshot.source.reference_pack_id } }))
          : output.tactics.map(tactic => ({ id: tactic.id, workspace_id: args.workspace_id, source_file_id: args.source_file_id, claim_type: "tactic", statement: tactic.name, status: tactic.status,
            metadata: { origin: "inventory", source_badge: "extract", external_id: tactic.external_id ?? null, type: tactic.type, evidence_question: tactic.evidence_question, provenance: tactic.provenance,
              structured: tactic.structured ?? emptyTacticStructuredFields(), tactic_status: tactic.status, reference_pack_id: snapshot.source.reference_pack_id } }));
        const invalid = new Set<number>();
        const slices = resolveSourcePage(snapshot.blocks, { id: page.id, units: page.units });
        for (const [index, draft] of drafts.entries()) {
          try {
            draft.metadata = locatePageEvidence(draft.metadata!, slices);
            const error = validateFieldEvidence({ structured: draft.metadata.structured!, provenance: draft.metadata.provenance as Parameters<typeof validateFieldEvidence>[0]["provenance"],
              source_file_id: args.source_file_id, blocks: slices });
            if (error) { rejected.push({ index, ...error }); invalid.add(index); }
          } catch (error) { rejected.push({ index, field: "provenance", reason: error instanceof Error ? error.message : "invalid_page_evidence" }); invalid.add(index); }
        }
        const identities = drafts.map(entityIdentity);
        const accepted = drafts.flatMap((draft, index) => {
          if (invalid.has(index)) return [];
          if (identities.filter(key => key === identities[index]).length > 1) { rejected.push({ index, field: "identity", reason: "ambiguous_source_identity" }); return []; }
          return [{ draft, identity: identities[index], index }];
        });
        const complete = output.source_complete !== false && rejected.length === 0;
        batch = await applyExtractionPage({ ...args, batch_id: batch.id, page_id: page.id, kind, token, run_id: result.run_id, complete, rejected_candidates: rejected,
          persist: async () => {
            const ids: string[] = [];
            for (const item of accepted) ids.push(await upsertSourceDraft(item.draft, snapshot.revision, item.identity));
            const persistedOutput = "gaps" in output ? { ...output, gaps: accepted.map((a, i) => ({ ...output.gaps[a.index], provenance: a.draft.metadata!.provenance, structured: a.draft.metadata!.structured, id: ids[i] })), rejected_candidates: rejected }
              : { ...output, tactics: accepted.map((a, i) => ({ ...output.tactics[a.index], provenance: a.draft.metadata!.provenance, structured: a.draft.metadata!.structured, id: ids[i] })), rejected_candidates: rejected };
            await accuracyDb().update(t.accuracyModuleRuns).set({ output: persistedOutput }).where(and(eq(t.accuracyModuleRuns.workspace_id, args.workspace_id), eq(t.accuracyModuleRuns.id, result.run_id)));
            return ids;
          } });
        if (!complete) break outer;
      } catch (error) {
        failure = error;
        batch = await applyExtractionPage({ ...args, batch_id: batch.id, page_id: page.id, kind, token, run_id, complete: false,
          error: error instanceof Error ? error.message : String(error) });
        break outer;
      }
    }
  }
  batch = await getExtractionBatch(args.workspace_id, args.source_file_id, batch.id);
  // Empty/still-pending batches also expose a server-generated cursor.
  batch.source_progress = refreshSourceProgress(batch.id, batch.source_progress!);
  const rows = await accuracyDb().select().from(t.accuracyModuleRuns).where(and(eq(t.accuracyModuleRuns.workspace_id, args.workspace_id), inArray(t.accuracyModuleRuns.id, batch.run_ids)));
  const runs = batch.run_ids.map(id => {
    const row = rows.find(r => r.id === id)!;
    const output = row.output as SourceExtractOutput;
    return { call_kind: row.call_kind, run_id: id, summary: row.summary ?? "", count: "gaps" in output ? output.gaps.length : output.tactics.length,
      ...(output.rejected_candidates?.length ? { rejected_candidates: output.rejected_candidates } : {}) };
  });
  return { batch, runs, ...(failure ? { failure } : {}) };
}


/** Return the current ledger IDs after the existing merge owner absorbs source entities. */
export function resolvedExtractionClaimIds(ids: string[], merges: { duplicate_id: string; survivor_id: string }[] = []): string[] {
  const absorbed = new Map(merges.map(merge => [merge.duplicate_id, merge.survivor_id]));
  return [...new Set(ids.map(id => {
    const seen = new Set<string>();
    while (absorbed.has(id) && !seen.has(id)) { seen.add(id); id = absorbed.get(id)!; }
    return id;
  }))];
}
