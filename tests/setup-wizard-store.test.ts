import { describe, expect, it, vi } from "vitest";

// The routes read the session cookie; outside a request there is none.
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
}));

import "@/modules";
import { POST as iegpPost } from "@/app/api/iegp/route";
import { GET as walkthroughGet, POST as walkthroughPost } from "@/app/api/walkthrough/route";
import { loadState, resetWorkedExample, saveProductSetup } from "@/lib/iegp/store";
import { settingOptions } from "@/lib/iegp/engine";
import {
  parsePlanningContext,
  prioritizationContextFromState,
  setupContextFromState,
  setupIssues,
  type PlanningContext,
} from "@/lib/iegp/planning-context";
import { getWalkthrough, saveWalkthrough } from "@/lib/iegp/walkthrough";
import { createWorkspace, withWorkspace } from "@/modules/workspaces/store";

const ACTOR = { actor_name: "Setup Wizard Test", actor_function: "medical_affairs" } as const;
const unique = () => Math.random().toString(36).slice(2, 8);

function context(overrides: Partial<PlanningContext> = {}): PlanningContext {
  return parsePlanningContext({
    asset_name: "Nova",
    inn: "novamab",
    mechanism: "IL-23 inhibitor",
    modality: "Monoclonal antibody",
    therapeutic_area: "Immunology",
    indications: [
      { name: "Moderate-to-severe psoriasis", status: "current" },
      { name: "Psoriatic arthritis", status: "planned" },
    ],
    lifecycle_stage: "pre-launch",
    markets: ["US", "EU5"],
    company_situation: "Phase III readout pending; first launch for the company in immunology.",
    plan_owner: "J. Park",
    sponsoring_function: "Medical Affairs",
    plan_horizon_years: 4,
    cycle_start: "2027-01-01",
    cycle_end: "2027-12-31",
    objectives: [
      {
        id: "",
        name: "Win HTA in EU5",
        description: "",
        strategic_importance: 5,
        owner: "HEOR",
        key_decision: "EU5 HTA filing",
        decision_date: "2028-03-01",
      },
      { id: "", name: "Differentiate vs JAKs", description: "", strategic_importance: 4, owner: "", key_decision: "", decision_date: "" },
    ],
    competitors: [{ name: "JAK class", pressure: "high", note: "Oral convenience" }],
    competitive_pressure: "high",
    standard_of_care: "Biologics after topical failure",
    comparators: ["ustekinumab"],
    payer_hta_bodies: ["NICE", "G-BA / IQWiG"],
    regulatory_milestones: [{ name: "FDA filing", date: "2027-06-01" }],
    launch_timeline: "US 2028-H1",
    stakeholders: [
      { function: "Medical Affairs", lead: "J. Park" },
      { function: "HEOR", lead: "L. Chen" },
    ],
    treatment_settings: ["1L biologic", "2L biologic"],
    ...overrides,
  });
}

async function saveSetup(ctx: PlanningContext, markComplete: boolean) {
  const res = await iegpPost(
    new Request("http://localhost/api/iegp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...ACTOR, action: "save_product_setup", mark_complete: markComplete, context: ctx }),
    }),
  );
  return { status: res.status, json: (await res.json()) as { error?: string; context?: PlanningContext } };
}

describe("setup context: parsing and validation", () => {
  it("upgrades an older flat context (indication, geography, peri-launch)", () => {
    const ctx = parsePlanningContext({
      asset_name: "Velmara",
      indication: "2L EGFR-mutant NSCLC",
      geography: "US + EU5",
      lifecycle_stage: "peri-launch",
      key_decision: "HTA",
      strategic_importance: 4,
    });
    expect(ctx.indications).toEqual([{ name: "2L EGFR-mutant NSCLC", status: "current" }]);
    expect(ctx.markets).toEqual(["US", "EU5"]);
    expect(ctx.lifecycle_stage).toBe("launch");
    expect(ctx.key_decision).toBe("HTA");
    expect(ctx.strategic_importance).toBe(4);
  });

  it("requires the core fields to finish, but lets a draft through", () => {
    const empty = parsePlanningContext({});
    const required = setupIssues(empty).map((issue) => issue.field);
    expect(required).toEqual(
      expect.arrayContaining(["asset_name", "therapeutic_area", "indications", "lifecycle_stage", "markets", "plan_owner", "objectives", "stakeholders"]),
    );
    expect(setupIssues(empty, { required: false })).toEqual([]);
    expect(setupIssues(context())).toEqual([]);
  });

  it("refuses malformed dates even in a draft", () => {
    const bad = context({ cycle_start: "2027-13-40" });
    expect(setupIssues(bad, { required: false })[0]?.field).toBe("cycle_start");
    const backwards = context({ cycle_start: "2027-06-01", cycle_end: "2027-01-01" });
    expect(setupIssues(backwards).some((issue) => issue.field === "cycle_end")).toBe(true);
  });
});

describe("setup context: saved per workspace", () => {
  it("keeps each workspace's context separate and maps it onto the asset and objectives", async () => {
    const owner = `setup-${unique()}@example.com`;
    const a = await createWorkspace({ name: "Nova psoriasis", owner });
    const b = await createWorkspace({ name: "Velmara lung", owner });

    const savedA = await withWorkspace(a.id, () => saveSetup(context(), true));
    expect(savedA.status).toBe(200);
    expect(savedA.json.context?.objectives.every((objective) => objective.id.startsWith("OBJ"))).toBe(true);

    const savedB = await withWorkspace(b.id, () =>
      saveSetup(
        context({
          asset_name: "Velmara",
          therapeutic_area: "Oncology",
          treatment_settings: ["2L"],
          objectives: [
            { id: "", name: "Support reimbursement", description: "", strategic_importance: 5, owner: "", key_decision: "P&T", decision_date: "2027-03-31" },
          ],
        }),
        false,
      ),
    );
    expect(savedB.status).toBe(200);

    const stateA = await withWorkspace(a.id, loadState);
    const stateB = await withWorkspace(b.id, loadState);

    expect(stateA.asset.name).toBe("Nova");
    expect(stateA.asset.indication).toBe("Moderate-to-severe psoriasis");
    expect(stateA.asset.geography).toBe("US + EU5");
    expect(stateA.asset.setup_complete).toBe(true);
    expect(stateA.objectives.map((objective) => objective.name)).toEqual(["Win HTA in EU5", "Differentiate vs JAKs"]);
    expect(stateA.objectives[0]).toMatchObject({ key_decision: "EU5 HTA filing", decision_date: "2028-03-01", strategic_importance: 5, lifecycle_stage: "pre-launch" });

    expect(stateB.asset.name).toBe("Velmara");
    expect(stateB.asset.setup_complete).toBe(false);
    expect(stateB.objectives.map((objective) => objective.name)).toEqual(["Support reimbursement"]);
    expect(parsePlanningContext(stateB.asset.planning_context).therapeutic_area).toBe("Oncology");

    // Revisiting the wizard shows the saved values.
    const again = setupContextFromState(stateA);
    expect(again.plan_owner).toBe("J. Park");
    expect(again.payer_hta_bodies).toEqual(["NICE", "G-BA / IQWiG"]);
    expect(again.objectives.map((objective) => objective.id)).toEqual(stateA.objectives.map((objective) => objective.id));

    // Stages read it: S8/S10 context, and settings on Gaps / Prioritize.
    const s8 = prioritizationContextFromState(stateA);
    expect(s8.key_decision).toBe("EU5 HTA filing");
    expect(s8.decision_date).toBe("2028-03-01");
    expect(s8.lifecycle_stage).toBe("pre-launch");
    expect(s8.competitor_pressure).toMatch(/high/);
    expect(s8.payer_hta_bodies).toEqual(["NICE", "G-BA / IQWiG"]);
    expect(s8.treatment_settings).toEqual(["1L biologic", "2L biologic"]);
    expect(settingOptions(stateA)).toEqual(expect.arrayContaining(["1L biologic", "2L biologic"]));
    expect(settingOptions(stateB)).not.toContain("1L biologic");
  }, 60_000);

  it("updates objectives by id on a later save, and keeps setup complete", async () => {
    const ws = await createWorkspace({ name: `Edit later ${unique()}`, owner: `edit-${unique()}@example.com` });
    const first = await withWorkspace(ws.id, () => saveSetup(context(), true));
    const saved = first.json.context!;
    const edited = {
      ...saved,
      company_situation: "Readout was positive.",
      objectives: [{ ...saved.objectives[0]!, name: "Win HTA in EU5 and UK" }],
    };
    const second = await withWorkspace(ws.id, () => saveSetup(edited, false));
    expect(second.status).toBe(200);
    const state = await withWorkspace(ws.id, loadState);
    expect(state.objectives).toHaveLength(1);
    expect(state.objectives[0]).toMatchObject({ id: saved.objectives[0]!.id, name: "Win HTA in EU5 and UK" });
    expect(state.asset.setup_complete).toBe(true);
    expect(parsePlanningContext(state.asset.planning_context).company_situation).toBe("Readout was positive.");
  }, 60_000);

  it("refuses to finish with required answers missing, and to drop objectives gaps still use", async () => {
    const ws = await createWorkspace({ name: `Guards ${unique()}`, owner: `guards-${unique()}@example.com` });
    const missing = await withWorkspace(ws.id, () => saveSetup(context({ asset_name: "", plan_owner: "" }), true));
    expect(missing.status).toBe(400);
    expect(missing.json.error).toMatch(/Name the asset/);
    const draft = await withWorkspace(ws.id, () => saveSetup(context({ asset_name: "", plan_owner: "" }), false));
    expect(draft.status).toBe(200);

    await withWorkspace(ws.id, resetWorkedExample);
    const seeded = await withWorkspace(ws.id, loadState);
    const used = seeded.objectives.find((objective) => seeded.gaps.some((gap) => gap.objective_id === objective.id))!;
    const others = setupContextFromState(seeded).objectives.filter((objective) => objective.id !== used.id);
    await expect(
      withWorkspace(ws.id, () =>
        saveProductSetup({ context: context({ objectives: others }), actor_name: ACTOR.actor_name, actor_function: ACTOR.actor_function }),
      ),
    ).rejects.toThrow(/linked to gaps or needs/);
  }, 60_000);

  it("a brand-new workspace starts the wizard empty, not with the template asset", async () => {
    const ws = await createWorkspace({ name: `Fresh ${unique()}`, owner: `fresh-${unique()}@example.com` });
    const state = await withWorkspace(ws.id, loadState);
    const initial = setupContextFromState(state, { fresh: true });
    expect(initial.asset_name).toBe("");
    expect(initial.objectives).toEqual([]);
  });
});

describe("walkthrough progress", () => {
  it("is remembered per person and per workspace", async () => {
    const owner = `tour-${unique()}@example.com`;
    const a = await createWorkspace({ name: "Tour A", owner });
    const b = await createWorkspace({ name: "Tour B", owner });
    await withWorkspace(a.id, () => saveWalkthrough("ana@example.com", { status: "active", step: 3 }));
    await withWorkspace(b.id, () => saveWalkthrough("ana@example.com", { status: "done", step: 6 }));
    await withWorkspace(a.id, () => saveWalkthrough("ben@example.com", { status: "dismissed", step: 1 }));

    expect(await withWorkspace(a.id, () => getWalkthrough("ana@example.com"))).toMatchObject({ status: "active", step: 3 });
    expect(await withWorkspace(b.id, () => getWalkthrough("ana@example.com"))).toMatchObject({ status: "done", step: 6 });
    expect(await withWorkspace(a.id, () => getWalkthrough("ben@example.com"))).toMatchObject({ status: "dismissed", step: 1 });
    expect(await withWorkspace(b.id, () => getWalkthrough("ben@example.com"))).toMatchObject({ status: "not_started", step: 0 });
  });

  it("the route starts, advances, dismisses and restarts the tour", async () => {
    const ws = await createWorkspace({ name: `Tour route ${unique()}`, owner: `route-${unique()}@example.com` });
    const post = (body: Record<string, unknown>) =>
      withWorkspace(ws.id, async () => {
        const res = await walkthroughPost(
          new Request("http://localhost/api/walkthrough", { method: "POST", body: JSON.stringify(body) }),
        );
        return { status: res.status, json: (await res.json()) as { progress?: { status: string; step: number } } };
      });
    const get = () =>
      withWorkspace(ws.id, async () => {
        const res = await walkthroughGet(new Request("http://localhost/api/walkthrough"));
        return ((await res.json()) as { progress: { status: string; step: number } }).progress;
      });

    expect(await get()).toMatchObject({ status: "not_started" });
    expect((await post({ action: "start", step: 0 })).json.progress).toMatchObject({ status: "active", step: 0 });
    await post({ action: "step", step: 4 });
    expect(await get()).toMatchObject({ status: "active", step: 4 });
    await post({ action: "dismiss", step: 4 });
    expect(await get()).toMatchObject({ status: "dismissed", step: 4 });
    await post({ action: "restart" });
    expect(await get()).toMatchObject({ status: "active", step: 0 });
    expect((await post({ action: "nope" })).status).toBe(400);
  });
});
