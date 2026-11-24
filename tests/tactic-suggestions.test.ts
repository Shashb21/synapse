/** Behavioral source-review tests: arrange stored source/parent, decide, assert durable plan/history. */
import { beforeEach, describe, expect, it } from "vitest";
import { currentSourceFindingKey, sourceFindingKey } from "@/lib/ingest/source-findings";
import { tacticCandidates } from "@/modules/stages/s3-tactic-extract/schema";
import { eq, sql } from "drizzle-orm";
import "@/modules";
import { db } from "@/lib/iegp/db";
import * as t from "@/lib/iegp/schema";
import { buildSeed } from "@/lib/iegp/seed";
import { commitExtractedRecords, createProposedTactic, loadState, persistState } from "@/lib/iegp/store";
import { tacticVersion } from "@/lib/iegp/tactic-expansions";
import type { ExpansionScope } from "@/lib/iegp/types";
import * as suggestions from "@/modules/stages/s3-tactic-extract/suggestions";
import { TrustedApplicationError } from "@/modules/kernel/stage-errors";

const actor = {name: "Source reviewer", function: "medical_affairs" as const};
const scope: ExpansionScope = {name: "Added subgroup analysis", evidence_question: "What is safety in the subgroup?", population: "Subgroup", outcomes: "", geography: "", data_cut: "", analysis: "Post-hoc subgroup analysis", instrument: "", study_design: "Retrospective analysis", gap_coverage: "Subgroup safety", cost_effort: "Two analyst weeks", timing: "Next quarter", feasibility_risks: "Small subgroup", post_hoc: true, prospective_enrolment: false, protocol_amendment: false, start_date: null, evidence_available: null};
let sourceId: string, parentId: string, gapId: string;
async function proposal() {
  const state = await loadState();
  return suggestions.createTacticSuggestion({run_id: "source-run", document_id: "source-document", source_id: sourceId, source_quote: "The registry supports a subgroup analysis.", target_tactic_id: parentId, expected_tactic_version: tacticVersion(state.tactics.find(t => t.id === parentId)!), shared_scope: "Existing registry", new_scope: "Subgroup", expansion: scope, separate: {name: "Independent subgroup analysis", type: "rwe_study", status: "planned", evidence_question: scope.evidence_question}});
}
beforeEach(async () => {
  const state = buildSeed();
  state.tactics[0]!.status = "ongoing";
  state.tactics[0]!.lock = {locked: true, actor_name: actor.name, actor_function: actor.function, locked_at: "2026-10-07", note: "Protocol locked"};
  await persistState(state);
  sourceId = state.sources[0]!.id; parentId = state.tactics[0]!.id; gapId = state.gaps[0]!.id;
  await suggestions.ensureTacticSuggestionSchema();
  await db().delete(tacticCandidates).where(eq(tacticCandidates.run_id, "source-run"));
  await db().execute(sql`DELETE FROM tactic_suggestions`);
  await db().execute(sql`DELETE FROM tactic_source_references`);
});
describe("S3 source matching", () => {
  it("attaches each same source sentence once without replacing design or creating tactics", async () => {
    const before = await loadState();
    const args = {source_id: sourceId, title: "Second source", stakeholder_function: actor.function, actor_name: actor.name, actor_function: actor.function, needs: [], gaps: [], tactics: [{id: "candidate", name: "Duplicate", type: "registry" as const, status: "planned" as const, evidence_question: "Changed question", source_id: sourceId, source_quote: "Same source sentence", duplicate_of: parentId}]};
    await commitExtractedRecords(args); await commitExtractedRecords(args);
    expect((await loadState()).tactics).toEqual(before.tactics);
    const refs = await suggestions.listTacticSourceReferences(parentId);
    expect(refs.filter(r => r.source_quote === "Same source sentence")).toHaveLength(1);
    await commitExtractedRecords({...args, tactics: [{...args.tactics[0]!, source_quote: "Another source sentence"}]});
    expect(await suggestions.listTacticSourceReferences(parentId)).toHaveLength(2);
  });
  it("keeps same-run overlap types separate and reuses each exact review on retry", async () => {
    const parent = (await loadState()).tactics.find(tactic => tactic.id === parentId)!;
    const quote = "A registry and a review will study subgroup safety.";
    const write = (type: "registry" | "slr", run_id: string) => suggestions.createTacticSuggestion({
      run_id, document_id: "document", source_id: sourceId, source_quote: quote, target_tactic_id: parentId,
      finding_key: sourceFindingKey(sourceId, quote, type, scope.evidence_question),
      expected_tactic_version: tacticVersion(parent), shared_scope: "Subgroup safety", new_scope: type, expansion: scope,
      separate: { name: type, type, status: "planned", evidence_question: scope.evidence_question },
    });
    const registry = await write("registry", "initial");
    const review = await write("slr", "initial");
    expect(review.id).not.toBe(registry.id);
    const decision = await suggestions.decideTacticSuggestion({ id: registry.id, decision: "reject", actor, rationale: "Registry declined." });
    expect(await write("registry", "initial")).toEqual(decision);
    expect(await write("registry", "repeat")).toEqual(decision);
    expect(await write("slr", "repeat")).toEqual(review);
    expect(await suggestions.listTacticSuggestions()).toHaveLength(2);
  });

  it.each([true, false])("uses immutable alternatives to recover the reviewed legacy activity (old key %s)", async withOldKey => {
    const row = await proposal();
    const matching = { shared_scope: row.shared_scope, new_scope: row.new_scope, expansion: row.original_expansion, separate: row.original_separate };
    const candidate = { run_id: row.run_id, document_id: row.document_id, source_id: sourceId, source_quote: row.source_quote,
      match: "overlaps", target_tactic_id: parentId, type: "registry", status: "planned", verdict: "accept",
      score: 90, critic_note: "Source supports it", proposer: "llm", created_at: row.created_at, name: "Registry" };
    const original = "What is the safety outcome?", distinct = "What is the cost outcome?";
    await db().insert(tacticCandidates).values([
      { ...candidate, id: "legacy-review-original", evidence_question: original, matching },
      { ...candidate, id: "legacy-review-distinct", evidence_question: distinct, matching: {...matching, new_scope: "Cost"} },
    ]);
    if (withOldKey) {
      const key = sourceFindingKey(sourceId, row.source_quote, candidate.type, original);
      await db().execute(sql`UPDATE tactic_suggestions SET payload = payload || jsonb_build_object('finding_key', ${key}::text) WHERE id = ${row.id}`);
    }
    const edited = await suggestions.editTacticSuggestion({ id: row.id, separate: {...row.separate, name: "Renamed alternative"}, rationale: "Clarify name.", actor });
    const keys = await suggestions.recordedTacticEvidence([sourceId], (await loadState()).tactics);
    expect(keys.get(sourceFindingKey(sourceId, row.source_quote, candidate.type, original, candidate.name))?.owners).toEqual(new Set());
    expect(keys.has(sourceFindingKey(sourceId, row.source_quote, candidate.type, distinct, candidate.name))).toBe(false);
    const repeated = await suggestions.createTacticSuggestion({...row, ...matching, run_id: "new-run",
      finding_key: sourceFindingKey(sourceId, row.source_quote, "slr", original)});
    expect(repeated).toEqual(edited);
  });

  it("protects a rejected legacy overlap whose original candidates have indistinguishable alternatives", async () => {
    const row = await proposal();
    const rejected = await suggestions.decideTacticSuggestion({id: row.id, decision: "reject", actor, rationale: "Declined the overlapping scope."});
    const baseline = {shared_scope: row.shared_scope, new_scope: row.new_scope, expansion: row.original_expansion, separate: row.original_separate};
    const candidate = {run_id: row.run_id, document_id: row.document_id, source_id: sourceId, source_quote: row.source_quote,
      match: "overlaps", target_tactic_id: parentId, type: "registry", status: "planned", verdict: "accept", score: 90,
      critic_note: "Source supports it", proposer: "llm", created_at: row.created_at, name: "Rowan registry", matching: baseline};
    const originals = ["What is survival?", "What is cost?"].map((evidence_question, i) => ({...candidate, id: "ambiguous-" + i, evidence_question}));
    await db().insert(tacticCandidates).values(originals);
    const current = {...originals[0]!, run_id: "repeat", type: "slr"};
    const state = await loadState();
    await expect(suggestions.recordedTacticEvidence([sourceId], state.tactics, [{...current, source_quote: "Unrelated passage."}])).resolves.toBeInstanceOf(Map);
    await expect(suggestions.recordedTacticEvidence([sourceId], state.tactics, [current])).rejects.toThrow(/legacy review/);
    const key = sourceFindingKey(sourceId, row.source_quote, current.type, current.evidence_question);
    await expect(suggestions.createTacticSuggestion({...row, ...baseline, run_id: "repeat", finding_key: key}))
      .rejects.toThrow(/legacy review/);
    expect(await suggestions.listTacticSuggestions()).toEqual([rejected]);
  });

  it("keeps the legacy parent question when attaching a different finding to the same source reference", async () => {
    const state = await loadState(), parent = state.tactics.find(t => t.id === parentId)!;
    const quote = "The Rowan registry addresses both questions.";
    const reference = {tactic_id: parentId, source_id: sourceId, source_quote: quote};
    await suggestions.attachTacticSource(reference);
    await db().execute(sql`UPDATE tactic_source_references SET finding_keys = '[]'::jsonb WHERE tactic_id = ${parentId}`);
    const original = sourceFindingKey(sourceId, quote, parent.type, parent.evidence_question, parent.name);
    const extra = sourceFindingKey(sourceId, quote, parent.type, "What is the separate economic outcome?");
    await suggestions.attachTacticSource({...reference, finding_key: extra});
    const keys = await suggestions.recordedTacticEvidence([sourceId], state.tactics);
    expect(keys.has(original)).toBe(true);
    expect(keys.has(currentSourceFindingKey(extra, parent.name))).toBe(true);
  });

  it("keeps overlaps pending with no unreviewed plan mutation and retains rejected reruns", async () => {
    const before = await loadState(); const row = await proposal();
    expect(row.status).toBe("pending"); expect(await loadState()).toEqual(before);
    await suggestions.decideTacticSuggestion({id: row.id, decision: "reject", rationale: "Unsupported subgroup", actor});
    const repeated = await proposal(); expect(repeated.id).toBe(row.id); expect(repeated.status).toBe("rejected");
  });
  it("expands atomically into proposed noncounting child, preserving locked parent and coverage", async () => {
    const row = await proposal();
    await suggestions.editTacticSuggestion({id: row.id, gap_id: gapId, expansion: {...scope, name: "Reviewed subgroup"}, rationale: "Reviewed scope wording", actor});
    const before = await loadState();
    const result = await suggestions.decideTacticSuggestion({id: row.id, decision: "expand", rationale: "Feasible addition", actor});
    const after = await loadState();
    expect(after.tactics).toEqual(before.tactics); expect(after.coverages.filter(c => !c.expansion_id)).toEqual(before.coverages);
    expect(after.expansions).toHaveLength(1); expect(after.expansions[0]).toMatchObject({id: result.result_expansion_id, status: "proposed", scope: {name: "Reviewed subgroup"}});
    expect(after.expansions[0].scope.type).toBeUndefined(); // Separate-alternative type is not child evidence.
    expect(result.original_expansion.name).toBe(scope.name); expect(result.history).toHaveLength(2);
    await expect(suggestions.decideTacticSuggestion({id: row.id, decision: "expand", rationale: "Retry", actor})).rejects.toThrow(/already decided/);
    expect((await loadState()).expansions).toHaveLength(1);
  });
  it("creates a linked separate tactic with source-supported lifecycle and quote", async () => {
    const row = await proposal(); const before = await loadState();
    const result = await suggestions.decideTacticSuggestion({id: row.id, decision: "separate", rationale: "Different independent activity", actor});
    const after = await loadState(); expect(after.tactics).toHaveLength(before.tactics.length + 1);
    expect(after.tactics.find(t => t.id === result.result_tactic_id)).toMatchObject({name: row.separate.name, status: "planned", source_quote: row.source_quote});
    expect(after.tactics.find(t => t.id === parentId)).toEqual(before.tactics.find(t => t.id === parentId));
  });
  it("keeps ordinary creation working after actual separate-source acceptance",async()=>{
    const row=await proposal();
    const accepted=await suggestions.decideTacticSuggestion({id:row.id,decision:'separate',rationale:'Distinct source activity',actor});
    const canonical=(await loadState()).tactics.find(t=>t.id===accepted.result_tactic_id);
    const ids:string[]=[];
    for(const name of ['Ordinary first','Ordinary second']) ids.push(await createProposedTactic({name,type:'rwe_study',description:'Manual',evidence_question:'Q',population:'Adults',intervention:'Asset',comparator:'SOC',outcomes:'Safety',owner:actor.name,function:actor.function,residual_ids:[],actor_name:actor.name,actor_function:actor.function}));
    expect(new Set([accepted.result_tactic_id,...ids]).size).toBe(3);
    expect((await loadState()).tactics.find(t=>t.id===accepted.result_tactic_id)).toEqual(canonical);
  });
  it.each(["expand", "separate", "reject"] as const)("requires rationale before %s", async decision => {
    const row = await proposal(); await expect(suggestions.decideTacticSuggestion({id: row.id, decision, rationale: "", actor})).rejects.toThrow(/rationale/i);
    expect((await suggestions.listTacticSuggestions())[0]!.status).toBe("pending");
  });
  it("refuses stale parent snapshot instead of computing a fresh acceptance version", async () => {
    const row = await proposal(); await suggestions.editTacticSuggestion({id: row.id, gap_id: gapId, rationale: "Select gap", actor});
    await db().update(t.tactics).set({evidence_question: "Human changed question"}).where(eq(t.tactics.id, parentId));
    await expect(suggestions.decideTacticSuggestion({id: row.id, decision: "expand", rationale: "Accept addition", actor})).rejects.toThrow(/reject this obsolete suggestion or review a new source proposal/i);
    const {POST}=await import('@/app/api/plan/route');
    const current=(await suggestions.listTacticSuggestions()).find(p=>p.id===row.id)!;
    const response=await POST(new Request('http://localhost/api/plan',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'decide_tactic_suggestion',suggestion_id:row.id,decision:'expand',expected_version:current.version,rationale:'Accept addition',actor_name:actor.name,actor_function:actor.function})}));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/reject this obsolete suggestion or review a new source proposal/i);
    expect((await loadState()).expansions).toHaveLength(0); expect((await suggestions.listTacticSuggestions())[0]!.status).toBe("pending");
  });
  it("rejects missing source, target, gap and arbitrary suggestion IDs without partial mutations", async () => {
    const row = await proposal(); await expect(suggestions.decideTacticSuggestion({id: "arbitrary", decision: "expand", rationale: "Valid rationale", actor})).rejects.toThrow(/not found/);
    await expect(suggestions.decideTacticSuggestion({id: row.id, decision: "expand", rationale: "Valid rationale", actor})).rejects.toThrow(/gap/i);
    await db().delete(t.sources).where(eq(t.sources.id, sourceId));
    await expect(suggestions.decideTacticSuggestion({id: row.id, decision: "separate", rationale: "Valid rationale", actor})).rejects.toThrow(/source/i);
    expect((await loadState()).expansions).toHaveLength(0);
  });
  it("serializes concurrent decisions into one outcome and one child", async () => {
    const row = await proposal(); await suggestions.editTacticSuggestion({id: row.id, gap_id: gapId, rationale: "Select gap", actor});
    const results = await Promise.allSettled([1,2].map(() => suggestions.decideTacticSuggestion({id: row.id, decision: "expand", rationale: "Accept addition", actor})));
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1); expect((await loadState()).expansions).toHaveLength(1);
  });
  it("refuses expansion into a gap parked after review", async () => {
    const row = await proposal(); await suggestions.editTacticSuggestion({id: row.id, gap_id: gapId, rationale: "Select gap", actor});
    await db().update(t.gaps).set({parked_at: "2026-10-07"}).where(eq(t.gaps.id, gapId));
    await expect(suggestions.decideTacticSuggestion({id: row.id, decision: "expand", rationale: "Accept scope", actor})).rejects.toThrow(/live gap/i);
    expect((await loadState()).expansions).toHaveLength(0);
  });
  it("refuses stale separate review and accepts rejection without renewing the parent snapshot", async () => {
    const row = await proposal();
    await db().update(t.tactics).set({study_design: "New human protocol"}).where(eq(t.tactics.id, parentId));
    await expect(suggestions.decideTacticSuggestion({id: row.id, decision: "separate", rationale: "Accept independent", actor})).rejects.toThrow(/reject this obsolete suggestion or review a new source proposal/i);
    const result = await suggestions.decideTacticSuggestion({id: row.id, decision: "reject", rationale: "Review obsolete", actor});
    expect(result.expected_tactic_version).toBe(row.expected_tactic_version);
  });

  it("rolls back child, coverage and audit if source-decision persistence fails", async () => {
    const row = await proposal(); await suggestions.editTacticSuggestion({id: row.id, gap_id: gapId, rationale: "Select gap", actor});
    const before = await loadState();
    await db().execute(sql`CREATE FUNCTION fail_source_decision() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status = 'expanded' THEN RAISE EXCEPTION 'injected source failure'; END IF; RETURN NEW; END $$`);
    await db().execute(sql`CREATE TRIGGER fail_source_decision BEFORE UPDATE ON tactic_suggestions FOR EACH ROW EXECUTE FUNCTION fail_source_decision()`);
    try {
      const action = suggestions.decideTacticSuggestion({id: row.id, decision: "expand", rationale: "Accept addition", actor});
      await expect(action).rejects.toBeInstanceOf(TrustedApplicationError);
      await expect(action).rejects.toMatchObject({
        code: "invalid_request", status: 400,
        message: "Could not save the relationship and its history. Keep your input and reason, and check the relationship before trying again.",
      });
      await expect(action).rejects.not.toHaveProperty("cause");
      expect(await loadState()).toEqual(before); expect((await suggestions.listTacticSuggestions())[0]!.status).toBe("pending");
    } finally {
      await db().execute(sql`DROP TRIGGER fail_source_decision ON tactic_suggestions`); await db().execute(sql`DROP FUNCTION fail_source_decision()`);
    }
  });
  it("refuses stale suggestion edit/decision versions and preserves original source lifecycle", async () => {
    const row = await proposal();
    await suggestions.editTacticSuggestion({id: row.id, expansion: {...scope, name: "Human edited"}, rationale: "Source checked", actor, expected_version: row.version});
    await expect(suggestions.editTacticSuggestion({id: row.id, expansion: scope, rationale: "Stale form", actor, expected_version: row.version})).rejects.toThrow(/changed/);
    await expect(suggestions.decideTacticSuggestion({id: row.id, decision: "reject", rationale: "Stale form", actor, expected_version: row.version})).rejects.toThrow(/changed/);
    await expect(suggestions.editTacticSuggestion({id: row.id, separate: {...row.separate, status: "ongoing"}, rationale: "Invented commitment", actor})).rejects.toThrow(/lifecycle/);
    expect((await suggestions.listTacticSuggestions())[0]!.original_expansion.name).toBe(scope.name);
  });

  it("records the original options and human final once in the shared learning log", async () => {
    const {listDecisionExamples} = await import("@/modules/kernel/decision-examples");
    const row = await proposal();
    await suggestions.editTacticSuggestion({id: row.id, separate: {...row.separate, name: "Human-reviewed separate"}, rationale: "Source wording corrected", actor});
    await suggestions.decideTacticSuggestion({id: row.id, decision: "separate", rationale: "Independent source activity", actor});
    await expect(suggestions.decideTacticSuggestion({id: row.id, decision: "separate", rationale: "Duplicate click", actor})).rejects.toThrow(/already decided/);
    const examples = (await listDecisionExamples({stage: "S3", kinds: ["tactic_suggestion"], workspace_id: "default"})).filter(e => e.subject_id === row.id);
    expect(examples).toHaveLength(1); expect(examples[0]).toMatchObject({outcome: "edited", actor, ai_output: {separate: row.original_separate}, final: {decision: "separate", separate: {name: "Human-reviewed separate"}}});
  });

  it("preserves legacy blank quote behavior without inventing a source sentence", async () => {
    const before = await loadState();
    const result = await commitExtractedRecords({source_id: sourceId, title: "Legacy extraction", stakeholder_function: actor.function, actor_name: actor.name, actor_function: actor.function, needs: [], gaps: [], tactics: [{id: "legacy", name: "Legacy documented tactic", type: "rwe_study", status: "planned", evidence_question: "Legacy question", source_id: sourceId, source_quote: "", duplicate_of: null}]});
    expect((await loadState()).tactics).toHaveLength(before.tactics.length + 1);
    expect(await suggestions.listTacticSourceReferences(result.tactic_ids[0]!)).toEqual([]);
  });

});
