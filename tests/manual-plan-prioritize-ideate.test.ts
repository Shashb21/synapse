import { beforeAll, describe, expect, it, vi } from "vitest";

// The plan API reads the session cookie; outside a request there is none.
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
}));

import "@/modules";
import { POST as planPost } from "@/app/api/plan/route";
import { runStage } from "@/modules/kernel/run";
import { wipePlatform } from "@/modules/kernel/db";
import { listEdits } from "@/modules/kernel/edit-records";
import { displayedGapStatus, isLiveGap } from "@/lib/iegp/engine";
import { createGap, loadState, resetSeed } from "@/lib/iegp/store";
import {
  listPlacements,
  movePlacement,
  setPlacement,
  validatePlacement,
} from "@/modules/stages/s8-prioritization/module";
import {
  addIdeationProposal,
  editIdeationProposal,
  listIdeationProposals,
} from "@/modules/stages/s9-ideation/module";
import { splitPayload } from "@/components/split-gap-dialog";

/**
 * Manual entry and override for S8 prioritization, S9 ideation and the S6
 * split dialog: a person can do each step with no model, and what they set
 * survives every later model run.
 */

const ACTOR = { name: "Manual Planner", function: "medical_affairs" as const };
const X = "effort_cost";
const Y = "decision_impact";

async function post(body: Record<string, unknown>) {
  const res = await planPost(
    new Request("http://localhost/api/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actor_name: ACTOR.name, actor_function: ACTOR.function, ...body }),
    }),
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const placementOf = async (gapId: string) => (await listPlacements()).find((row) => row.gap_id === gapId);

let ids: string[] = [];

beforeAll(async () => {
  await resetSeed();
  await wipePlatform();
  for (const statement of [
    "No comparative effectiveness evidence versus standard of care for the HTA dossier.",
    "Real-world quality of life in elderly patients is not described.",
    "Budget impact for regional payers is unknown.",
    "Long-term safety beyond two years is not characterised.",
    "Treatment sequencing after progression is not described.",
  ]) {
    await createGap({ statement, actor_name: ACTOR.name, actor_function: ACTOR.function });
  }
  const state = await loadState();
  ids = state.gaps
    .filter((gap) => isLiveGap(gap) && displayedGapStatus(gap) === "validated_open")
    .map((gap) => gap.id);
  expect(ids.length).toBeGreaterThanOrEqual(5);
}, 60_000);

describe("S8 manual placement", () => {
  it("places a gap by typed scores with no model run, audited with the rationale", async () => {
    const gapId = ids[0]!;
    expect(await placementOf(gapId)).toBeUndefined();
    // Low effort (cost axis) and high impact: favourable on both, so High.
    const placement = await setPlacement({
      gap_id: gapId,
      axis_scores: { [X]: 20, [Y]: 85 },
      x_axis: X,
      y_axis: Y,
      rationale: "Cheap ITC that unblocks the HTA dossier",
      actor: ACTOR,
    });
    expect(placement.band).toBe("high");
    expect(placement.validated).toBe(false);
    expect(placement.axis_scores).toEqual({ [X]: 20, [Y]: 85 });
    expect(placement.human_axes?.sort()).toEqual([Y, X].sort());
    expect(placement.human_band).toBe(true);
    expect(placement.suggested_rationale).toBe("");
    const edits = await listEdits({ entity_id: gapId });
    expect(edits.some((edit) => edit.field === "placement" && edit.action === "add")).toBe(true);
  });

  it("refuses a manual placement without a rationale and creates nothing", async () => {
    await expect(
      setPlacement({ gap_id: ids[4]!, band: "low", rationale: "x", actor: ACTOR }),
    ).rejects.toThrow(/rationale/i);
    expect(await placementOf(ids[4]!)).toBeUndefined();
    await expect(
      setPlacement({ gap_id: ids[4]!, axis_scores: { [X]: 140 }, rationale: "Out of range", actor: ACTOR }),
    ).rejects.toThrow(/0 to 100/);
  });

  it("validates a band on a gap no model has placed", async () => {
    const gapId = ids[1]!;
    const placement = await validatePlacement({
      gap_id: gapId,
      band: "high",
      rationale: "Elderly QoL blocks the German submission",
      actor: ACTOR,
    });
    expect(placement.validated).toBe(true);
    expect(placement.band).toBe("high");
    expect(placement.human_band).toBe(true);
  });

  it("drops a gap no model has placed straight onto the matrix", async () => {
    const placement = await movePlacement({ gap_id: ids[2]!, x_axis: X, y_axis: Y, x: 10, y: 10, actor: ACTOR });
    expect(placement.band).toBe("low");
    expect(placement.human_axes?.sort()).toEqual([Y, X].sort());
  });

  it("sets exact scores and validates through the plan API", async () => {
    const { status, json } = await post({
      action: "set_placement",
      gap_id: ids[3]!,
      x_axis: X,
      y_axis: Y,
      x_score: "30",
      y_score: "",
      band: "medium",
      validate: "yes",
      rationale: "Safety follow-up matters, not this cycle",
    });
    expect(status).toBe(200);
    const placement = json.placement as { band: string; validated: boolean; axis_scores: Record<string, number> };
    expect(placement).toMatchObject({ band: "medium", validated: true });
    expect(placement.axis_scores).toEqual({ [X]: 30 });

    const refused = await post({ action: "set_placement", gap_id: ids[3]!, band: "low", rationale: "" });
    expect(refused.status).toBe(400);
    expect(String(refused.json.error)).toMatch(/rationale/i);
  });

  it("a re-run keeps every human score and band, and only refreshes its own suggestion", async () => {
    const dragged = ids[2]!; // dragged to Low above
    const banded = ids[4]!;
    await setPlacement({ gap_id: banded, band: "low", rationale: "Sequencing is a later-cycle question", actor: ACTOR });
    const typed = ids[0]!; // typed 20/85 above

    // The test stub scores every axis 50, which lands top-left: High.
    await runStage({
      stage: "S8",
      input: { gap_ids: [dragged, banded, typed], x_axis: X, y_axis: Y, only_missing: false },
      actor: ACTOR,
      role: "medical_affairs",
    });

    const draggedAfter = (await placementOf(dragged))!;
    expect(draggedAfter.band).toBe("low");
    expect(draggedAfter.axis_scores[X]).toBe(90);
    expect(draggedAfter.axis_scores[Y]).toBe(10);
    expect(draggedAfter.suggested_band).toBe("high");
    expect(draggedAfter.suggested_rationale).toMatch(/Test stub/);

    const bandedAfter = (await placementOf(banded))!;
    expect(bandedAfter.band).toBe("low");
    // Axes nobody set take the model's scores.
    expect(bandedAfter.axis_scores).toEqual({ [X]: 50, [Y]: 50 });
    expect(bandedAfter.suggested_band).toBe("high");

    const typedAfter = (await placementOf(typed))!;
    expect(typedAfter.axis_scores).toEqual({ [X]: 20, [Y]: 85 });
    expect(typedAfter.band).toBe("high");
  }, 60_000);

  it("a gap the model placed and nobody touched still takes the new suggestion", async () => {
    const fresh = await createGap({
      statement: "Physician awareness of the new dosing schedule is unmeasured.",
      actor_name: ACTOR.name,
      actor_function: ACTOR.function,
    });
    await runStage({
      stage: "S8",
      input: { gap_ids: [fresh], x_axis: X, y_axis: Y },
      actor: ACTOR,
      role: "medical_affairs",
    });
    const placement = (await placementOf(fresh))!;
    expect(placement.band).toBe("high");
    expect(placement.human_band).toBe(false);
    expect(placement.human_axes).toEqual([]);
  }, 60_000);
});

describe("S9 manual ideas and edits", () => {
  it("a hand-validated High gap is reachable by S9 with no S8 model run", async () => {
    const gapId = ids[1]!; // validated High by hand above
    const result = await runStage<{ proposals: { gap_id: string }[] }>({
      stage: "S9",
      input: { per_gap: 2 },
      actor: ACTOR,
      role: "medical_affairs",
    });
    expect(result.output.proposals.some((proposal) => proposal.gap_id === gapId)).toBe(true);
    const stored = (await listIdeationProposals()).filter((proposal) => proposal.gap_id === gapId);
    expect(stored.length).toBeGreaterThan(0);
    // The judge's rank is persisted with the idea.
    expect(stored.map((proposal) => proposal.rank).sort()).toEqual([1, 2]);
    expect(stored.every((proposal) => proposal.origin === "ai")).toBe(true);
  }, 60_000);

  it("adds an idea by hand for an Open gap, audited, with timing left for S10", async () => {
    const proposal = await addIdeationProposal({
      gap_id: ids[3]!,
      fields: {
        name: "Registry linkage for long-term safety",
        type: "long_term_followup",
        evidence_question: "What is the AESI rate beyond two years?",
        population: "Trial-exposed patients",
        data_source: "National cancer registry",
        study_design: "Linked long-term follow-up cohort",
      },
      rationale: "Registry access already agreed with the national body",
      actor: ACTOR,
    });
    expect(proposal).toMatchObject({
      status: "proposed",
      origin: "human",
      edited_by: ACTOR.name,
      rank: null,
      rationale: "Registry access already agreed with the national body",
    });
    expect(proposal.design.duration_months).toBeNull();
    expect(proposal.design.data_source).toBe("National cancer registry");
    const edits = await listEdits({ entity_id: proposal.id });
    expect(edits.map((edit) => edit.action)).toContain("add");

    await expect(
      addIdeationProposal({
        gap_id: ids[3]!,
        fields: { name: "Bad", type: "not_a_type", evidence_question: "Q" },
        rationale: "Should fail",
        actor: ACTOR,
      }),
    ).rejects.toThrow(/allowed tactic types/);
    await expect(
      addIdeationProposal({
        gap_id: ids[3]!,
        fields: { name: "No reason", type: "slr", evidence_question: "Q" },
        rationale: "",
        actor: ACTOR,
      }),
    ).rejects.toThrow(/rationale/i);
  });

  it("edits every field of a model idea, and a re-run neither replaces nor rewrites it", async () => {
    const gapId = ids[1]!;
    const target = (await listIdeationProposals()).find(
      (proposal) => proposal.gap_id === gapId && proposal.origin === "ai" && proposal.status === "proposed",
    )!;
    const edited = await editIdeationProposal({
      id: target.id,
      fields: {
        name: "Elderly QoL PRO sub-study",
        type: "pro_study",
        evidence_question: "How does QoL change in patients aged 75+?",
        population: "Patients aged 75+",
        comparator: "Baseline",
        outcomes: "EQ-5D-5L",
        data_source: "Prospective PRO collection",
        study_design: "Prospective observational",
        duration_months: 18,
        readout_lag_months: 2,
        timing_rationale: "Recruitment of 75+ is slow",
      },
      rationale: "German HTA wants 75+ specifically",
      actor: ACTOR,
    });
    expect(edited).toMatchObject({ name: "Elderly QoL PRO sub-study", type: "pro_study", edited_by: ACTOR.name });
    expect(edited.design).toMatchObject({ duration_months: 18, readout_lag_months: 2, population: "Patients aged 75+" });
    expect(edited.rank).toBe(target.rank);
    const edit = (await listEdits({ entity_id: target.id }))[0]!;
    expect(edit.action).toBe("edit");
    expect(edit.field).toContain("population");

    await expect(
      editIdeationProposal({ id: target.id, fields: { duration_months: -1 }, rationale: "Bad timing", actor: ACTOR }),
    ).rejects.toThrow(/positive/);
    await expect(
      editIdeationProposal({ id: target.id, fields: { name: "Other" }, rationale: "", actor: ACTOR }),
    ).rejects.toThrow(/rationale/i);

    const before = await listIdeationProposals();
    await runStage({ stage: "S9", input: { per_gap: 2 }, actor: ACTOR, role: "medical_affairs" });
    const after = await listIdeationProposals();
    expect(after.length).toBeGreaterThan(before.length);
    expect(after.find((proposal) => proposal.id === target.id)).toEqual(edited);
    for (const proposal of before) {
      expect(after.find((row) => row.id === proposal.id)).toEqual(proposal);
    }
  }, 60_000);

  it("edits and accepts through the plan API; the tactic carries the edited design", async () => {
    const target = (await listIdeationProposals()).find(
      (proposal) => proposal.gap_id === ids[1]! && proposal.origin === "ai" && proposal.status === "proposed" && !proposal.edited_by,
    )!;
    const edit = await post({
      action: "edit_proposal",
      id: target.id,
      population: "Frail elderly patients",
      duration_months: "",
      rationale: "Frailty is what the payer asked about",
    });
    expect(edit.status).toBe(200);
    expect((edit.json.proposal as { design: { duration_months: number | null } }).design.duration_months).toBeNull();

    const accept = await post({
      action: "decide_proposal",
      id: target.id,
      decision: "accept",
      name: "Frailty cohort",
      rationale: "Accept with the frailty framing",
    });
    expect(accept.status).toBe(200);
    const tacticId = accept.json.tactic_id as string;
    expect(tacticId).toBeTruthy();
    const state = await loadState();
    const tactic = state.tactics.find((row) => row.id === tacticId)!;
    expect(tactic.name).toBe("Frailty cohort");
    expect(tactic.population).toBe("Frail elderly patients");
    expect(tactic.status).toBe("proposed");

    const refused = await post({ action: "edit_proposal", id: target.id, name: "Late", rationale: "Too late now" });
    expect(refused.status).toBe(400);
    expect(String(refused.json.error)).toMatch(/already accepted/);
  });

  it("adds an idea through the plan API", async () => {
    const { status, json } = await post({
      action: "add_proposal",
      gap_id: ids[4]!,
      name: "Chart review of sequencing",
      type: "chart_review",
      evidence_question: "What follows progression in routine care?",
      duration_months: "7",
      readout_lag_months: "2",
      rationale: "Sites are ready to abstract",
    });
    expect(status).toBe(200);
    expect(json.proposal).toMatchObject({ origin: "human", design: { duration_months: 7, readout_lag_months: 2 } });
  });
});

describe("S6 split dialog payload", () => {
  it("sends the addressed and open statements the person wrote", () => {
    const payload = splitPayload({
      gapId: "gap-1",
      addressedName: "Covered slice",
      addressedStatement: "  The ITC answers comparative OS versus SoC.  ",
      openName: "Leftover",
      openStatement: "Comparative QoL versus SoC is still unanswered.",
      addressedTacticIds: ["t1", "t2"],
      openTacticIds: [],
    });
    expect(payload).toMatchObject({
      action: "split_partial_gap",
      parent_gap_id: "gap-1",
      addressed_statement: "The ITC answers comparative OS versus SoC.",
      open_statement: "Comparative QoL versus SoC is still unanswered.",
      tactic_ids: "t1,t2",
    });
  });

  it("leaves an empty statement out so the API falls back to the title", () => {
    const payload = splitPayload({
      gapId: "gap-1",
      addressedName: "Covered",
      addressedStatement: " ",
      openName: "Leftover",
      openStatement: "",
      addressedTacticIds: ["t1"],
      openTacticIds: [],
    });
    expect(payload).not.toHaveProperty("addressed_statement");
    expect(payload).not.toHaveProperty("open_statement");
  });
});
