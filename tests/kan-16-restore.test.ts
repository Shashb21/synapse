import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined, push: () => undefined, replace: () => undefined }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import "@/modules";
import { POST as iegpPost } from "@/app/api/iegp/route";
import { POST as planPost } from "@/app/api/plan/route";
import { wipePlatform } from "@/modules/kernel/db";
import { listEdits } from "@/modules/kernel/edit-records";
import { buildPlanWorkspace, isLiveGap } from "@/lib/iegp/engine";
import { createGap, createNeed, humanRejectedPairs, loadState, resetBlank } from "@/lib/iegp/store";
import { listRejectedMappings } from "@/lib/iegp/restore";
import { addIdeationProposal, listIdeationProposals } from "@/modules/stages/s9-ideation/module";
import { RejectedMappings, RejectedTactics, SetAsideGaps } from "@/components/restore-actions";

/**
 * KAN-16: every exclusion or rejection has a visible, audited way back, and the
 * way back needs a rationale.
 */

const ACTOR = { name: "Restore Tester", function: "medical_affairs" as const };

async function iegp(body: Record<string, unknown>) {
  const res = await iegpPost(
    new Request("http://localhost/api/iegp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actor_name: ACTOR.name, actor_function: ACTOR.function, ...body }),
    }),
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function plan(body: Record<string, unknown>) {
  const res = await planPost(
    new Request("http://localhost/api/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actor_name: ACTOR.name, actor_function: ACTOR.function, ...body }),
    }),
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const audited = async (entity_id: string, action: string) =>
  (await loadState()).audit.some((row) => row.entity_id === entity_id && row.action === action);

let gapA = "";
let gapB = "";
let tacticId = "";

beforeAll(async () => {
  await resetBlank();
  await wipePlatform();
  gapA = await createGap({
    statement: "No comparative effectiveness evidence versus standard of care.",
    domain: "comparative_effectiveness",
    actor_name: ACTOR.name,
    actor_function: ACTOR.function,
  });
  gapB = await createGap({
    statement: "Long-term safety beyond two years is not characterised.",
    domain: "safety",
    actor_name: ACTOR.name,
    actor_function: ACTOR.function,
  });
  const created = await iegp({
    action: "create_tactic",
    origin: "tactics",
    name: "Registry cohort",
    type: "rwe_study",
    evidence_question: "What is the long-term AESI rate?",
    status: "planned",
  });
  expect(created.status).toBe(200);
  tacticId = (await loadState()).tactics.find((t) => t.name === "Registry cohort")!.id;
}, 60_000);

describe("excluded gaps", () => {
  it("excludes with a rationale filed as an edit record, and lists it under Set aside", async () => {
    const res = await iegp({
      action: "lock_gap",
      gap_id: gapA,
      status: "excluded",
      exclusion_reason: "outside_scope",
      note: "Belongs to the oncology plan",
    });
    expect(res.status).toBe(200);
    const state = await loadState();
    expect(state.gaps.find((g) => g.id === gapA)!.status).toBe("excluded");
    expect(buildPlanWorkspace(state).review.some((c) => c.gap_id === gapA)).toBe(false);
    const edits = await listEdits({ entity_id: gapA });
    expect(edits.some((e) => e.field === "status" && e.rationale === "Belongs to the oncology plan")).toBe(true);
    const html = renderToStaticMarkup(createElement(SetAsideGaps, { gaps: state.gaps }));
    expect(html).toContain("Set aside (1)");
    expect(html).toContain("Outside IEGP scope");
    expect(html).toContain("Restore gap");
  });

  it("refuses a restore without a rationale and leaves the gap excluded", async () => {
    const res = await iegp({ action: "restore_gap", gap_id: gapA });
    expect(res.status).toBe(400);
    expect(String(res.json.error)).toMatch(/rationale/i);
    expect((await loadState()).gaps.find((g) => g.id === gapA)!.status).toBe("excluded");
  });

  it("restores as an unconfirmed live gap, audited with the rationale", async () => {
    const res = await iegp({ action: "restore_gap", gap_id: gapA, note: "Scope widened at the June review" });
    expect(res.status).toBe(200);
    const state = await loadState();
    const gap = state.gaps.find((g) => g.id === gapA)!;
    expect(gap.status).toBe("validated_open");
    expect(gap.exclusion_reason).toBeNull();
    expect(gap.human_validated).toBe(false);
    expect(isLiveGap(gap)).toBe(true);
    expect(buildPlanWorkspace(state).review.some((c) => c.gap_id === gapA)).toBe(true);
    expect(await audited(gapA, "restore")).toBe(true);
    const edits = await listEdits({ entity_id: gapA });
    expect(
      edits.some((e) => e.before?.startsWith("excluded") && e.rationale === "Scope widened at the June review"),
    ).toBe(true);
    expect((await iegp({ action: "restore_gap", gap_id: gapA, note: "Again please" })).status).toBe(400);
  });
});

describe("rejected needs", () => {
  it("returns a rejected need to candidate with a rationale", async () => {
    await createNeed({
      gap_id: gapB,
      statement: "Payers ask for five-year safety data.",
      source_quote: "We need five-year safety.",
      rationale: "From the payer advisory board",
      actor_name: ACTOR.name,
      actor_function: ACTOR.function,
    });
    const need = (await loadState()).needs.find((n) => n.statement === "Payers ask for five-year safety data.")!;
    expect((await iegp({ action: "lock_need", need_id: need.id, status: "rejected", note: "Duplicate" })).status).toBe(200);
    expect((await iegp({ action: "restore_need", need_id: need.id })).status).toBe(400);
    const res = await iegp({ action: "restore_need", need_id: need.id, note: "Not a duplicate after all" });
    expect(res.status).toBe(200);
    expect((await loadState()).needs.find((n) => n.id === need.id)!.status).toBe("candidate");
    expect(await audited(need.id, "restore")).toBe(true);
    expect((await listEdits({ entity_id: need.id })).some((e) => e.after === "candidate")).toBe(true);
  });
});

describe("rejected tactics", () => {
  it("lists a rejected tactic and restores it into the library", async () => {
    expect(
      (await iegp({ action: "lock_tactic_review", tactic_id: tacticId, review_status: "rejected", note: "Not funded" })).status,
    ).toBe(200);
    let state = await loadState();
    expect(buildPlanWorkspace(state).availableTactics.some((t) => t.id === tacticId)).toBe(false);
    const html = renderToStaticMarkup(createElement(RejectedTactics, { tactics: state.tactics }));
    expect(html).toContain("Rejected tactics (1)");
    expect(html).toContain("Not funded");
    expect((await iegp({ action: "restore_tactic", tactic_id: tacticId, note: "x" })).status).toBe(400);
    expect((await iegp({ action: "restore_tactic", tactic_id: tacticId, note: "Budget approved in Q3" })).status).toBe(200);
    state = await loadState();
    expect(state.tactics.find((t) => t.id === tacticId)!.review_status).toBe("accepted");
    expect(buildPlanWorkspace(state).availableTactics.some((t) => t.id === tacticId)).toBe(true);
    expect(await audited(tacticId, "restore")).toBe(true);
  });
});

describe("rejected mappings", () => {
  it("lists a rejected pair and lifts the rejection without mapping it", async () => {
    expect(
      (await iegp({ action: "reject_mapping", gap_id: gapB, tactic_id: tacticId, rationale: "Wrong population" })).status,
    ).toBe(200);
    expect(humanRejectedPairs(await loadState()).has(`${gapB}::${tacticId}`)).toBe(true);
    const rows = await listRejectedMappings();
    expect(rows).toEqual([expect.objectContaining({ gap_id: gapB, tactic_id: tacticId, note: "Wrong population" })]);
    const html = renderToStaticMarkup(createElement(RejectedMappings, { rows }));
    expect(html).toContain("Rejected mappings (1)");
    expect(html).toContain("Wrong population");

    expect((await iegp({ action: "restore_mapping", gap_id: gapB, tactic_id: tacticId })).status).toBe(400);
    const res = await iegp({ action: "restore_mapping", gap_id: gapB, tactic_id: tacticId, note: "Population matches after all" });
    expect(res.status).toBe(200);
    const state = await loadState();
    expect(humanRejectedPairs(state).has(`${gapB}::${tacticId}`)).toBe(false);
    expect(state.coverages.some((c) => c.gap_id === gapB && c.tactic_id === tacticId)).toBe(false);
    expect(await listRejectedMappings()).toEqual([]);
    expect(await audited(`${gapB}::${tacticId}`, "restore_mapping")).toBe(true);
  });
});

describe("rejected S9 proposals", () => {
  it("puts a rejected idea back to Proposed with a rationale", async () => {
    const proposal = await addIdeationProposal({
      gap_id: gapB,
      fields: { name: "Linked registry follow-up", type: "long_term_followup", evidence_question: "Five-year AESI rate?" },
      rationale: "Registry access agreed",
      actor: ACTOR,
    });
    expect(
      (await plan({ action: "decide_proposal", id: proposal.id, decision: "reject", rationale: "Too slow" })).status,
    ).toBe(200);
    expect((await plan({ action: "restore_proposal", id: proposal.id, rationale: "" })).status).toBe(400);
    const res = await plan({ action: "restore_proposal", id: proposal.id, rationale: "Timeline relaxed" });
    expect(res.status).toBe(200);
    const row = (await listIdeationProposals()).find((p) => p.id === proposal.id)!;
    expect(row.status).toBe("proposed");
    expect(row.decided_by).toBeNull();
    expect((await listEdits({ entity_id: proposal.id })).some((e) => e.before === "rejected" && e.after === "proposed")).toBe(true);
    expect(await audited(proposal.id, "restore")).toBe(true);
    // Decidable again.
    expect(
      (await plan({ action: "decide_proposal", id: proposal.id, decision: "accept", rationale: "Go ahead" })).status,
    ).toBe(200);
    expect((await plan({ action: "restore_proposal", id: proposal.id, rationale: "Undo accept" })).status).toBe(400);
  });
});

describe("the restore actions are on the pages people use", () => {
  it("wires each restore into its surface", async () => {
    const { readFileSync } = await import("node:fs");
    const src = (file: string) => readFileSync(file, "utf8");
    expect(src("src/app/page.tsx")).toContain("<SetAsideGaps gaps={state.gaps} />");
    expect(src("src/app/page.tsx")).toContain("<RejectedTactics tactics={state.tactics} />");
    expect(src("src/app/gaps/[id]/page.tsx")).toContain("<RestoreGapButton gapId={gap.id} />");
    expect(src("src/app/needs/page.tsx")).toContain("<RestoreNeedButton needId={n.id} />");
    expect(src("src/app/mappings/page.tsx")).toContain("<RejectedMappings rows={rejected} />");
    expect(src("src/app/tactics/page.tsx")).toContain("<RejectedTactics tactics={state.tactics} />");
    expect(src("src/components/ideation/proposal-card.tsx")).toContain('action: "restore_proposal"');
  });
});
