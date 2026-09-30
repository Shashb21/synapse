import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
}));

import { readFileSync } from "node:fs";
import "@/modules";
import { POST as iegpPost } from "@/app/api/iegp/route";
import { runStage } from "@/modules/kernel/run";
import { wipePlatform } from "@/modules/kernel/db";
import { displayedGapStatus, isLiveGap } from "@/lib/iegp/engine";
import { createAddressedGap, createGap, loadState, recordMissedTactic, resetBlank } from "@/lib/iegp/store";
import { listPlacements } from "@/modules/stages/s8-prioritization/module";
import { proposalFields } from "@/components/ideation/proposal-fields";

/**
 * KAN-16: no judgement is filled in for a person out of sight. A hand-made
 * gap's domain, a tactic's type and status, and the S8 axis pair are the
 * person's picks; blanks stay blank or take the person's own identity, as the
 * form says.
 */

const ACTOR = { name: "Defaults Tester", function: "heor" as const };
const src = (file: string) => readFileSync(file, "utf8");

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

beforeAll(async () => {
  await resetBlank();
  await wipePlatform();
}, 60_000);

describe("server: nothing assumed", () => {
  it("create_gap and create_addressed_gap need a domain the person chose", async () => {
    const missing = await iegp({ action: "create_gap", statement: "Budget impact for regional payers is unknown." });
    expect(missing.status).toBe(400);
    expect(String(missing.json.error)).toMatch(/domain/i);
    expect((await loadState()).gaps).toHaveLength(0);
    const addressed = await iegp({ action: "create_addressed_gap", statement: "PFS is closed.", tactic_name: "VEL-301" });
    expect(addressed.status).toBe(400);
    // An unknown domain is refused, not quietly turned into "unmet need".
    expect((await iegp({ action: "create_gap", statement: "Budget impact is unknown.", domain: "economic" })).status).toBe(400);
    const ok = await iegp({ action: "create_gap", statement: "Budget impact for regional payers is unknown.", domain: "economics" });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect((await loadState()).gaps[0]!.domain).toBe("economics");
  });

  it("a missed study on an Addressed gap needs its own type and question", async () => {
    const base = {
      statement: "PFS versus osimertinib in the pivotal trial",
      domain: "comparative_effectiveness" as const,
      missed_name: "VEL-301 PFS manuscript",
      missed_status: "completed",
      actor_name: ACTOR.name,
      actor_function: ACTOR.function,
    };
    await expect(createAddressedGap({ ...base, missed_evidence_question: "Is PFS closed?" })).rejects.toThrow(/type/);
    await expect(createAddressedGap({ ...base, missed_type: "publication" })).rejects.toThrow(/evidence question/);
  });

  it("a blank owner function is the person's own, not Evidence lead; a blank data source stays blank", async () => {
    const id = await recordMissedTactic({
      name: "Claims persistence study",
      type: "rwe_study",
      evidence_question: "What is 12-month persistence?",
      status: "ongoing",
      actor_name: ACTOR.name,
      actor_function: ACTOR.function,
    });
    const tactic = (await loadState()).tactics.find((row) => row.id === id)!;
    expect(tactic.function).toBe("heor");
    expect(tactic.owner).toBe(ACTOR.name);
    expect(tactic.data_source).toBe("");
  });

  it("S8 with no chosen axis pair scores the gaps but sets no working band", async () => {
    const gapId = await createGap({
      statement: "Real-world quality of life in elderly patients is not described.",
      domain: "unmet_need",
      actor_name: ACTOR.name,
      actor_function: ACTOR.function,
    });
    const state = await loadState();
    expect(isLiveGap(state.gaps.find((g) => g.id === gapId)!)).toBe(true);
    expect(displayedGapStatus(state.gaps.find((g) => g.id === gapId)!)).toBe("validated_open");
    const run = await runStage<{ placements: unknown[] }>({ stage: "S8", input: {}, actor: ACTOR, role: "medical_affairs" });
    expect(run.summary).toMatch(/no axis pair was chosen/);
    const unchosen = (await listPlacements()).find((row) => row.gap_id === gapId)!;
    expect(unchosen.band).toBeNull();
    expect(unchosen.suggested_band).toBeTruthy();
    expect(unchosen.validated).toBe(false);

    await runStage({
      stage: "S8",
      input: { x_axis: "effort_cost", y_axis: "decision_impact" },
      actor: ACTOR,
      role: "medical_affairs",
    });
    const chosen = (await listPlacements()).find((row) => row.gap_id === gapId)!;
    expect(chosen.band).toBe(chosen.suggested_band);
  }, 60_000);
});

describe("forms: judgement fields start unpicked", () => {
  it("gap domain selects have no preselected domain", () => {
    // Every create-gap dialog uses the shared fields (KAN-52).
    for (const file of ["src/components/plan-cards.tsx", "src/components/gaps-workbench.tsx"]) {
      expect(src(file)).toContain("<GapFormFields />");
    }
    const fields = src("src/components/gap-form-fields.tsx");
    expect(fields).not.toContain('defaultValue="unmet_need"');
    expect(fields).toContain("Choose a domain");
  });

  it("tactic type, status and owner function are not preselected", () => {
    const actions = src("src/components/gap-tactic-actions.tsx");
    expect(actions).not.toContain('defaultValue="evidence_lead"');
    expect(actions).not.toContain('defaultValue="ongoing"');
    expect(actions).toContain("Blank: your function");
    expect(actions).toContain("Choose a type");
    const cards = src("src/components/plan-cards.tsx");
    expect(cards).not.toContain('defaultValue="ongoing"');
    expect(cards.match(/Choose a type/g)?.length).toBe(2);
    const timeline = src("src/components/timeline/timeline-dialogs.tsx");
    expect(timeline).not.toContain('defaultValue: "rwe_study"');
    expect(timeline).not.toContain("defaultValue: tactics[0]");
  });

  it("a new idea's type is picked by the person; an edit starts from the idea's own type", () => {
    const fresh = proposalFields().find((field) => field.name === "type")!;
    expect(fresh.defaultValue).toBeUndefined();
    expect(fresh.placeholder).toBe("Choose a type");
    expect(fresh.required).toBe(true);
    const edit = proposalFields({ type: "registry" }).find((field) => field.name === "type")!;
    expect(edit.defaultValue).toBe("registry");
  });

  it("exclusion reason, need targets and source metadata are not preselected", () => {
    const gapPage = src("src/app/gaps/[id]/page.tsx");
    expect(gapPage).not.toContain('"not_defined"');
    expect(gapPage).not.toContain("defaultValue: moveTargets[0]");
    const needs = src("src/app/needs/page.tsx");
    expect(needs).not.toContain("defaultValue={gapOptions[0]");
    expect(needs).not.toContain("defaultValue: targets[0]");
    expect(src("src/app/sources/new/page.tsx")).toContain("Choose a source type");
  });

  it("the timeline shows its start date, prefilled with today and editable, and sends it", () => {
    const board = src("src/components/timeline/timeline-board.tsx");
    expect(board).toContain("export function AnchoredLayoutButton");
    expect(board).toContain('data-testid="timeline-anchor"');
    expect(board).toContain("{ persist: true, anchor }");
    expect(board).not.toContain('stage="S10" input={{ persist: true }}');
  });
});
