import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import "@/modules";
import { db } from "@/lib/iegp/db";
import * as t from "@/lib/iegp/schema";
import * as kernel from "@/modules/kernel/schema";
import { listEdits } from "@/modules/kernel/edit-records";
import { resetWorkspaceModules } from "@/modules/kernel/db";
import {
  commitExtractedRecords,
  createBreakoutGroup,
  createGap,
  createProposedTactic,
  loadState,
  lockTactic,
  makeLock,
  modifyGap,
  resetDemoSetup,
  rewritePartialGap,
  setGapMetadata,
  setGapObjective,
  setGapSettings,
  splitPartialGap,
  syncComputedGapStatuses,
  validateGap,
} from "@/lib/iegp/store";
import { displayedGapStatus } from "@/lib/iegp/engine";
import { entityHistory } from "@/lib/iegp/entity-history";
import { findGapOrphans, gapRecord } from "@/lib/iegp/gap-record";
import { acceptGapMergeSuggestion, acceptGapSplitSuggestion } from "@/modules/stages/s2-gap-extract/suggestions";
import { gapCandidates } from "@/modules/stages/s2-gap-extract/schema";

/**
 * KAN-97: a confirmed gap is one record. A split or rewrite carries everything
 * hanging off the retired gap to its successors (or closes it with a reason);
 * S2 provenance reaches the gap; who confirmed it is kept; settings, metadata and
 * objective changes are on its history; one loader returns all of it; and the
 * orphan check finds nothing pointing at a retired gap afterwards.
 */

const ACTOR = { name: "KAN-97 Test", function: "heor" as const };
const who = { actor_name: ACTOR.name, actor_function: ACTOR.function };
const SOURCE = "SRC-KAN97";

async function addSource() {
  await db().insert(t.sources).values({
    id: SOURCE,
    filename: "kan97.txt",
    title: "KAN-97 interview",
    source_type: "interview",
    stakeholder_function: "heor",
    ingested_at: new Date().toISOString(),
    full_text: "Interview",
  }).onConflictDoNothing();
}

async function makePartialGap() {
  // A reset clears module tables too (priority, ideas, timeline), as the app's reset does.
  await resetDemoSetup();
  await resetWorkspaceModules();
  await addSource();
  const gapId = await createGap({
    name: "Comparative effectiveness in elderly patients",
    statement: "Need comparative effectiveness versus regional standard of care in elderly patients.",
    domain: "comparative_effectiveness",
    ...who,
  });
  const tacticId = await createProposedTactic({
    name: "Elderly chart review",
    type: "chart_review",
    description: "Chart review in patients aged 65 and over.",
    evidence_question: "What are outcomes in elderly patients?",
    population: "Elderly 2L",
    intervention: "Velmara",
    comparator: "To be specified",
    outcomes: "PFS / OS",
    geography: "US + EU5",
    owner: ACTOR.name,
    function: "heor",
    residual_ids: [],
    gap_id: gapId,
    ...who,
  });
  await lockTactic({ tactic_id: tacticId, status: "planned", ...who });
  await syncComputedGapStatuses(gapId);
  const gap = (await loadState()).gaps.find((g) => g.id === gapId)!;
  expect(displayedGapStatus(gap)).toBe("validated_partial");
  return { gapId, tacticId };
}

/** Everything a person can hang off a gap before it is split. */
async function decorate(gapId: string, tacticId: string) {
  const at = new Date().toISOString();
  await db().insert(kernel.priorityPlacements).values({
    gap_id: gapId, axis_scores: {}, suggested_band: "high", suggested_rationale: "Model", band: "high",
    validated: true, rationale: "Blocks the HTA dossier", actor_name: ACTOR.name, actor_function: ACTOR.function, at,
  });
  await db().insert(kernel.ideationProposals).values({
    id: `IDEA-${gapId}`, gap_id: gapId, name: "Registry in over-75s", type: "registry", rationale: "Fills the gap",
    evidence_question: "Outcomes over 75?", design: {}, created_at: at,
  });
  await db().insert(kernel.timelineActivities).values({
    id: `ACT-${tacticId}`, tactic_id: tacticId, gap_ids: [gapId], lane: "high", start_date: "2027-01-01",
    end_date: "2027-06-01", depends_on: [], meta: {}, updated_at: at,
  });
  await createBreakoutGroup({ name: `KAN-97 group ${gapId}`, gap_ids: [gapId], ...who });
  await db().insert(t.mappingSuggestions).values({
    gap_id: gapId, tactic_id: "TAC-REJECTED", status: "rejected", lock: makeLock(ACTOR.name, ACTOR.function, "Wrong population"),
  });
  const overlap = await commitExtractedRecords({
    source_id: SOURCE, title: "KAN-97 interview", stakeholder_function: "heor", ...who, needs: [], gaps: [], tactics: [],
    overlaps: [{
      id: "O-97", gap_id: gapId, run_id: "kan97-run", candidate_row_id: null,
      name: "Over-75s", statement: "Over-75s are unstudied.", domain: "comparative_effectiveness",
      source_quote: "Nobody looked at the over-75s.", shared_part: "Shared", new_part: "New",
      merged_name: "Merged", merged_statement: "Merged statement", split_name: "Split", split_statement: "Split statement",
    }],
  });
  return { suggestionId: Object.values(overlap.suggestion_id_by_row)[0]! };
}

describe("KAN-97 split and rewrite carry the gap's record", () => {
  it("a split moves priority (to re-validate), ideas, timeline and the suggestion to the open child; groups and rejections to both", async () => {
    const { gapId, tacticId } = await makePartialGap();
    const { suggestionId } = await decorate(gapId, tacticId);
    const before = (await loadState()).gaps.find((g) => g.id === gapId)!;
    const { addressedId, openId } = await splitPartialGap({
      parent_gap_id: gapId,
      addressed_name: "Elderly outcomes covered by the chart review",
      open_name: "Comparator evidence in frail elderly",
      tactic_id: tacticId,
      ...who,
    });
    const state = await loadState();
    const [placement] = await db().select().from(kernel.priorityPlacements).where(eq(kernel.priorityPlacements.gap_id, openId));
    expect(placement).toMatchObject({ band: "high", validated: false });
    expect(placement!.rationale).toMatch(new RegExp(`Carried from ${gapId}.*Blocks the HTA dossier`));
    expect(await db().select().from(kernel.priorityPlacements).where(eq(kernel.priorityPlacements.gap_id, gapId))).toHaveLength(0);
    const [idea] = await db().select().from(kernel.ideationProposals).where(eq(kernel.ideationProposals.id, `IDEA-${gapId}`));
    expect(idea!.gap_id).toBe(openId);
    const [activity] = await db().select().from(kernel.timelineActivities).where(eq(kernel.timelineActivities.id, `ACT-${tacticId}`));
    expect(activity!.gap_ids).toEqual([addressedId]);
    const groups = state.breakout_group_gaps.filter((row) => row.gap_id !== gapId && [addressedId, openId].includes(row.gap_id));
    expect(groups).toHaveLength(2);
    expect(state.breakout_group_gaps.some((row) => row.gap_id === gapId)).toBe(false);
    for (const child of [addressedId, openId]) {
      expect(state.mapping_suggestions.some((m) => m.gap_id === child && m.tactic_id === "TAC-REJECTED" && m.status === "rejected")).toBe(true);
    }
    expect(state.gap_suggestions.find((row) => row.id === suggestionId)!.gap_id).toBe(openId);
    expect(state.residuals.filter((r) => r.gap_id === gapId).every((r) => r.review_status === "rejected")).toBe(true);
    // Children inherit the objective and are confirmed by the person who split.
    for (const child of [addressedId, openId].map((id) => state.gaps.find((g) => g.id === id)!)) {
      expect(child.objective_id).toBe(before.objective_id);
      expect(child.validated_by).toMatchObject({ name: ACTOR.name, function: "heor" });
      expect(child.validated_at).toBeTruthy();
    }
    // The version remembers what the retired gap held and where it went.
    const version = state.gap_versions.find((row) => row.live_gap_id === openId && row.retired_gap_id === gapId)!;
    expect(version.snapshot).toMatchObject({ settings: before.settings, objective_id: before.objective_id });
    expect(version.snapshot!.priority).toMatchObject({ band: "high", validated: true });
    expect(version.snapshot!.carried).toMatchObject({ priority: [openId], ideas: [`IDEA-${gapId}`] });
    expect(await findGapOrphans()).toEqual([]);
  });

  it("a rewrite as Addressed closes pending ideas and drops the priority, leaving no orphans", async () => {
    const { gapId, tacticId } = await makePartialGap();
    await decorate(gapId, tacticId);
    const liveId = await rewritePartialGap({
      gap_id: gapId, name: "Covered by the chart review", status: "validated_addressed", tactic_id: tacticId, ...who,
    });
    const [idea] = await db().select().from(kernel.ideationProposals).where(eq(kernel.ideationProposals.id, `IDEA-${gapId}`));
    expect(idea).toMatchObject({ status: "rejected", gap_id: gapId });
    expect(idea!.decision_rationale).toMatch(/Superseded/);
    expect(await db().select().from(kernel.priorityPlacements).where(eq(kernel.priorityPlacements.gap_id, gapId))).toHaveLength(0);
    const state = await loadState();
    expect(state.gap_suggestions.filter((row) => row.status === "pending").every((row) => row.gap_id === liveId)).toBe(true);
    expect(await findGapOrphans()).toEqual([]);
  });
});

describe("KAN-97 confirmation", () => {
  it("validating records who, when and why; a later edit keeps it; a merge reword clears it with a reason", async () => {
    await resetDemoSetup();
    await addSource();
    const gapId = await createGap({ name: "Versus SoC", statement: "No comparative data versus SoC.", domain: "comparative_effectiveness", ...who });
    await validateGap({ gap_id: gapId, ...who, note: "Both sources agree" });
    let gap = (await loadState()).gaps.find((g) => g.id === gapId)!;
    expect(gap.validated_by).toMatchObject({ name: ACTOR.name, function: "heor" });
    expect(gap.validation_rationale).toBe("Both sources agree");
    const confirmedAt = gap.validated_at;
    await modifyGap({ gap_id: gapId, domain: "unmet_need", rationale: "Better fit", ...who });
    gap = (await loadState()).gaps.find((g) => g.id === gapId)!;
    expect(gap.validated_at).toBe(confirmedAt);

    const result = await commitExtractedRecords({
      source_id: SOURCE, title: "KAN-97 interview", stakeholder_function: "heor", ...who, needs: [], gaps: [], tactics: [],
      overlaps: [{
        id: "O-M", gap_id: gapId, run_id: "kan97-merge", candidate_row_id: "gc-kan97-merge",
        name: "Over-75s", statement: "Over-75s are unstudied.", domain: "comparative_effectiveness",
        source_quote: "Nobody looked at the over-75s.", shared_part: "Shared", new_part: "New",
        merged_name: "Versus SoC incl. over-75s", merged_statement: "No comparative data versus SoC, including over-75s.",
        split_name: "Split", split_statement: "Split statement",
      }],
    });
    await db().insert(gapCandidates).values({
      id: "gc-kan97-merge", run_id: "kan97-merge", document_id: "doc", source_id: SOURCE, name: "Over-75s",
      statement: "Over-75s are unstudied.", domain: "comparative_effectiveness", source_quote: "Nobody looked at the over-75s.",
      score: 80, verdict: "accept", critic_note: "Overlaps", proposer: "model", committed_gap_id: null, created_at: new Date().toISOString(),
    }).onConflictDoNothing();
    await acceptGapMergeSuggestion({ suggestion_id: Object.values(result.suggestion_id_by_row)[0]!, rationale: "Same question", ...who });
    const state = await loadState();
    gap = state.gaps.find((g) => g.id === gapId)!;
    expect(gap.human_validated).toBe(false);
    expect(gap.validated_by).toBeNull();
    const cleared = (await listEdits({ entity_id: gapId })).find((row) => row.field === "confirmation");
    expect(cleared).toMatchObject({ before: `Confirmed by ${ACTOR.name}`, after: "Needs confirming" });
    // The merged source's need knows its run and candidate, and the candidate knows its gap.
    const merged = state.needs.find((n) => n.candidate_row_id === "gc-kan97-merge")!;
    expect(merged.run_id).toBe("kan97-merge");
    const [candidate] = await db().select().from(gapCandidates).where(eq(gapCandidates.id, "gc-kan97-merge"));
    expect(candidate!.committed_gap_id).toBe(gapId);
  });
});

describe("KAN-97 S2 provenance and split suggestions", () => {
  it("keeps the whole quote and the need's provenance; a split suggestion's gap links back and inherits", async () => {
    await resetDemoSetup();
    await addSource();
    const longQuote = `${"The over-75s are missing from every trial. ".repeat(12)}End.`;
    const committed = await commitExtractedRecords({
      source_id: SOURCE, title: "KAN-97 interview", stakeholder_function: "heor", ...who, tactics: [],
      needs: [{ id: "C1", statement: "Over-75s are unstudied.", source_quote: longQuote, provenance: { run_id: "kan97-s2", candidate_row_id: "gc-1", block_id: "blk-1" } }],
      gaps: [{ id: "C1", name: "Over-75s", statement: "Over-75s are unstudied.", domain: "unmet_need", source_id: SOURCE, source_quote: longQuote, duplicate_of: null }],
    });
    const gapId = committed.gap_id_by_row.C1!;
    let state = await loadState();
    const need = state.needs.find((n) => state.need_gap_links.some((l) => l.need_id === n.id && l.gap_id === gapId))!;
    expect(need.source_quote).toBe(longQuote);
    expect(need).toMatchObject({ run_id: "kan97-s2", candidate_row_id: "gc-1", block_id: "blk-1" });

    await setGapSettings({ gap_id: gapId, settings: ["2L"], ...who });
    await setGapMetadata({ gap_id: gapId, metadata: { stakeholders: ["Payers"], geography: "EU5" }, ...who, rationale: "From the interview" });
    const overlap = await commitExtractedRecords({
      source_id: SOURCE, title: "KAN-97 interview", stakeholder_function: "heor", ...who, needs: [], gaps: [], tactics: [],
      overlaps: [{
        id: "O-S", gap_id: gapId, run_id: "kan97-split", candidate_row_id: null,
        name: "Caregivers", statement: "Caregiver burden is unknown.", domain: "caregiver_burden",
        source_quote: "Carers struggle.", shared_part: "Shared", new_part: "New",
        merged_name: "Merged", merged_statement: "Merged", split_name: "Caregiver burden in over-75s", split_statement: "Caregiver burden in over-75s is unknown.",
      }],
    });
    const { new_gap_id } = await acceptGapSplitSuggestion({ suggestion_id: Object.values(overlap.suggestion_id_by_row)[0]!, rationale: "A separate question", ...who });
    state = await loadState();
    const original = state.gaps.find((g) => g.id === gapId)!;
    const split = state.gaps.find((g) => g.id === new_gap_id)!;
    expect(split).toMatchObject({ origin_gap_id: gapId, objective_id: original.objective_id, settings: ["2L"] });
    expect(split.metadata).toMatchObject({ stakeholders: ["Payers"], geography: "EU5" });
    expect(split.parent_gap_id).toBeNull();
    const record = (await gapRecord(new_gap_id))!;
    expect(record.origin).toMatchObject({ id: gapId });
  });
});

describe("KAN-97 settings, metadata and objective edits", () => {
  it("each change is an edit record with before and after; the objective can be changed", async () => {
    await resetDemoSetup();
    const gapId = await createGap({ name: "Burden", statement: "Burden of illness is unknown.", domain: "disease_burden", ...who });
    await setGapSettings({ gap_id: gapId, settings: ["1L", "Perioperative"], rationale: "Both settings", ...who });
    await setGapMetadata({ gap_id: gapId, metadata: { notes: "Ask the payer advisors" }, ...who });
    const edits = await listEdits({ entity_id: gapId });
    expect(edits.find((row) => row.field === "settings")).toMatchObject({ before: null, after: "1L, Perioperative", rationale: "Both settings" });
    expect(edits.find((row) => row.field === "metadata.notes")).toMatchObject({ before: null, after: "Ask the payer advisors", rationale: null });

    const state = await loadState();
    const other = state.objectives.find((o) => o.id !== state.gaps.find((g) => g.id === gapId)!.objective_id);
    if (other) {
      await setGapObjective({ gap_id: gapId, objective_id: other.id, rationale: "Serves the HTA decision", ...who });
      expect((await loadState()).gaps.find((g) => g.id === gapId)!.objective_id).toBe(other.id);
      expect((await listEdits({ entity_id: gapId })).find((row) => row.field === "objective")).toMatchObject({ rationale: "Serves the HTA decision" });
    }
    await expect(setGapObjective({ gap_id: gapId, objective_id: "OBJ-NOPE", ...who })).rejects.toThrow(/objectives/);
  });

  it("history is scoped to after the workspace's last reset", async () => {
    await resetDemoSetup();
    const gapId = await createGap({ name: "Scoped", statement: "Scoped history.", domain: "unmet_need", ...who });
    const all = await entityHistory([gapId]);
    expect(all.length).toBeGreaterThan(0);
    expect(await entityHistory([gapId], { since: "2999-01-01T00:00:00.000Z" })).toEqual([]);
  });
});

describe("KAN-97 one record per gap", () => {
  it("gapRecord returns the gap's needs, coverages, priority, ideas, timeline and groups together", async () => {
    const { gapId, tacticId } = await makePartialGap();
    await decorate(gapId, tacticId);
    const record = (await gapRecord(gapId))!;
    expect(record.gap.id).toBe(gapId);
    expect(record.needs.length).toBeGreaterThan(0);
    expect(record.coverages.some((c) => c.tactic?.id === tacticId)).toBe(true);
    expect(record.priority).toMatchObject({ band: "high" });
    expect(record.ideas.map((i) => i.id)).toEqual([`IDEA-${gapId}`]);
    expect(record.timeline.map((a) => a.id)).toEqual([`ACT-${tacticId}`]);
    expect(record.breakout_groups).toHaveLength(1);
    expect(record.pending_suggestions).toHaveLength(1);
    expect(record.mapping_rejections.map((m) => m.tactic_id)).toContain("TAC-REJECTED");
    expect(await gapRecord("GAP-DOES-NOT-EXIST")).toBeNull();
  });
});
