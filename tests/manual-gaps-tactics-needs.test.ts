import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  acceptResidualGap,
  commitExtractedRecords,
  createGap,
  createNeed,
  createProposedTactic,
  editNeed,
  loadState,
  lockGapStatus,
  lockTacticReview,
  modifyGap,
  modifyResidualGap,
  modifyTactic,
  moveNeedToGap,
  parkGap,
  persistSourceAndBlocks,
  recordMissedTactic,
  resetSeed,
  unlinkNeedFromGap,
} from "@/lib/iegp/store";
import { db, resetWorkspaceModules, wipePlatform } from "@/modules/kernel/db";
import { listEdits } from "@/modules/kernel/edit-records";
import { gapCandidates, GAP_CANDIDATES_DDL } from "@/modules/stages/s2-gap-extract/schema";
import {
  tacticCandidates,
  TACTIC_CANDIDATES_DDL,
  TACTIC_CANDIDATES_DUPLICATE_DDL,
} from "@/modules/stages/s3-tactic-extract/schema";
import { ensurePlatformSchema } from "@/modules/kernel/db";
import {
  listRejectedGapCandidates,
  listRejectedTacticCandidates,
  promoteGapCandidate,
  promoteTacticCandidate,
} from "@/app/api/iegp/promote-candidates";

const who = { actor_name: "S. Iyer", actor_function: "evidence_lead" as const };

async function fresh() {
  await resetSeed();
  await resetWorkspaceModules();
}

async function source(title = "HTA briefing", text = "Evidence on elderly patients is missing.") {
  return persistSourceAndBlocks({ title, source_type: "other_internal", stakeholder_function: "hta", text });
}

function gapRow(source_id: string, duplicate_of: string | null, id = "XGAP-1") {
  return {
    id,
    name: "AI name for elderly gap",
    statement: "AI statement: elderly comparative effectiveness is missing.",
    domain: "comparative_effectiveness" as const,
    source_id,
    source_quote: "Evidence on elderly patients is missing.",
    duplicate_of,
  };
}

async function commitGap(source_id: string, duplicate_of: string | null, id = "XGAP-1") {
  return commitExtractedRecords({
    source_id,
    title: "HTA briefing",
    stakeholder_function: "hta",
    ...who,
    needs: [{ id, statement: "Elderly CE need", source_quote: "Evidence on elderly patients is missing." }],
    gaps: [gapRow(source_id, duplicate_of, id)],
    tactics: [],
  });
}

describe("manual gap edits", () => {
  it("requires a rationale, edits name/statement/domain, locks and audits with before/after", async () => {
    await fresh();
    const gapId = await createGap({ statement: "Original statement here.", ...who });
    await expect(modifyGap({ gap_id: gapId, name: "New", ...who })).rejects.toThrow(/rationale/i);
    await expect(modifyGap({ gap_id: gapId, name: "New", rationale: "x", ...who })).rejects.toThrow(/rationale/i);
    await expect(
      modifyGap({ gap_id: gapId, domain: "not_a_domain", rationale: "bad domain", ...who }),
    ).rejects.toThrow(/domain/i);
    const changes = await modifyGap({
      gap_id: gapId,
      name: "Human name",
      statement: "Human statement.",
      domain: "safety",
      rationale: "Wording agreed at workshop",
      ...who,
    });
    expect(changes.map((c) => c.field).sort()).toEqual(["domain", "name", "statement"]);
    const gap = (await loadState()).gaps.find((g) => g.id === gapId)!;
    expect(gap.name).toBe("Human name");
    expect(gap.statement).toBe("Human statement.");
    expect(gap.domain).toBe("safety");
    expect(gap.status_lock.locked).toBe(true);
    expect(gap.status_lock.note).toBe("Wording agreed at workshop");
    const edits = await listEdits({ entity_id: gapId });
    const statementEdit = edits.find((e) => e.field === "statement")!;
    expect(statementEdit.before).toBe("Original statement here.");
    expect(statementEdit.after).toBe("Human statement.");
    expect(statementEdit.rationale).toBe("Wording agreed at workshop");
    const audit = (await loadState()).audit.filter((a) => a.entity_id === gapId && a.action === "modify");
    expect(audit).toHaveLength(1);
  });

  it("an S2 re-run that repeats a human-edited gap keeps the human text", async () => {
    await fresh();
    const src = await source();
    const first = await commitGap(src.source_id, null);
    const gapId = first.gap_ids[0]!;
    await modifyGap({ gap_id: gapId, name: "Human name", statement: "Human statement.", rationale: "Human wording", ...who });
    const src2 = await source("KOL interview");
    const rerun = await commitGap(src2.source_id, gapId);
    expect(rerun.merged_gap_ids).toEqual([gapId]);
    const gap = (await loadState()).gaps.find((g) => g.id === gapId)!;
    expect(gap.name).toBe("Human name");
    expect(gap.statement).toBe("Human statement.");
  });

  it("an S2 repeat of an excluded or parked gap joins it and leaves it set aside", async () => {
    await fresh();
    const src = await source();
    const a = (await commitGap(src.source_id, null, "XGAP-1")).gap_ids[0]!;
    const b = (await commitGap(src.source_id, null, "XGAP-2")).gap_ids[0]!;
    await lockGapStatus({ gap_id: a, status: "excluded", exclusion_reason: "duplicative", ...who, note: "Not ours" });
    await parkGap({ gap_id: b, reason: "Not sure yet", ...who });
    const src2 = await source("KOL interview");
    const before = (await loadState()).gaps.length;
    const rerunA = await commitGap(src2.source_id, a, "XGAP-3");
    const rerunB = await commitGap(src2.source_id, b, "XGAP-4");
    expect(rerunA.gap_ids).toEqual([]);
    expect(rerunB.gap_ids).toEqual([]);
    const state = await loadState();
    expect(state.gaps.length).toBe(before);
    expect(state.gaps.find((g) => g.id === a)!.status).toBe("excluded");
    expect(state.gaps.find((g) => g.id === b)!.parked_at).toBeTruthy();
    // The repeat is kept as provenance on the set-aside gap.
    expect(state.need_gap_links.filter((l) => l.gap_id === a)).toHaveLength(2);
  });

  it("the S2 judge sees excluded and parked gaps, marked set_aside", () => {
    const src = readFileSync(path.join(process.cwd(), "src/modules/stages/s2-gap-extract/module.ts"), "utf8");
    expect(src).toContain("set_aside");
    expect(src).toContain(".filter((gap) => !gap.retired)");
  });
});

describe("manual tactic create and edit", () => {
  it("persists study_design, data_source and blank fields on a hand-created tactic", async () => {
    await fresh();
    const gapId = await createGap({ statement: "Gap for a proposed tactic.", ...who });
    const id = await createProposedTactic({
      name: "Claims study",
      type: "rwe_study" as never,
      description: "",
      evidence_question: "What is HCRU?",
      population: "",
      intervention: "",
      comparator: "",
      outcomes: "",
      geography: "",
      study_design: "Retrospective cohort",
      data_source: "Optum claims",
      owner: "",
      function: "heor",
      residual_ids: [],
      gap_id: gapId,
      ...who,
    });
    const state = await loadState();
    const tactic = state.tactics.find((x) => x.id === id)!;
    expect(tactic.study_design).toBe("Retrospective cohort");
    expect(tactic.data_source).toBe("Optum claims");
    expect(tactic.intervention).toBe("");
    expect(tactic.geography).toBe("");
    // Still mapped onto the gap it was created for, and the id is returned.
    expect(state.coverages.some((c) => c.gap_id === gapId && c.tactic_id === id)).toBe(true);
    const missed = await recordMissedTactic({
      name: "Registry",
      type: "rwe_study" as never,
      evidence_question: "Long-term safety?",
      status: "ongoing",
      study_design: "Prospective registry",
      data_source: "Sponsor registry",
      ...who,
    });
    const recorded = (await loadState()).tactics.find((x) => x.id === missed)!;
    expect(recorded.study_design).toBe("Prospective registry");
    expect(recorded.data_source).toBe("Sponsor registry");
  });

  it("stores the S3 source quote on committed tactics", async () => {
    await fresh();
    const src = await source("CDP", "A chart review is underway.");
    const result = await commitExtractedRecords({
      source_id: src.source_id, title: "CDP", stakeholder_function: "heor", ...who, needs: [], gaps: [],
      tactics: [{
        id: "XTAC-1", name: "EU5 chart review", type: "chart_review" as never, status: "ongoing",
        evidence_question: "Chart review?", source_id: src.source_id, source_quote: "A chart review is underway.",
      }],
    });
    const tactic = (await loadState()).tactics.find((x) => x.id === result.tactic_ids[0])!;
    expect(tactic.source_quote).toBe("A chart review is underway.");
  });

  it("edits every tactic field with rationale, lock and before/after edit records; S3 repeats don't clobber", async () => {
    await fresh();
    const src = await source("CDP", "A chart review is underway.");
    const tac = {
      id: "XTAC-1", name: "EU5 chart review", type: "chart_review" as never, status: "ongoing" as const,
      evidence_question: "Chart review?", source_id: src.source_id, source_quote: "A chart review is underway.",
    };
    const base = { source_id: src.source_id, title: "CDP", stakeholder_function: "heor" as const, ...who, needs: [], gaps: [] };
    const id = (await commitExtractedRecords({ ...base, tactics: [tac] })).tactic_ids[0]!;
    await expect(modifyTactic({ tactic_id: id, fields: { name: "X" }, ...who })).rejects.toThrow(/rationale/i);
    await expect(
      modifyTactic({ tactic_id: id, fields: { start_date: "next spring" }, rationale: "dates", ...who }),
    ).rejects.toThrow(/date/i);
    await expect(
      modifyTactic({ tactic_id: id, fields: { name: "  " }, rationale: "blank", ...who }),
    ).rejects.toThrow(/name/i);
    await modifyTactic({
      tactic_id: id,
      fields: {
        name: "Human chart review",
        population: "Elderly",
        comparator: "SoC",
        outcomes: "OS",
        study_design: "Retrospective",
        data_source: "EHR",
        geography: "DE, FR",
        intervention: "Asset",
        evidence_question: "Human question?",
        start_date: "2026-01-15",
        evidence_available: "2027-06-30",
      },
      rationale: "Per study team",
      ...who,
    });
    let tactic = (await loadState()).tactics.find((x) => x.id === id)!;
    expect(tactic.name).toBe("Human chart review");
    expect(tactic.start_date).toBe("2026-01-15");
    expect(tactic.evidence_available).toBe("2027-06-30");
    expect(tactic.geography).toBe("DE, FR");
    expect(tactic.lock.locked).toBe(true);
    const edits = await listEdits({ entity_id: id });
    const nameEdit = edits.find((e) => e.field === "name")!;
    expect(nameEdit.before).toBe("EU5 chart review");
    expect(nameEdit.after).toBe("Human chart review");
    expect(nameEdit.stage).toBe("S3");
    // A date can be cleared.
    await modifyTactic({ tactic_id: id, fields: { evidence_available: "" }, rationale: "Not known yet", ...who });
    // S3 re-run repeating the tactic is skipped; human values stay.
    await commitExtractedRecords({ ...base, tactics: [{ ...tac, duplicate_of: id }] });
    tactic = (await loadState()).tactics.find((x) => x.id === id)!;
    expect(tactic.name).toBe("Human chart review");
    expect(tactic.start_date).toBe("2026-01-15");
    expect(tactic.evidence_available).toBeNull();
  });

  it("records review accept/reject with rationale", async () => {
    await fresh();
    const id = await recordMissedTactic({
      name: "Registry", type: "rwe_study" as never, evidence_question: "Q?", status: "ongoing", ...who,
    });
    await lockTacticReview({ tactic_id: id, review_status: "rejected", note: "Not a real study", ...who });
    expect((await loadState()).tactics.find((x) => x.id === id)!.review_status).toBe("rejected");
    const edit = (await listEdits({ entity_id: id })).find((e) => e.field === "review_status")!;
    expect(edit.before).toBe("accepted");
    expect(edit.after).toBe("rejected");
  });
});

describe("manual need edits", () => {
  it("creates, edits, moves and unlinks needs with rationale and audit", async () => {
    await fresh();
    const g1 = await createGap({ statement: "Gap one statement.", ...who });
    const g2 = await createGap({ statement: "Gap two statement.", ...who });
    const needId = await createNeed({ gap_id: g1, statement: "Hand need", rationale: "From advisory board", ...who });
    let state = await loadState();
    const need = state.needs.find((n) => n.id === needId)!;
    expect(need.status).toBe("accepted");
    expect(need.status_lock.locked).toBe(true);
    expect(state.need_gap_links.find((l) => l.need_id === needId)?.gap_id).toBe(g1);

    await expect(editNeed({ need_id: needId, statement: "x", rationale: "", ...who })).rejects.toThrow(/rationale/i);
    await editNeed({ need_id: needId, statement: "Edited need", source_quote: "Quote", rationale: "Tidy", ...who });
    state = await loadState();
    expect(state.needs.find((n) => n.id === needId)!.statement).toBe("Edited need");
    expect(state.needs.find((n) => n.id === needId)!.source_quote).toBe("Quote");
    const edits = await listEdits({ entity_id: needId });
    expect(edits.find((e) => e.field === "statement")!.before).toBe("Hand need");

    await moveNeedToGap({ need_id: needId, from_gap_id: g1, to_gap_id: g2, rationale: "Wrong merge", ...who });
    state = await loadState();
    expect(state.need_gap_links.some((l) => l.need_id === needId && l.gap_id === g1)).toBe(false);
    expect(state.need_gap_links.find((l) => l.need_id === needId && l.gap_id === g2)?.role).toBe("supporting");
    expect((await listEdits({ entity_id: needId })).some((e) => e.field === "gap_link" && e.after === g2)).toBe(true);

    // Moving to a new gap makes the need that gap's primary; no synthetic need is added.
    const g3 = await moveNeedToGap({ need_id: needId, from_gap_id: g2, new_gap: true, rationale: "Own question", ...who });
    state = await loadState();
    const g3Links = state.need_gap_links.filter((l) => l.gap_id === g3);
    expect(g3Links).toEqual([{ need_id: needId, gap_id: g3, role: "primary" }]);

    // A live gap keeps at least one need.
    await expect(
      unlinkNeedFromGap({ need_id: needId, gap_id: g3, rationale: "Remove it", ...who }),
    ).rejects.toThrow(/only need/i);
    const extra = await createNeed({ gap_id: g3, statement: "Second", rationale: "Another quote", ...who });
    await unlinkNeedFromGap({ need_id: needId, gap_id: g3, rationale: "Remove it", ...who });
    state = await loadState();
    expect(state.need_gap_links.find((l) => l.gap_id === g3)).toEqual({ need_id: extra, gap_id: g3, role: "primary" });
    expect(state.audit.some((a) => a.entity_id === needId && a.action === "unlink")).toBe(true);
  });

  it("an S2 re-run adds needs but never re-links a moved need", async () => {
    await fresh();
    const src = await source();
    const gapId = (await commitGap(src.source_id, null)).gap_ids[0]!;
    const other = await createGap({ statement: "Other gap.", ...who });
    const aiNeed = (await loadState()).need_gap_links.find((l) => l.gap_id === gapId)!.need_id;
    await createNeed({ gap_id: gapId, statement: "Keeps the gap populated", rationale: "Hand need", ...who });
    await moveNeedToGap({ need_id: aiNeed, from_gap_id: gapId, to_gap_id: other, rationale: "Belongs elsewhere", ...who });
    await commitGap(src.source_id, gapId, "XGAP-9");
    const state = await loadState();
    expect(state.need_gap_links.some((l) => l.need_id === aiNeed && l.gap_id === gapId)).toBe(false);
    expect(state.need_gap_links.some((l) => l.need_id === aiNeed && l.gap_id === other)).toBe(true);
  });
});

describe("leftovers and rejected AI candidates", () => {
  it("files leftover edits and accepts with the reviewer's rationale", async () => {
    await fresh();
    const parent = await createGap({ statement: "Parent gap statement.", ...who });
    await modifyResidualGap({ parent_gap_id: parent, statement: "Leftover by hand", ...who, note: "Written by hand" });
    const child = await acceptResidualGap({ parent_gap_id: parent, ...who, note: "Agreed leftover" });
    const edits = await listEdits({ entity_id: parent });
    expect(edits.some((e) => e.field === "leftover" && e.action === "edit" && e.after === "Leftover by hand")).toBe(true);
    expect(edits.some((e) => e.field === "leftover" && e.action === "accept")).toBe(true);
    expect((await loadState()).gaps.find((g) => g.id === child)!.parent_gap_id).toBe(parent);
  });

  it("promotes a rejected gap or tactic candidate by hand with its source quote", async () => {
    await fresh();
    await wipePlatform(["gap_candidates", "tactic_candidates"]);
    await ensurePlatformSchema([GAP_CANDIDATES_DDL, TACTIC_CANDIDATES_DDL, TACTIC_CANDIDATES_DUPLICATE_DDL]);
    const src = await source();
    const common = { run_id: "run-1", document_id: "doc-1", source_id: src.source_id, score: 20, verdict: "reject", critic_note: "Too vague", proposer: "llm", created_at: new Date().toISOString() };
    await db().insert(gapCandidates).values({
      ...common, id: "gc-1", name: "Rejected gap", statement: "Rejected statement.", domain: "safety",
      source_quote: "Evidence on elderly patients is missing.", committed_gap_id: null,
    });
    await db().insert(tacticCandidates).values({
      ...common, id: "tc-1", name: "Rejected registry", type: "rwe_study", status: "ongoing",
      evidence_question: "Registry question?", source_quote: "Evidence on elderly patients is missing.", duplicate_of: null,
    });
    expect((await listRejectedGapCandidates()).map((r) => r.id)).toEqual(["gc-1"]);
    await expect(promoteGapCandidate({ candidate_id: "gc-1", rationale: "", ...who })).rejects.toThrow(/rationale/i);
    const gapId = await promoteGapCandidate({ candidate_id: "gc-1", rationale: "AI was wrong", ...who });
    const state = await loadState();
    const gap = state.gaps.find((g) => g.id === gapId)!;
    expect(gap.statement).toBe("Rejected statement.");
    const needId = state.need_gap_links.find((l) => l.gap_id === gapId)!.need_id;
    const need = state.needs.find((n) => n.id === needId)!;
    expect(need.source_id).toBe(src.source_id);
    expect(need.source_quote).toBe("Evidence on elderly patients is missing.");
    await expect(promoteGapCandidate({ candidate_id: "gc-1", rationale: "Again", ...who })).rejects.toThrow(/already/i);

    const tacticId = await promoteTacticCandidate({ candidate_id: "tc-1", gap_id: gapId, rationale: "Real study", ...who });
    const tactic = (await loadState()).tactics.find((x) => x.id === tacticId)!;
    expect(tactic.source_quote).toBe("Evidence on elderly patients is missing.");
    expect(tactic.data_source).toBe("HTA briefing");
    expect((await listRejectedTacticCandidates())[0]!.promoted_tactic_id).toBe(tacticId);
    expect((await listEdits({ entity_id: "tc-1" }))[0]!.after).toBe(tacticId);
  });

  it("the UI mounts the manual controls", () => {
    const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");
    const gapPage = read("src/app/gaps/[id]/page.tsx");
    for (const action of ["modify_gap", "edit_need", "move_need", "unlink_need", "create_need", "accept_residual_gap", "modify_residual_gap", "reject_residual_gap"]) {
      expect(gapPage).toContain(`action: "${action}"`);
    }
    const tacticPage = read("src/app/tactics/[id]/page.tsx");
    expect(tacticPage).toContain('action: "modify_tactic"');
    expect(tacticPage).toContain('action: "lock_tactic_review"');
    expect(read("src/app/needs/page.tsx")).toContain('action: "promote_gap_candidate"');
    expect(read("src/app/tactics/page.tsx")).toContain('action: "promote_tactic_candidate"');
    const cards = read("src/components/plan-cards.tsx");
    expect(cards).not.toContain('value="Velmara"');
    expect(cards).not.toContain("To be specified");
    expect(read("src/components/plan-chrome.tsx")).toContain('href: "/needs"');
  });
});
