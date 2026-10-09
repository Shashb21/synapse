import { beforeAll, describe, expect, it } from "vitest";
import "@/modules";
import { runStage } from "@/modules/kernel/run";
import { db, ensurePlatformSchema, wipePlatform } from "@/modules/kernel/db";
import { listEdits } from "@/modules/kernel/edit-records";
import { listAuditEvents } from "@/modules/kernel/audit";
import { recordDecisionExample } from "@/modules/kernel/decision-examples";
import { clearNewSourceFlag, commitExtractedRecords, createGap, loadState, modifyResidualGap, resetDemoSetup } from "@/lib/iegp/store";
import { listParsedDocuments } from "@/modules/stages/s1-parse/module";
import {
  acceptGapMergeSuggestion,
  rejectGapSuggestionKeepingCandidate,
} from "@/modules/stages/s2-gap-extract/suggestions";
import { GAP_CANDIDATES_DDL, gapCandidates } from "@/modules/stages/s2-gap-extract/schema";
import { promoteGapCandidate } from "@/app/api/iegp/promote-candidates";

/**
 * KAN-90: the plan actions the audit inventory found unrecorded now leave a
 * record. A merge keeps the gap's old wording as a version and records the name
 * change; rejecting a suggestion, clearing a new-source flag and promoting a
 * rejected candidate each write a workspace audit row; a leftover edit without a
 * note is still an edit record; a decision example that cannot be written is in
 * the audit log as failed, not swallowed.
 */

const ACTOR = { name: "KAN-90 Test", function: "medical_affairs" as const };
const who = { actor_name: ACTOR.name, actor_function: ACTOR.function };
let sourceId = "";

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
        run_id: "kan90-run",
        candidate_row_id: candidateRowId,
        name: "Over-75s versus SoC",
        statement: "How does it compare with SoC in patients over 75?",
        domain: "comparative_effectiveness",
        source_quote: "Nobody has looked at the over-75s.",
        shared_part: "Comparative effectiveness versus standard of care is unknown.",
        new_part: "Nothing is known for patients over 75.",
        merged_name: "Comparative effectiveness incl. over-75s",
        merged_statement: "How does the asset compare with standard of care, including in patients over 75?",
        split_name: "Effectiveness in patients over 75",
        split_statement: "How effective is the asset in patients over 75?",
      },
    ],
  });
  return Object.values(result.suggestion_id_by_row)[0]!;
}

const newGap = (statement = "No comparative effectiveness data versus standard of care.") =>
  createGap({ name: "Versus SoC", statement, domain: "comparative_effectiveness", ...who });

/** This test's rows only: the workspace audit trail outlives resets (KAN-89), so gap ids repeat across runs. */
const started = new Date().toISOString();
async function auditRows(entityId: string) {
  return (await loadState()).audit.filter((row) => row.entity_id === entityId && row.at >= started);
}

beforeAll(async () => {
  await resetDemoSetup();
  await wipePlatform(["source_files", "parsed_documents", "gap_candidates"]);
  await runStage({ stage: "S0", input: { demo_ids: ["heor-interview"] }, actor: ACTOR, role: "medical_affairs" });
  await runStage({ stage: "S1", input: {}, actor: ACTOR, role: "medical_affairs" });
  sourceId = (await listParsedDocuments())[0]!.source_id;
}, 60_000);

describe("KAN-90 plan action coverage", () => {
  it("a merge records the name change and keeps the old wording as a gap version", async () => {
    const gapId = await newGap();
    const suggestionId = await overlapOn(gapId);
    await acceptGapMergeSuggestion({ suggestion_id: suggestionId, rationale: "Same question, wider population", ...who });
    const state = await loadState();
    // Versions outlive resets (KAN-89): only this test's merge counts.
    const version = state.gap_versions.find((row) => row.live_gap_id === gapId && row.event === "merge" && row.at >= started);
    expect(version).toMatchObject({ retired_gap_id: gapId, name: "Versus SoC", actor_name: ACTOR.name });
    const edits = await listEdits({ entity_id: gapId });
    expect(edits.find((row) => row.field === "name")).toMatchObject({
      before: "Versus SoC",
      after: "Comparative effectiveness incl. over-75s",
      workspace_id: "default",
    });
    expect((await auditRows(gapId)).some((row) => row.action === "merge_suggestion")).toBe(true);
  });

  it("rejecting a suggestion writes an audit row; the rejected candidate's promotion does too", async () => {
    const gapId = await newGap();
    await ensurePlatformSchema([GAP_CANDIDATES_DDL]);
    const rowId = `gc-kan90-${Date.now()}`;
    await db().insert(gapCandidates).values({
      id: rowId,
      run_id: "kan90-run",
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
    await rejectGapSuggestionKeepingCandidate({ suggestion_id: suggestionId, rationale: "Not a real gap for us", ...who });
    const rejected = (await auditRows(gapId)).find((row) => row.action === "reject_suggestion");
    expect(rejected?.detail).toContain(suggestionId);
    expect(rejected).toMatchObject({ actor_name: ACTOR.name });

    const promoted = await promoteGapCandidate({ candidate_id: rowId, rationale: "We do need it after all", ...who });
    const row = (await auditRows(promoted)).find((entry) => entry.action === "promote_candidate");
    expect(row?.detail).toContain(rowId);
  });

  it("clearing a new-source flag writes an audit row", async () => {
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
    await clearNewSourceFlag({ gap_id: gapId, rationale: "Read it; nothing changes", ...who });
    expect((await auditRows(gapId)).some((row) => row.action === "clear_new_source_flag")).toBe(true);
  });

  it("a leftover edit without a note is still an edit record, with a null rationale", async () => {
    const gapId = await newGap();
    await modifyResidualGap({ parent_gap_id: gapId, statement: "Over-75s remain unstudied.", ...who });
    const edit = (await listEdits({ entity_id: gapId })).find((row) => row.entity_type === "residual_gap");
    expect(edit).toMatchObject({ field: "leftover", after: "Over-75s remain unstudied.", rationale: null });
  });

  it("a decision example that cannot be written is logged as a failed ai event", async () => {
    const since = new Date(Date.now() - 1_000).toISOString();
    const subject = `kan90-subject-${Date.now()}`;
    // A BigInt cannot be serialised, so the write fails inside recordDecisionExample.
    const id = await recordDecisionExample({
      stage: "S2",
      kind: "gap_suggestion",
      subject_id: subject,
      ai_input: { broken: BigInt(1) as unknown as number },
      ai_output: {},
      outcome: "rejected",
    });
    expect(id).toBeNull();
    const { events } = await listAuditEvents({ category: "ai", entity_id: subject, from: since }, { limit: 10 });
    expect(events[0]).toMatchObject({ action: "decision_example.record", meta: { outcome: "failed", stage: "S2" } });
    expect(String(events[0]!.meta?.reason)).toMatch(/BigInt/i);
  });
});
