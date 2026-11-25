import { modelMappingSupport } from "./support/model-mapping";
import { priorityDecision } from "./support/priority-decision";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db as workspaceDb, withWorkspaceTransaction } from "@/lib/iegp/db";
import { gapSuggestions, sourceBlocks } from "@/lib/iegp/schema";
import "@/modules";
import { db, ensurePlatformSchema, wipePlatform } from "@/modules/kernel/db";
import { listEdits } from "@/modules/kernel/edit-records";
import {
  acceptGapMerge,
  addSuggestionSources,
  assignTacticToGap,
  clearNewSourceFlag,
  commitExtractedRecords,
  createGap,
  loadState,
  persistSourceAndBlocks,
  recordMissedTactic,
  resetDemoSetup,
} from "@/lib/iegp/store";
import { deleteSourceBlock, mergeSourceBlocks, reparseSourceBlocks, splitSourceBlock } from "@/lib/iegp/source-blocks";
import { iegpActionCapability } from "@/app/api/iegp/capabilities";
import { can } from "@/modules/auth/roles";
import { listPlacements, validatePlacement } from "@/modules/stages/s8-prioritization/module";
import {
  acceptGapMergeSuggestion,
  acceptGapSplitSuggestion,
  rejectGapSuggestionKeepingCandidate,
} from "@/modules/stages/s2-gap-extract/suggestions";
import { GAP_CANDIDATES_DDL, gapCandidates } from "@/modules/stages/s2-gap-extract/schema";

/**
 * KAN-75: a person decides each overlap suggestion. Merge rewords the gap, adds
 * the source, marks its assessments outdated and resets its validated priority; split makes a
 * related gap with only the new part; reject leaves the plan as it was and keeps
 * the candidate promotable.
 */

const ACTOR = { name: "KAN-75 Test", function: "medical_affairs" as const };
const who = { actor_name: ACTOR.name, actor_function: ACTOR.function };

const OVERLAP = {
  shared_part: "Comparative effectiveness versus standard of care is unknown.",
  new_part: "Nothing is known for patients over 75.",
  merged_name: "Comparative effectiveness incl. over-75s",
  merged_statement: "How does the asset compare with standard of care, including in patients over 75?",
  split_name: "Effectiveness in patients over 75",
  split_statement: "How effective is the asset in patients over 75?",
};

vi.hoisted(() => { process.env.DATABASE_POOL_MAX = "4"; });

const originalQuote = "Nobody has looked at the over-75s.";
const repeatQuote = "We have nothing on over-75s.";
let sourceId = "";
let sourceBlockId = "";
let repeatSourceId = "";
let repeatBlockId = "";

const sourceFixture = (title: string, quotes: string[]) => persistSourceAndBlocks({
  title,
  source_type: "stakeholder_interview",
  stakeholder_function: "heor",
  text: quotes.join("\n"),
  sections: quotes.map((text, index) => ({ heading: `Interview ${index + 1}`, location: `p.${index + 1}`, text })),
});

async function overlapOn(gapId: string, candidateRowId: string | null = null): Promise<string> {
  const result = await commitExtractedRecords({
    source_id: sourceId,
    title: "HEOR interview",
    stakeholder_function: "heor",
    ...who,
    needs: [],
    gaps: [],
    tactics: [],
    overlaps: [
      {
        id: `O-${Math.random().toString(36).slice(2, 8)}`,
        gap_id: gapId,
        run_id: "kan75-run",
        candidate_row_id: candidateRowId,
        name: "Over-75s versus SoC",
        statement: "How does it compare with SoC in patients over 75?",
        domain: "comparative_effectiveness",
        source_quote: originalQuote,
        ...OVERLAP,
      },
    ],
  });
  return Object.values(result.suggestion_id_by_row)[0]!;
}

const newGap = (statement = "No comparative effectiveness data versus standard of care.") =>
  createGap({ statement, domain: "comparative_effectiveness", ...who });

beforeAll(async () => {
  await resetDemoSetup();
  await wipePlatform(["source_files", "parsed_documents", "gap_candidates"]);
  const initial = await sourceFixture("Fictional payer interview", [originalQuote, repeatQuote]);
  sourceId = initial.source_id;
  sourceBlockId = initial.blocks[0]!.id;
  const repeat = await sourceFixture("Fictional second interview", [repeatQuote]);
  repeatSourceId = repeat.source_id;
  repeatBlockId = repeat.blocks[0]!.id;
}, 60_000);

it.each([
  ["merge", acceptGapMergeSuggestion],
  ["split", acceptGapSplitSuggestion],
] as const)("preserves both overlap citations through reparse and %s", async (_decision, acceptSuggestion) => {
  const gapId = await newGap();
  const citations = await Promise.all([
    "The Finch panel has no data for patients over 75.",
    "The Aster committee confirmed the lack of data for older patients.",
  ].map(async (quote) => {
    const section = { heading: "Evidence", text: quote, location: "Section 1" };
    const source = await persistSourceAndBlocks({
      title: quote, source_type: "advisory_board", stakeholder_function: ACTOR.function,
      text: quote, sections: [section],
    });
    return {
      source_id: source.source_id, block_id: source.blocks[0]!.id,
      source_quote: quote, statement: OVERLAP.split_statement,
    };
  }));
  const [primary, repeat] = citations;
  const result = await commitExtractedRecords({
    source_id: primary!.source_id, title: "Finch panel", stakeholder_function: ACTOR.function,
    ...who, needs: [], gaps: [], tactics: [],
    overlaps: [{
      id: "reparse-overlap", gap_id: gapId, run_id: "reparse-overlap-run",
      candidate_row_id: null, block_id: primary!.block_id, name: "Over-75s versus SoC",
      statement: primary!.statement, domain: "comparative_effectiveness",
      source_quote: primary!.source_quote, ...OVERLAP,
    }],
  });
  const suggestionId = result.suggestion_id_by_row["reparse-overlap"]!;
  await addSuggestionSources(suggestionId, [repeat!]);

  for (const citation of citations) {
    const reparsed = await reparseSourceBlocks({
      source_id: citation.source_id,
      sections: [{ heading: "Background", text: "Updated background.", location: "Section 1" }],
    });
    expect(reparsed.blocks).toContainEqual(expect.objectContaining({
      id: citation.block_id, text: citation.source_quote,
    }));
  }

  await acceptSuggestion({ suggestion_id: suggestionId, rationale: "Reviewed both sources", ...who });
  const { needs } = await loadState();
  for (const { source_id, block_id, source_quote } of citations) {
    expect(needs).toContainEqual(expect.objectContaining({ source_id, block_id, source_quote }));
  }
});

it.each([
  ["merge", acceptGapMergeSuggestion],
  ["split", acceptGapSplitSuggestion],
  ["removed quote", acceptGapSplitSuggestion],
] as const)("checks current primary and extra source citations before %s", async (decision, acceptSuggestion) => {
  const gapId = await newGap();
  const background = { heading: "Background", text: "The panel reviewed the literature.", location: "1" };
  const quote = "The panel found no evidence for older patients.";
  const evidence = { heading: "Evidence", text: quote, location: "2" };
  const primary = await persistSourceAndBlocks({
    title: "Primary panel", source_type: "advisory_board", stakeholder_function: ACTOR.function,
    text: `${background.text} ${quote}`, sections: [{ ...background, text: `${background.text} ${quote}` }],
  });
  const extra = await persistSourceAndBlocks({
    title: "Second panel", source_type: "advisory_board", stakeholder_function: ACTOR.function,
    text: `${background.text} ${quote}`, sections: [background, evidence],
  });
  const { suggestion_id_by_row } = await commitExtractedRecords({
    source_id: primary.source_id, title: "Primary panel", stakeholder_function: ACTOR.function,
    ...who, needs: [], gaps: [], tactics: [],
    overlaps: [{
      id: "edited-overlap", gap_id: gapId, run_id: "edited-source-run",
      block_id: primary.blocks[0]!.id, name: OVERLAP.split_name,
      statement: OVERLAP.split_statement, domain: "comparative_effectiveness",
      source_quote: quote, ...OVERLAP,
    }],
  });
  const suggestionId = suggestion_id_by_row["edited-overlap"]!;
  await addSuggestionSources(suggestionId, [{
    source_id: extra.source_id, block_id: extra.blocks[1]!.id, source_quote: quote, statement: OVERLAP.split_statement,
  }]);
  const split = await splitSourceBlock({ block_id: primary.blocks[0]!.id, at_text: quote, rationale: "Separate evidence", actor: ACTOR });
  const accept = () => acceptSuggestion({ suggestion_id: suggestionId, rationale: "Reviewed both sources", ...who });
  if (decision === "removed quote") {
    await expect(deleteSourceBlock({ block_id: extra.blocks[1]!.id, rationale: "Remove obsolete evidence", actor: ACTOR })).rejects.toThrow(/would orphan/);
    await workspaceDb().delete(sourceBlocks).where(eq(sourceBlocks.id, extra.blocks[1]!.id));
    const before = await loadState();
    await expect(accept()).rejects.toThrow(/source passage changed.*rerun/i);
    expect(await loadState()).toEqual(before);
    return;
  }

  const merge = await mergeSourceBlocks({ block_id: extra.blocks[0]!.id, rationale: "Combine related text", actor: ACTOR });
  await accept();
  const needs = (await loadState()).needs;
  for (const [sourceId, blockId] of [[primary.source_id, split.second_id], [extra.source_id, merge.block_id]]) {
    const citations = needs.filter(need => need.source_id === sourceId && need.source_quote === quote);
    expect(citations.length).toBeGreaterThan(0);
    expect(citations.map(need => need.block_id)).toEqual(citations.map(() => blockId));
  }
});

describe("KAN-75 merge", () => {
  let gapId = "";
  let suggestionId = "";

  beforeEach(async () => {
    gapId = await newGap();
    // Prioritize places Open gaps only: validate the band before a tactic changes the status.
    await validatePlacement({ ...await priorityDecision(gapId, "blocks the HTA decision"), gap_id: gapId, band: "high", rationale: "blocks the HTA decision", actor: ACTOR });
    await recordMissedTactic({ name: `Registry ${gapId}`, type: "registry", evidence_question: "q", status: "ongoing", ...who });
    const tacticId = (await loadState()).tactics.at(-1)!.id;
    await assignTacticToGap({ ...await modelMappingSupport(gapId, tacticId), gap_id: gapId, tactic_id: tacticId, ...who, coverage: "partial", note: "covers part" });
    suggestionId = await overlapOn(gapId);
  });

  it("rewords the gap, adds the source, marks its assessments outdated and resets its validated priority", async () => {
    const result = await acceptGapMergeSuggestion({
      suggestion_id: suggestionId,
      name: "Comparative effectiveness incl. elderly",
      rationale: "One question for the payer dossier",
      ...who,
    });
    expect(result).toEqual({ gap_id: gapId, priority_reset: true });
    const state = await loadState();
    const gap = state.gaps.find((row) => row.id === gapId)!;
    // The person edited the name; the statement is the proposal's.
    expect(gap.name).toBe("Comparative effectiveness incl. elderly");
    expect(gap.statement).toBe(OVERLAP.merged_statement);
    expect(gap.status_lock.locked).toBe(true);
    const needs = state.need_gap_links
      .filter((link) => link.gap_id === gapId)
      .map((link) => ({ role: link.role, need: state.needs.find((need) => need.id === link.need_id)! }));
    expect(needs).toContainEqual(
      expect.objectContaining({ role: "supporting", need: expect.objectContaining({ source_id: sourceId }) }),
    );
    expect(state.coverages.filter((row) => row.gap_id === gapId).every((row) => row.stale)).toBe(true);
    expect(state.coverages.filter((row) => row.gap_id === gapId).every((row) => !row.needs_review)).toBe(true);
    const placement = (await listPlacements()).find((row) => row.gap_id === gapId)!;
    expect(placement).toMatchObject({ validated: false, band: "high" });
    expect(state.gap_suggestions.find((row) => row.id === suggestionId)).toMatchObject({
      status: "merged",
      decided_by: ACTOR.name,
      rationale: "One question for the payer dossier",
    });
    const edits = await listEdits({ entity_id: gapId });
    expect(edits.some((edit) => edit.field === "suggestion" && edit.action === "accept")).toBe(true);
    expect(edits.some((edit) => edit.field === "name" && edit.after === "Comparative effectiveness incl. elderly")).toBe(true);
  });

  it("needs a rationale, and decides a suggestion once", async () => {
    await expect(acceptGapMergeSuggestion({ suggestion_id: suggestionId, rationale: " ", ...who })).rejects.toThrow(
      /rationale/i,
    );
    await acceptGapMergeSuggestion({ suggestion_id: suggestionId, rationale: "merge it", ...who });
    await expect(acceptGapSplitSuggestion({ suggestion_id: suggestionId, rationale: "split it", ...who })).rejects.toThrow(
      /already decided/,
    );
  });
});

describe("KAN-75 split", () => {
  it("makes a related gap with only the new part and adds the shared part to the existing gap", async () => {
    const gapId = await newGap();
    const suggestionId = await overlapOn(gapId);
    // A repeat from another source rides along and follows the outcome.
    await addSuggestionSources(suggestionId, [
      { source_id: sourceId, statement: "Over-75s are missing.", source_quote: "We have nothing on over-75s." },
    ]);

    const { new_gap_id } = await acceptGapSplitSuggestion({ suggestion_id: suggestionId, rationale: "Separate question", ...who });

    const state = await loadState();
    const created = state.gaps.find((row) => row.id === new_gap_id)!;
    expect(created).toMatchObject({ name: OVERLAP.split_name, statement: OVERLAP.split_statement, domain: "comparative_effectiveness" });
    const linksOf = (id: string) =>
      state.need_gap_links
        .filter((link) => link.gap_id === id)
        .map((link) => ({ role: link.role, need: state.needs.find((need) => need.id === link.need_id)! }));
    expect(linksOf(new_gap_id)).toContainEqual(
      expect.objectContaining({ role: "primary", need: expect.objectContaining({ source_quote: "Nobody has looked at the over-75s." }) }),
    );
    expect(linksOf(new_gap_id)).toContainEqual(
      expect.objectContaining({ role: "supporting", need: expect.objectContaining({ source_quote: "We have nothing on over-75s." }) }),
    );
    expect(linksOf(gapId)).toContainEqual(
      expect.objectContaining({ role: "supporting", need: expect.objectContaining({ statement: OVERLAP.shared_part }) }),
    );
    expect(state.gaps.find((row) => row.id === gapId)!.related_gap_ids).toEqual([new_gap_id]);
    expect(created.related_gap_ids).toEqual([gapId]);
    expect(state.gap_suggestions.find((row) => row.id === suggestionId)).toMatchObject({ status: "split", result_gap_id: new_gap_id });
  });
});

describe("historical gap overlap citations", () => {
  it.each([acceptGapMergeSuggestion, acceptGapSplitSuggestion])("recovers the retained block on %p", async accept => {
    const gapId = await newGap();
    const suggestionId = await overlapOn(gapId);
    const result = await accept({ suggestion_id: suggestionId, rationale: "Verify the quotation", ...who });
    const targetGapId = "new_gap_id" in result ? result.new_gap_id : result.gap_id;
    const state = await loadState();
    const linked = state.need_gap_links.filter(link => link.gap_id === targetGapId).map(link => link.need_id);
    expect(state.needs.find(row => linked.includes(row.id) && row.source_quote === originalQuote))
      .toMatchObject({ block_id: sourceBlockId, source_context: { heading: "Interview 1", location: "p.1" } });
  });

  it.each([
    { quotes: ["Different fictional interview."], reason: /retained source block/ },
    { quotes: [originalQuote, originalQuote], reason: /more than one source block/ },
  ])("refuses to accept an unsupported or ambiguous quotation", async ({ quotes, reason }) => {
    const source = await sourceFixture("Fictional historical interview", quotes);
    const gapId = await newGap();
    const suggestionId = await overlapOn(gapId);
    await workspaceDb().update(gapSuggestions).set({ source_id: source.source_id }).where(eq(gapSuggestions.id, suggestionId));
    const before = await loadState();
    const decision = { suggestion_id: suggestionId, rationale: "Review the evidence", ...who };

    await expect(acceptGapMergeSuggestion(decision)).rejects.toThrow(reason);
    await expect(acceptGapSplitSuggestion(decision)).rejects.toThrow(reason);
    expect(await loadState()).toEqual(before);
    await rejectGapSuggestionKeepingCandidate(decision);
    expect((await loadState()).gap_suggestions.find(row => row.id === suggestionId)?.status).toBe("rejected");
  });
});

describe("concurrent gap suggestion source and decision", () => {
  const append = (suggestionId: string) => addSuggestionSources(suggestionId, [{
    source_id: repeatSourceId, source_quote: repeatQuote, statement: "Independent interview repeats the concern.",
    block_id: repeatBlockId,
  }]);

  /** Wait until another Postgres connection is blocked by the given transaction. */
  async function waitForBlocker(pid: number) {
    await vi.waitFor(async () => {
      const rows = await workspaceDb().execute(sql`
        select 1 from pg_stat_activity where datname = current_database()
          and ${pid} = any(pg_blocking_pids(pid))
      `);
      expect(rows).toHaveLength(1);
    }, { timeout: 3000, interval: 20 });
  }

  /** Pause an already-performed workspace write before transaction commit. */
  async function holdWrite(write: () => Promise<unknown>) {
    let release!: () => void;
    let ready!: (pid: number) => void;
    const paused = new Promise<number>(resolve => { ready = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    const done = withWorkspaceTransaction(async () => {
      const [row] = await workspaceDb().execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      await write();
      ready(row!.pid);
      await resume;
    });
    const pid = await Promise.race([paused, done.then(() => { throw new Error("Write ended before it could be paused"); })]);
    return { pid, release, done };
  }

  it("attaches a repeat committed while acceptance waits on the append", async () => {
    const gapId = await newGap();
    const suggestionId = await overlapOn(gapId);
    const held = await holdWrite(() => append(suggestionId));
    const decision = acceptGapMerge({ suggestion_id: suggestionId, rationale: "Carry both interviews", ...who });
    try {
      await waitForBlocker(held.pid);
    } finally {
      held.release();
      await held.done;
      await decision;
    }
    const state = await loadState();
    const linked = state.need_gap_links.filter(link => link.gap_id === gapId).map(link => link.need_id);
    expect(state.needs.find(row => linked.includes(row.id) && row.source_id === repeatSourceId))
      .toMatchObject({ source_quote: repeatQuote, block_id: repeatBlockId });
  });

  it("rejects a repeat that arrives after acceptance starts closing the suggestion", async () => {
    const gapId = await newGap();
    const suggestionId = await overlapOn(gapId);
    const held = await holdWrite(() => acceptGapMerge({ suggestion_id: suggestionId, rationale: "Close the suggestion", ...who }));
    const appended = append(suggestionId).then(() => null, error => error as Error);
    try {
      await waitForBlocker(held.pid);
    } finally {
      held.release();
      await held.done;
    }
    expect(await appended).toMatchObject({ message: "Pending gap suggestion not found." });
    expect((await loadState()).gap_suggestions.find(row => row.id === suggestionId))
      .toMatchObject({ status: "merged", extra_sources: [] });
  });
});

describe("KAN-75 reject", () => {
  it("leaves the plan as it was and keeps the candidate promotable", async () => {
    const gapId = await newGap();
    await ensurePlatformSchema([GAP_CANDIDATES_DDL]);
    const rowId = `gc-kan75-${Date.now()}`;
    await db().insert(gapCandidates).values({
      id: rowId,
      run_id: "kan75-run",
      document_id: "doc",
      source_id: sourceId,
      name: "Over-75s versus SoC",
      statement: "How does it compare with SoC in patients over 75?",
      domain: "comparative_effectiveness",
      source_quote: "Nobody has looked at the over-75s.",
      score: 70,
      verdict: "accept",
      critic_note: "overlaps",
      proposer: "llm",
      committed_gap_id: null,
      created_at: new Date().toISOString(),
    });
    const suggestionId = await overlapOn(gapId, rowId);
    const before = await loadState();

    await rejectGapSuggestionKeepingCandidate({ suggestion_id: suggestionId, rationale: "Not a real gap for us", ...who });

    const after = await loadState();
    expect(after.gaps.length).toBe(before.gaps.length);
    expect(after.gaps.find((row) => row.id === gapId)!.statement).toBe(before.gaps.find((row) => row.id === gapId)!.statement);
    expect(after.gap_suggestions.find((row) => row.id === suggestionId)).toMatchObject({ status: "rejected" });
    const [row] = await db().select().from(gapCandidates).where(eq(gapCandidates.id, rowId));
    expect(row).toMatchObject({ verdict: "reject" });
    expect(row!.critic_note).toMatch(/Not a real gap for us/);
  });
});

describe("KAN-74 new-source flag", () => {
  it("is cleared by a person with a rationale", async () => {
    const gapId = await newGap();
    await commitExtractedRecords({
      source_id: sourceId,
      title: "HEOR interview",
      stakeholder_function: "heor",
      ...who,
      needs: [],
      tactics: [],
      gaps: [
        {
          id: "S-1",
          name: "Versus SoC",
          statement: "Is it better than SoC?",
          domain: "comparative_effectiveness",
          source_id: sourceId,
          source_quote: "Payers asked.",
          duplicate_of: gapId,
        },
      ],
      validated_gap_ids: [gapId],
    });
    expect((await loadState()).gaps.find((row) => row.id === gapId)!.new_source_at).toBeTruthy();
    await expect(clearNewSourceFlag({ gap_id: gapId, rationale: "", ...who })).rejects.toThrow(/rationale/i);
    await clearNewSourceFlag({ gap_id: gapId, rationale: "Read it; nothing changes", ...who });
    expect((await loadState()).gaps.find((row) => row.id === gapId)!.new_source_at).toBeNull();
    await expect(clearNewSourceFlag({ gap_id: gapId, rationale: "again", ...who })).rejects.toThrow(/no new source/);
  });
});

describe("KAN-75 permissions", () => {
  it("lets editors decide suggestions and keeps viewers read-only", () => {
    for (const action of ["accept_gap_merge", "accept_gap_split", "reject_gap_suggestion", "clear_new_source_flag"]) {
      expect(iegpActionCapability(action)).toBe("validate");
    }
    expect(can("contributor", "validate")).toBe(true);
    expect(can("medical_affairs", "validate")).toBe(true);
    expect(can("viewer", "validate")).toBe(false);
  });
});
