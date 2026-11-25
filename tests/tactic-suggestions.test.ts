/** Behavioral source-review tests: arrange stored source/parent, decide, assert durable plan/history. */
import { beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import "@/modules";
import { db } from "@/lib/iegp/db";
import * as t from "@/lib/iegp/schema";
import { buildSeed } from "@/lib/iegp/seed";
import { commitExtractedRecords, createProposedTactic, loadState, persistSourceAndBlocks, persistState } from "@/lib/iegp/store";
import { deleteSourceBlock, mergeSourceBlocks, reparseSourceBlocks, splitSourceBlock } from "@/lib/iegp/source-blocks";
import { tacticVersion } from "@/lib/iegp/tactic-expansions";
import type { ExpansionScope, TacticSuggestion } from "@/lib/iegp/types";
import * as suggestions from "@/modules/stages/s3-tactic-extract/suggestions";
import { editSourceBlock, SourceQuoteConflictError } from "@/lib/iegp/source-blocks";
import { tacticSourceReferences } from "@/modules/stages/s3-tactic-extract/schema";
import { TrustedApplicationError } from "@/modules/kernel/stage-errors";

const actor = {name: "Source reviewer", function: "medical_affairs" as const};
const scope: ExpansionScope = {name: "Added subgroup analysis", evidence_question: "What is safety in the subgroup?", population: "Subgroup", outcomes: "", geography: "", data_cut: "", analysis: "Post-hoc subgroup analysis", instrument: "", study_design: "Retrospective analysis", gap_coverage: "Subgroup safety", cost_effort: "Two analyst weeks", timing: "Next quarter", feasibility_risks: "Small subgroup", post_hoc: true, prospective_enrolment: false, protocol_amendment: false, start_date: null, evidence_available: null};
let sourceId: string, parentId: string, gapId: string;
const sourceQuote = "The registry supports a subgroup analysis.";
async function proposal(input: string | { source_quote?: string; block_id?: string } = {}) {
  const citation = typeof input === "string" ? { block_id: input } : input;
  const state = await loadState();
  return suggestions.createTacticSuggestion({run_id: "source-run", document_id: "source-document", source_id: sourceId, source_quote: sourceQuote, target_tactic_id: parentId, expected_tactic_version: tacticVersion(state.tactics.find(t => t.id === parentId)!), shared_scope: "Existing registry", new_scope: "Subgroup", expansion: scope, separate: {name: "Independent subgroup analysis", type: "rwe_study", status: "planned", evidence_question: scope.evidence_question}, ...citation});
}
beforeEach(async () => {
  const state = buildSeed();
  state.tactics[0]!.status = "ongoing";
  state.tactics[0]!.lock = {locked: true, actor_name: actor.name, actor_function: actor.function, locked_at: "2026-10-07", note: "Protocol locked"};
  await persistState(state);
  sourceId = state.sources[0]!.id; parentId = state.tactics[0]!.id; gapId = state.gaps[0]!.id;
  await suggestions.ensureTacticSuggestionSchema();
  await db().insert(t.sourceBlocks).values({ id: "fictional-subgroup", source_id: sourceId, heading: "Analysis", location: "p.1", text: sourceQuote });
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
  it("retains distinct case-sensitive passages on the same tactic and source block", async () => {
    const upper = "Marker X was measured.";
    const lower = "Marker x was measured.";
    const block = { id: "marker-analysis", source_id: sourceId, heading: "Biomarkers", location: "p.2", text: `${upper} ${lower}` };
    await db().insert(t.sourceBlocks).values(block);
    const first = await proposal({ block_id: block.id, source_quote: upper });
    await suggestions.decideTacticSuggestion({ id: first.id, decision: "reject", rationale: "Earlier passage reviewed", actor });
    const second = await proposal({ block_id: block.id, source_quote: lower });
    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe("pending");
    expect((await proposal({ block_id: block.id, source_quote: upper })).status).toBe("rejected");
    expect((await proposal({ block_id: block.id, source_quote: lower })).id).toBe(second.id);
    await suggestions.decideTacticSuggestion({ id: second.id, decision: "reject", rationale: "Both reviews completed", actor });

    for (const source_quote of [upper, lower, "Marker  X\nwas measured.", lower]) {
      await suggestions.attachTacticSource({ tactic_id: parentId, source_id: sourceId, block_id: block.id, source_quote });
    }
    expect((await suggestions.listTacticSourceReferences(parentId)).map(row => row.source_quote).sort()).toEqual([upper, lower]);
    await expect(editSourceBlock({ block_id: block.id, text: upper, rationale: "Remove the other marker", actor }))
      .rejects.toBeInstanceOf(SourceQuoteConflictError);
  });

  it.each([false, true])("reconciles a historical reference with an unambiguous passage and preserves its ID (stored block %s)", async hasBlock => {
    const location = { source_id: sourceId, source_quote: sourceQuote };
    await db().insert(tacticSourceReferences).values({
      ...location, tactic_id: parentId, block_id: hasBlock ? "fictional-subgroup" : null,
      id: "old-source-reference", quote_key: sourceQuote.toLowerCase(), created_at: "2026-10-07",
    });
    for (let rerun = 0; rerun < 2; rerun++) {
      await suggestions.attachTacticSource({ ...location, tactic_id: parentId, block_id: "fictional-subgroup" });
    }
    expect(await suggestions.listTacticSourceReferences(parentId)).toMatchObject([{
      id: "old-source-reference", block_id: "fictional-subgroup", source_quote: sourceQuote,
      source_context: { heading: "Analysis", location: "p.1" },
    }]);
  });

  it("leaves a legacy reference unassigned when the passage appears in two blocks", async () => {
    await suggestions.attachTacticSource({ tactic_id: parentId, source_id: sourceId, source_quote: sourceQuote });
    const [original] = await suggestions.listTacticSourceReferences(parentId);
    await db().insert(t.sourceBlocks).values({ id: "second-subgroup", source_id: sourceId, heading: "Other analysis", location: "p.2", text: sourceQuote });
    await suggestions.attachTacticSource({ tactic_id: parentId, source_id: sourceId, source_quote: sourceQuote, block_id: "fictional-subgroup" });
    expect(await suggestions.listTacticSourceReferences(parentId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: original!.id, block_id: null }),
      expect.objectContaining({ block_id: "fictional-subgroup" }),
    ]));
  });

  it("retains the cited block and a single reference for a same tactic after reparse", async () => {
    const cited = { heading: "Registry", text: sourceQuote, location: "Section 1" };
    const other = { heading: "Background", text: "Initial background.", location: "Section 2" };
    const source = await persistSourceAndBlocks({
      title: "Registry notes", source_type: "advisory_board", stakeholder_function: actor.function,
      text: [cited.text, other.text].join("\n\n"), sections: [cited, other],
    });
    const originalBlockId = source.blocks[0]!.id;
    const commitMatch = (blockId: string) => commitExtractedRecords({
      source_id: source.source_id, title: "Registry notes", stakeholder_function: actor.function,
      actor_name: actor.name, actor_function: actor.function, needs: [], gaps: [],
      tactics: [{
        id: "candidate", name: "Existing registry", type: "registry", status: "ongoing",
        evidence_question: scope.evidence_question, source_id: source.source_id,
        source_quote: cited.text, block_id: blockId, duplicate_of: parentId,
      }],
    });
    await commitMatch(originalBlockId);
    const original = await suggestions.listTacticSourceReferences(parentId);
    expect(original).toEqual([expect.objectContaining({ block_id: originalBlockId, source_quote: cited.text })]);
    expect(await suggestions.listTacticSuggestions()).toEqual([]);

    const reparsed = await reparseSourceBlocks({
      source_id: source.source_id,
      sections: [{ ...other, text: "Updated background." }, cited],
    });
    const reparsedBlock = reparsed.blocks.find(block => block.text === cited.text)!;
    await commitMatch(reparsedBlock.id);

    expect(reparsedBlock.id).toBe(originalBlockId);
    expect(reparsed).toMatchObject({ kept_cited: 1, inserted: 1, skipped_duplicates: 1 });
    expect(await suggestions.listTacticSourceReferences(parentId)).toEqual(original);
  });
  it.each(["split", "merge", "merge repeated quote"] as const)("retains one current tactic source reference after %s and re-extraction", async edit => {
    const background = { heading: "Background", text: "Registry study background.", location: "1" };
    const evidence = { heading: "Registry", text: sourceQuote, location: "2" };
    const sections = edit === "split"
      ? [{ ...background, text: `${background.text} ${sourceQuote}` }]
      : [edit === "merge repeated quote" ? { ...background, text: sourceQuote } : background, evidence];
    const source = await persistSourceAndBlocks({
      title: "Registry notes", source_type: "advisory_board", stakeholder_function: actor.function,
      text: sections.map(section => section.text).join("\n\n"), sections,
    });
    const cite = (blockId: string) => suggestions.attachTacticSource({
      tactic_id: parentId, source_id: source.source_id, source_quote: sourceQuote, block_id: blockId,
    });
    await cite(source.blocks.at(-1)!.id);
    if (edit === "merge repeated quote") await cite(source.blocks[0]!.id);
    const original = await suggestions.listTacticSourceReferences(parentId);

    const currentBlockId = edit === "split"
      ? (await splitSourceBlock({ block_id: source.blocks[0]!.id, at_text: sourceQuote, rationale: "Separate evidence", actor })).second_id
      : (await mergeSourceBlocks({ block_id: source.blocks[0]!.id, rationale: "Combine related text", actor })).block_id;
    expect(await suggestions.listTacticSourceReferences(parentId)).toEqual([
      expect.objectContaining({ id: expect.any(String), block_id: currentBlockId, source_quote: sourceQuote }),
    ]);
    await expect(cite(source.blocks.at(-1)!.id)).rejects.toThrow(/source passage changed.*rerun/i);
    await cite(currentBlockId);
    const references = await suggestions.listTacticSourceReferences(parentId);
    expect(references).toHaveLength(1);
    expect(original.map(reference => reference.id)).toContain(references[0]!.id);
  });

  it("keeps overlaps pending with no unreviewed plan mutation and retains rejected reruns", async () => {
    const before = await loadState(); const row = await proposal();
    expect(row.status).toBe("pending"); expect(await loadState()).toEqual(before);
    await suggestions.decideTacticSuggestion({id: row.id, decision: "reject", rationale: "Unsupported subgroup", actor});
    const repeated = await proposal(); expect(repeated.id).toBe(row.id); expect(repeated.status).toBe("rejected");
  });
  it.each(["edited", "reject", "separate"] as const)("preserves a uniquely grounded historical %s decision on a block-aware rerun", async action => {
    const original = await proposal();
    const edit = { id: original.id, rationale: "Prior review of the original passage", actor };
    const reviewed: TacticSuggestion = action === "edited"
      ? await suggestions.editTacticSuggestion({ ...edit, expansion: { ...scope, name: "Reviewed subgroup" } })
      : await suggestions.decideTacticSuggestion({ ...edit, decision: action });
    const rerun = await proposal({ block_id: "fictional-subgroup" });
    expect(rerun).toMatchObject({ id: original.id, history: reviewed.history, status: reviewed.status });
    expect(await suggestions.listTacticSuggestions()).toHaveLength(1);
  });

  it("keeps named citations separate when a historical quotation has no unique block", async () => {
    const old = await proposal();
    await suggestions.decideTacticSuggestion({ id: old.id, decision: "reject", rationale: "Prior review", actor });
    await db().insert(t.sourceBlocks).values({ id: "fictional-subgroup-copy", source_id: sourceId, heading: "Appendix", location: "p.2", text: sourceQuote });
    const first = await proposal({ block_id: "fictional-subgroup" });
    const second = await proposal({ block_id: "fictional-subgroup-copy" });
    expect(new Set([old.id, first.id, second.id]).size).toBe(3);
  });

  it.each([
    { quote: "Fabricated source activity.", error: /retained source block/ },
    { quote: sourceQuote, error: /more than one source block/ },
  ])("keeps an ungrounded historical option pending and rejectable", async ({ quote, error }) => {
    if (quote === sourceQuote) {
      await db().insert(t.sourceBlocks).values({ id: "fictional-subgroup-copy", source_id: sourceId, heading: "Appendix", location: "p.2", text: quote });
    }
    const row = await proposal({ source_quote: quote });
    await suggestions.editTacticSuggestion({ id: row.id, gap_id: gapId, rationale: "Select a gap", actor });
    const before = await loadState();
    const review = { id: row.id, rationale: "Review the activity", actor };

    await expect(suggestions.decideTacticSuggestion({ ...review, decision: "expand" })).rejects.toThrow(error);
    await expect(suggestions.decideTacticSuggestion({ ...review, decision: "separate" })).rejects.toThrow(error);
    expect(await loadState()).toEqual(before);
    expect((await suggestions.decideTacticSuggestion({ ...review, decision: "reject" })).status).toBe("rejected");
  });

  it("retains a rejected block-scoped overlap when S1 reparses its passage", async () => {
    const cited = { heading: "Registry", text: sourceQuote, location: "Section 1" };
    const other = { heading: "Background", text: "Initial background.", location: "Section 2" };
    const source = await persistSourceAndBlocks({
      title: "Registry notes", source_type: "advisory_board", stakeholder_function: actor.function,
      text: `${cited.text}\n\n${other.text}`, sections: [cited, other],
    });
    sourceId = source.source_id;
    const row = await proposal(source.blocks[0]!.id);
    const rejected = await suggestions.decideTacticSuggestion({
      id: row.id, decision: "reject", rationale: "Unsupported subgroup", actor,
    });

    const reparsed = await reparseSourceBlocks({
      source_id: sourceId,
      sections: [{ ...other, text: "Updated background." }, cited],
    });
    const repeated = await proposal(reparsed.blocks.find(block => block.text === cited.text)!.id);

    expect(repeated).toEqual(rejected);
    expect(await suggestions.listTacticSuggestions()).toEqual([rejected]);
    expect(reparsed).toMatchObject({ kept_cited: 1, inserted: 1, skipped_duplicates: 1 });
    expect(reparsed.blocks.map(block => block.text)).toEqual([cited.text, "Updated background."]);
  });
  it.each(["split", "merge", "merge repeated quote"] as const)("retains a rejected overlap after %s and re-extraction", async edit => {
    const background = { heading: "Background", text: "Registry study background.", location: "1" };
    const cited = { heading: "Results", text: sourceQuote, location: "2" };
    const sections = edit === "split" ? [{ ...background, text: `${background.text} ${sourceQuote}` }]
      : [edit === "merge repeated quote" ? { ...background, text: sourceQuote } : background, cited];
    const source = await persistSourceAndBlocks({
      title: "Registry notes", source_type: "advisory_board", stakeholder_function: actor.function,
      text: sections.map(section => section.text).join("\n\n"), sections,
    });
    sourceId = source.source_id;
    const existing = edit === "merge repeated quote" ? await proposal(source.blocks[0]!.id) : undefined;
    const original = await proposal(source.blocks.at(-1)!.id);
    const rejected = await suggestions.decideTacticSuggestion({
      id: original.id, decision: "reject", rationale: "Unsupported subgroup", actor,
    });

    const currentBlockId = edit === "split"
      ? (await splitSourceBlock({ block_id: original.block_id!, at_text: sourceQuote, rationale: "Separate evidence", actor })).second_id
      : (await mergeSourceBlocks({ block_id: source.blocks[0]!.id, rationale: "Combine related text", actor })).block_id;

    const currentBlock = (await loadState()).blocks.find(block => block.id === currentBlockId)!;
    const moved = {
      ...rejected, block_id: currentBlockId,
      source_context: { heading: currentBlock.heading, location: currentBlock.location },
    };
    expect(await proposal(currentBlockId)).toEqual(moved);
    expect(await suggestions.listTacticSuggestions()).toEqual(existing ? [moved, existing] : [moved]);
  });
  it("asks for a rerun if S1 has replaced the passage before S3 saves its overlap", async () => {
    const source = await persistSourceAndBlocks({
      title: "Registry notes", source_type: "advisory_board", stakeholder_function: actor.function,
      text: sourceQuote, sections: [{ heading: "Registry", text: sourceQuote, location: "Section 1" }],
    });
    sourceId = source.source_id;
    const originalBlockId = source.blocks[0]!.id;
    const reparsed = await reparseSourceBlocks({
      source_id: sourceId,
      sections: [{ heading: "Registry", text: "A different registry activity.", location: "Section 1" }],
    });
    expect(reparsed.blocks[0]!.id).toBe(originalBlockId);

    await expect(proposal(originalBlockId)).rejects.toThrow(/source passage changed.*rerun/i);
    expect(await suggestions.listTacticSuggestions()).toEqual([]);
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
    expect(result.block_id).toBe("fictional-subgroup");
    expect(result.original_expansion.name).toBe(scope.name); expect(result.history).toHaveLength(2);
    await expect(suggestions.decideTacticSuggestion({id: row.id, decision: "expand", rationale: "Retry", actor})).rejects.toThrow(/already decided/);
    expect((await loadState()).expansions).toHaveLength(1);
  });
  it("creates a linked separate tactic with source-supported lifecycle and quote", async () => {
    const row = await proposal(); const before = await loadState();
    const result = await suggestions.decideTacticSuggestion({id: row.id, decision: "separate", rationale: "Different independent activity", actor});
    const after = await loadState(); expect(after.tactics).toHaveLength(before.tactics.length + 1);
    expect(after.tactics.find(t => t.id === result.result_tactic_id)).toMatchObject({name: row.separate.name, status: "planned", source_quote: row.source_quote, block_id: "fictional-subgroup", source_context: { heading: "Analysis", location: "p.1" }});
    expect(after.tactics.find(t => t.id === parentId)).toEqual(before.tactics.find(t => t.id === parentId));
  });
  it.each(["separate", "expand"] as const)("relinks the quote after a source edit before accepting %s", async decision => {
    const background = { heading: "Background", text: "Registry study background.", location: "1" };
    const cited = { heading: "Results", text: sourceQuote, location: "2" };
    const sections = decision === "separate"
      ? [{ ...background, text: `${background.text} ${cited.text}` }]
      : [background, cited];
    const source = await persistSourceAndBlocks({
      title: "Registry notes", source_type: "advisory_board", stakeholder_function: actor.function,
      text: sections.map(section => section.text).join("\n\n"), sections,
    });
    sourceId = source.source_id;
    const row = await proposal(source.blocks.at(-1)!.id);
    let currentBlockId: string;
    if (decision === "separate") {
      const split = await splitSourceBlock({
        block_id: row.block_id!, at_text: sourceQuote, rationale: "Split out the results", actor,
      });
      currentBlockId = split.second_id;
    } else {
      const merged = await mergeSourceBlocks({ block_id: source.blocks[0].id, rationale: "Join related text", actor });
      currentBlockId = merged.block_id;
      await suggestions.editTacticSuggestion({ id: row.id, gap_id: gapId, rationale: "Choose related gap", actor });
    }

    const result = await suggestions.decideTacticSuggestion({ id: row.id, decision, rationale: "Reviewed source evidence", actor });

    const tacticId = result.result_tactic_id ?? parentId;
    expect(await suggestions.listTacticSourceReferences(tacticId)).toContainEqual(
      expect.objectContaining({ source_id: sourceId, source_quote: sourceQuote, block_id: currentBlockId }),
    );
    if (decision === "separate") {
      expect((await loadState()).tactics.find(tactic => tactic.id === tacticId)?.block_id).toBe(currentBlockId);
    }
  });

  it("keeps a suggestion pending when its cited quote was removed", async () => {
    const sections = [
      { heading: "Background", text: "Registry study background.", location: "1" },
      { heading: "Results", text: sourceQuote, location: "2" },
    ];
    const source = await persistSourceAndBlocks({
      title: "Registry notes", source_type: "advisory_board", stakeholder_function: actor.function,
      text: sections.map(section => section.text).join("\n\n"), sections,
    });
    sourceId = source.source_id;
    const row = await proposal(source.blocks[1].id);
    await expect(deleteSourceBlock({ block_id: row.block_id!, rationale: "Remove obsolete results", actor })).rejects.toThrow(/would orphan/);
    await db().delete(t.sourceBlocks).where(eq(t.sourceBlocks.id, row.block_id!));
    const before = await loadState();
    await expect(suggestions.decideTacticSuggestion({
      id: row.id, decision: "separate", rationale: "Reviewed source evidence", actor,
    })).rejects.toThrow(/source passage.*rerun/i);
    expect(await suggestions.listTacticSuggestions()).toContainEqual(expect.objectContaining({ id: row.id, status: "pending" }));
    expect((await loadState()).tactics).toEqual(before.tactics);
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
