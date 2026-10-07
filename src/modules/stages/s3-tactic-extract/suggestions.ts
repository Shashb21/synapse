/** S3 source review: immutable model baseline, source provenance and atomic human decisions. */
import { createHash } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db, ensureCurrentSchemaTables } from "@/lib/iegp/db";
import * as t from "@/lib/iegp/schema";
import { appendAudit, insertLibraryTactic, readState } from "@/lib/iegp/store";
import { acceptTacticExpansion, expansionScopeSchema, tacticVersion, type ExpansionTransaction } from "@/lib/iegp/tactic-expansions";
import { ACTOR_FUNCTIONS, TACTIC_STATUSES, TACTIC_TYPES } from "@/lib/iegp/enums";
import type { Actor, ExpansionScope, SeparateTacticOption, TacticSuggestion } from "@/lib/iegp/types";
import { requireRationale } from "@/modules/kernel/edit-records";
import { newId, nowIso } from "@/modules/kernel/ids";
import { captureTacticSuggestionDecision } from "@/lib/iegp/learning-capture";
import { tacticSourceReferences, tacticSuggestions } from "./schema";

export const separateTacticOptionSchema = z.object({name: z.string().trim().min(1), type: z.enum(TACTIC_TYPES), status: z.enum(TACTIC_STATUSES), evidence_question: z.string().trim().min(1)}).strict();
const quoteKey = (quote: string) => quote.toLowerCase().replace(/\s+/g, " ").trim();
function requireActor(actor: Actor) {
  if (!actor?.name?.trim() || !ACTOR_FUNCTIONS.includes(actor.function)) throw new Error("A named actor with a known function is required.");
}
/** Bootstrap before reserving a transaction; never borrow a second reader from inside it. */
export async function ensureTacticSuggestionSchema() { await ensureCurrentSchemaTables(); }
/** Attach an exact source sentence once, leaving all parent fields and locks intact. */
export async function attachTacticSource(args: {tactic_id: string; source_id: string; source_quote: string}, transaction?: ExpansionTransaction) {
  if (!args.source_quote.trim()) throw new Error("Source quote is required.");
  const run = async (tx: ExpansionTransaction) => {
    const [parent] = await tx.select().from(t.tactics).where(eq(t.tactics.id, args.tactic_id)).for("update");
    const [source] = await tx.select().from(t.sources).where(eq(t.sources.id, args.source_id));
    if (!parent || !source) throw new Error("Tactic or source not found in this workspace.");
    await tx.insert(tacticSourceReferences).values({...args, id: newId("TSRC"), quote_key: quoteKey(args.source_quote), created_at: nowIso()}).onConflictDoNothing();
  };
  if (transaction) return run(transaction);
  await ensureTacticSuggestionSchema(); return db().transaction(run);
}
/** List all provenance for a tactic, including multiple documents and sentences. */
export async function listTacticSourceReferences(tacticId: string) {
  await ensureTacticSuggestionSchema();
  return db().select().from(tacticSourceReferences).where(eq(tacticSourceReferences.tactic_id, tacticId));
}
/** Persist one overlap per source sentence and parent; reruns never erase a human decision. */
export async function createTacticSuggestion(args: {
  run_id: string; document_id: string; source_id: string; source_quote: string; target_tactic_id: string;
  expected_tactic_version: string; shared_scope: string; new_scope: string; expansion: ExpansionScope; separate: SeparateTacticOption;
}): Promise<TacticSuggestion> {
  const expansion = expansionScopeSchema.parse(args.expansion), separate = separateTacticOptionSchema.parse(args.separate);
  if (![args.run_id, args.document_id, args.source_quote, args.shared_scope, args.new_scope].every(s => s.trim())) throw new Error("Overlap requires source lineage, quote, shared and added scope.");
  const source_key = createHash("sha256").update(JSON.stringify([args.source_id, args.target_tactic_id, quoteKey(args.source_quote)])).digest("hex");
  await ensureTacticSuggestionSchema();
  return db().transaction(async tx => {
    const [parentRow] = await tx.select().from(t.tactics).where(eq(t.tactics.id, args.target_tactic_id)).for("update");
    if (!parentRow) throw new Error("Target tactic not found in this workspace.");
    const state = await readState(tx), parent = state.tactics.find(p => p.id === args.target_tactic_id)!;
    if (!state.sources.some(s => s.id === args.source_id)) throw new Error("Source not found in this workspace.");
    const [existing] = await tx.select().from(tacticSuggestions).where(eq(tacticSuggestions.source_key, source_key));
    if (existing) return existing.payload as TacticSuggestion;
    if (tacticVersion(parent) !== args.expected_tactic_version) throw new Error("Tactic changed during extraction; rerun to review its current scope.");
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
  if (!stored) throw new Error("Tactic suggestion not found in this workspace.");
  const row = stored.payload as TacticSuggestion;
  if (stored.status !== "pending" || row.status !== "pending") throw new Error("Suggestion already decided; refresh to see its history.");
  if (row.id !== stored.id || row.target_tactic_id !== stored.target_tactic_id || row.source_id !== stored.source_id) throw new Error("Suggestion source lineage is invalid.");
  if (expectedVersion && row.version !== expectedVersion) throw new Error("Suggestion changed; refresh before reviewing.");
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
    if (separate.status !== row.original_separate.status || separate.type !== row.original_separate.type) throw new Error("Separate tactic type and lifecycle must retain the documented source values.");
    const gap_id = args.gap_id === undefined ? row.gap_id : args.gap_id || null;
    if (gap_id) {
      const state = await readState(tx);
      if (!state.gaps.some(g => g.id === gap_id && !g.retired && g.status !== "excluded" && !g.parked_at)) throw new Error("Choose a live gap in this workspace.");
    }
    const at = nowIso(), updated: TacticSuggestion = {...row, expansion, separate, gap_id, updated_at: at, version: newId("TSV"), history: [...row.history, {action: "edit", actor: args.actor, rationale, at, expansion, separate, gap_id}]};
    await save(tx, updated); await appendAudit(args.actor.name, args.actor.function, "tactic_suggestion", row.id, "edit", rationale, tx);
    return updated;
  });
}
/** Lock the real pending source, validate current lineage, and decide with canonical mutation in one transaction. */
export async function decideTacticSuggestion(args: {id: string; decision: "expand" | "separate" | "reject"; rationale: string; actor: Actor; expected_version?: string}): Promise<TacticSuggestion> {
  const rationale = requireRationale(args.rationale); requireActor(args.actor);
  if (!["expand", "separate", "reject"].includes(args.decision)) throw new Error("Unknown tactic suggestion decision.");
  await ensureTacticSuggestionSchema();
  const updated = await db().transaction(async tx => {
    const row = await pending(tx, args.id, args.expected_version);
    const [source] = await tx.select().from(t.sources).where(eq(t.sources.id, row.source_id)).for("update");
    if (!source) throw new Error("Documented source no longer exists in this workspace.");
    const [parent] = await tx.select().from(t.tactics).where(eq(t.tactics.id, row.target_tactic_id)).for("update");
    if (!parent) throw new Error("Target tactic no longer exists in this workspace.");
    if (args.decision !== "reject") {
      const current = (await readState(tx)).tactics.find(t => t.id === row.target_tactic_id)!;
      if (tacticVersion(current) !== row.expected_tactic_version) throw new Error("Tactic changed; refresh the stale review before accepting.");
    }
    let result_expansion_id: string | null = null, result_tactic_id: string | null = null;
    if (args.decision === "expand") {
      if (!row.gap_id) throw new Error("Choose a live gap before accepting the expansion.");
      const [gap] = await tx.select().from(t.gaps).where(eq(t.gaps.id, row.gap_id)).for("update");
      if (!gap || gap.retired || gap.status === "excluded" || gap.parked_at) throw new Error("Choose a live gap in this workspace before accepting.");
      result_expansion_id = (await acceptTacticExpansion({proposal_id: `s3:${row.id}`, tactic_id: row.target_tactic_id, gap_id: row.gap_id, scope: row.expansion, expected_tactic_version: row.expected_tactic_version, rationale, actor: args.actor}, tx)).id;
    } else if (args.decision === "separate") {
      result_tactic_id = await insertLibraryTactic({...row.separate, description: `Separate source activity linked to ${row.target_tactic_id}.`, source_quote: row.source_quote, data_source: source.title,
        lifecycle_stage: "extracted", intended_use: `Source ${row.source_id}; related tactic ${row.target_tactic_id}`, actor_name: args.actor.name, actor_function: args.actor.function, audit_action: "accept_source_separate", note: rationale}, tx);
      await attachTacticSource({tactic_id: result_tactic_id, source_id: row.source_id, source_quote: row.source_quote}, tx);
    }
    const at = nowIso(), result: TacticSuggestion = {...row, status: args.decision === "expand" ? "expanded" : args.decision === "separate" ? "separate" : "rejected", result_expansion_id, result_tactic_id, updated_at: at, version: newId("TSV"), history: [...row.history, {action: args.decision, actor: args.actor, rationale, at, expansion: row.expansion, separate: row.separate, gap_id: row.gap_id}]};
    await save(tx, result); await appendAudit(args.actor.name, args.actor.function, "tactic_suggestion", row.id, args.decision, rationale, tx);
    return result;
  });
  // The learning owner uses its own connection only after the source transaction commits.
  await captureTacticSuggestionDecision({suggestion: updated, decision: args.decision, rationale, actor: args.actor});
  return updated;
}
