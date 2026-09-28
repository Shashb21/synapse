import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/** A request cookie jar the route handlers read and createSession/selectWorkspace write. */
const jar = vi.hoisted(() => ({ values: new Map<string, string>() }));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.values.has(name) ? { name, value: jar.values.get(name)! } : undefined),
    set: (name: string, value: string) => void jar.values.set(name, value),
    delete: (name: string) => void jar.values.delete(name),
  }),
  headers: async () => new Headers(),
}));

import "@/modules";
import type { ActorFunction } from "@/lib/iegp/enums";
import { buildBlankWorkspace } from "@/lib/iegp/blank";
import { buildSeed } from "@/lib/iegp/seed";
import { enteredAssetDetails, assetSubtitle } from "@/lib/iegp/asset";
import { prioritizationContextFromState, setupContextFromState } from "@/lib/iegp/planning-context";
import { createGap, loadState, resetBlank, resetDemo, resetDemoSetup } from "@/lib/iegp/store";
import { POST as iegpPost } from "@/app/api/iegp/route";
import { iegpActionCapability } from "@/app/api/iegp/capabilities";
import { GET as workspacesGet, POST as workspacesPost } from "@/app/api/workspaces/route";
import type { Role } from "@/modules/auth/roles";
import { createSession, type Session } from "@/modules/auth/session";
import { timelineMarkers } from "@/modules/stages/s10-timeline/gap-view";
import { WORKSPACE_COOKIE, workspaceCookieValue } from "@/modules/workspaces/context";
import { startChoice } from "@/modules/workspaces/contents";
import { createWorkspace, getWorkspace, inviteMember, withWorkspace, type Workspace } from "@/modules/workspaces/store";

const unique = Math.random().toString(36).slice(2, 8);
const DEMO_WORDS = /velmara|velmaratinib|OBJ-|NSCLC|osimertinib|NX-441|Okonkwo|Hale|Rao/i;

type Person = { name: string; fn: ActorFunction; role: Role; email: string };
const OWNER: Person = { name: "Owner Olu", fn: "medical_affairs", role: "medical_affairs", email: `kan26-o-${unique}@example.com` };
/** Medical Affairs by role, but only a member of the workspace. */
const MEMBER: Person = { name: "Member Mo", fn: "medical_affairs", role: "medical_affairs", email: `kan26-m-${unique}@example.com` };
const CONTRIBUTOR: Person = { name: "Contrib Cy", fn: "heor", role: "contributor", email: `kan26-c-${unique}@example.com` };

let workspace: Workspace;

async function signIn(person: Person, ws: Workspace | null = workspace): Promise<Session> {
  jar.values.clear();
  const session = await createSession({
    provider_id: "demo",
    subject: `demo:${person.name}`,
    email: person.email,
    actor_name: person.name,
    actor_function: person.fn,
    role: person.role,
  });
  if (ws) jar.values.set(WORKSPACE_COOKIE, workspaceCookieValue(ws.id, session.id));
  return session;
}

function post(url: string, body: unknown): Request {
  return new Request(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function json(response: Response) {
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const inWorkspace = <T,>(id: string, call: () => Promise<T>) => withWorkspace(id, call);

describe("KAN-26: a blank workspace is truly blank", () => {
  it("has an empty asset and no objectives, decisions, sources, gaps or tactics", () => {
    const state = buildBlankWorkspace();
    expect(state.asset).toMatchObject({ name: "", inn: "", indication: "", geography: "", setup_complete: false });
    expect(state.objectives).toEqual([]);
    for (const key of ["sources", "blocks", "needs", "gaps", "tactics", "coverages", "priorities", "roadmap"] as const) {
      expect(state[key], key).toEqual([]);
    }
    expect(JSON.stringify(state)).not.toMatch(DEMO_WORDS);
  });

  it("puts no key-decision markers on the timeline and prefills nothing in setup", () => {
    const state = buildBlankWorkspace();
    expect(timelineMarkers(state)).toEqual([]);
    const setup = setupContextFromState(state);
    expect(setup.asset_name).toBe("");
    expect(setup.objectives).toEqual([]);
    const context = prioritizationContextFromState(state);
    expect(context.key_decision).toBeUndefined();
    expect(context.decision_date).toBeUndefined();
    expect(JSON.stringify(context)).not.toMatch(DEMO_WORDS);
  });

  it("the demo still carries its markers, so the difference is the data, not the timeline", () => {
    expect(timelineMarkers(buildSeed()).filter((marker) => marker.kind === "key_decision").length).toBeGreaterThan(0);
  });

  it("readers treat empty asset fields as not entered", () => {
    expect(enteredAssetDetails(buildBlankWorkspace().asset)).toBeUndefined();
    expect(enteredAssetDetails({ name: " Nova ", inn: "", indication: "Psoriasis", geography: " " })).toEqual({
      name: "Nova",
      indication: "Psoriasis",
    });
    expect(assetSubtitle({ inn: "", indication: "", geography: "" })).toBe("");
    expect(assetSubtitle({ inn: "novamab", indication: "", geography: "US" })).toBe("novamab · US");
  });

  it("stores a blank plan with nothing in it, and a gap can still be added by hand", async () => {
    const ws = await createWorkspace({ name: `KAN-26 blank ${unique}`, owner: OWNER.email });
    const state = await inWorkspace(ws.id, async () => {
      await resetBlank();
      await createGap({ statement: "No real-world data in frail patients.", actor_name: "T", actor_function: "medical_affairs" });
      return loadState();
    });
    expect(state.asset.name).toBe("");
    expect(state.objectives).toHaveLength(0);
    expect(state.gaps).toHaveLength(1);
    expect(state.gaps[0]!.objective_id).toBe("");
    expect(timelineMarkers(state)).toEqual([]);
    expect(JSON.stringify(state)).not.toMatch(DEMO_WORDS);
  }, 60_000);

  it("a workspace nobody has touched loads as blank", async () => {
    const ws = await createWorkspace({ name: `KAN-26 fresh ${unique}`, owner: OWNER.email });
    const state = await inWorkspace(ws.id, loadState);
    expect(state.asset.name).toBe("");
    expect(state.objectives).toHaveLength(0);
    expect(ws.demo).toBe(false);
  }, 60_000);

  it("the store resets are named for what they load", async () => {
    const ws = await createWorkspace({ name: `KAN-26 names ${unique}`, owner: OWNER.email });
    await inWorkspace(ws.id, async () => {
      const demo = await resetDemo();
      expect(demo.gaps.length).toBe(buildSeed().gaps.length);
      const setup = await resetDemoSetup();
      expect(setup.asset.name).toBe("Velmara");
      expect(setup.objectives.length).toBe(buildSeed().objectives.length);
      expect(setup.gaps).toHaveLength(0);
      const blank = await resetBlank();
      expect(blank.asset.name).toBe("");
      expect(blank.objectives).toHaveLength(0);
    });
  }, 60_000);
});

describe("KAN-26: demo data on request", () => {
  beforeAll(async () => {
    vi.stubEnv("SYNAPSE_TEST_ANON_API", "0");
    workspace = await createWorkspace({ name: `KAN-26 ${unique}`, owner: OWNER.email });
    await inviteMember({ workspace_id: workspace.id, email: MEMBER.email, by: OWNER.email });
    await inviteMember({ workspace_id: workspace.id, email: CONTRIBUTOR.email, by: OWNER.email });
  }, 60_000);

  afterAll(() => {
    vi.unstubAllEnvs();
    jar.values.clear();
  });

  beforeEach(() => jar.values.clear());

  it("parses the create choice: only an explicit demo starts with demo data", () => {
    expect(startChoice("demo")).toBe("demo");
    for (const value of [undefined, "", "blank", "DEMO", true, 1]) expect(startChoice(value)).toBe("blank");
  });

  it("creating a workspace starts blank by default", async () => {
    await signIn(OWNER, null);
    const created = await json(await workspacesPost(post("/api/workspaces", { name: `Blank ${unique}` })));
    expect(created.status).toBe(201);
    const ws = created.body.workspace as { id: string; demo: boolean };
    expect(ws.demo).toBe(false);
    expect(created.body.redirect).toBe("/setup?new=1");
    const state = await inWorkspace(ws.id, loadState);
    expect(state.asset.name).toBe("");
    expect(state.objectives).toHaveLength(0);
    expect(state.gaps).toHaveLength(0);
  }, 60_000);

  it("creating with demo data loads the full seed and flags the workspace", async () => {
    await signIn(OWNER, null);
    const created = await json(await workspacesPost(post("/api/workspaces", { name: `Demo ${unique}`, start: "demo" })));
    expect(created.status).toBe(201);
    const ws = created.body.workspace as { id: string; demo: boolean };
    expect(ws.demo).toBe(true);
    expect(created.body.redirect).toBe("/");
    expect((await getWorkspace(ws.id))?.demo).toBe(true);

    const seed = buildSeed();
    const state = await inWorkspace(ws.id, loadState);
    expect(state.asset.name).toBe("Velmara");
    expect(state.objectives.map((o) => o.id).sort()).toEqual(seed.objectives.map((o) => o.id).sort());
    expect(state.sources).toHaveLength(seed.sources.length);
    expect(state.gaps).toHaveLength(seed.gaps.length);
    // The demo plan adds one proposed activity (the CNS sub-study) on top of the seed tactics.
    expect(state.tactics).toHaveLength(seed.tactics.length + 1);

    // The list reports the flag, for the Demo badge.
    const listed = await json(await workspacesGet());
    const rows = listed.body.workspaces as { id: string; demo: boolean }[];
    expect(rows.find((row) => row.id === ws.id)?.demo).toBe(true);
  }, 60_000);

  it("load_demo and reset share the reset_workspace capability", () => {
    expect(iegpActionCapability("load_demo")).toBe("reset_workspace");
    expect(iegpActionCapability("reset")).toBe("reset_workspace");
  });

  it("the owner can load the demo into an existing workspace, then reset it to blank", async () => {
    await signIn(OWNER);
    const loaded = await json(await inWorkspace(workspace.id, () => iegpPost(post("/api/iegp", { action: "load_demo" }))));
    expect(loaded).toEqual({ status: 200, body: { ok: true } });
    expect((await getWorkspace(workspace.id))?.demo).toBe(true);
    const demo = await inWorkspace(workspace.id, loadState);
    expect(demo.gaps).toHaveLength(buildSeed().gaps.length);
    expect(timelineMarkers(demo).length).toBeGreaterThan(0);

    const reset = await json(await inWorkspace(workspace.id, () => iegpPost(post("/api/iegp", { action: "reset" }))));
    expect(reset).toEqual({ status: 200, body: { ok: true } });
    expect((await getWorkspace(workspace.id))?.demo).toBe(false);
    const blank = await inWorkspace(workspace.id, loadState);
    expect(blank.asset.name).toBe("");
    expect(blank.objectives).toHaveLength(0);
    expect(blank.sources).toHaveLength(0);
    expect(blank.gaps).toHaveLength(0);
    expect(blank.tactics).toHaveLength(0);
    expect(timelineMarkers(blank)).toEqual([]);
  }, 60_000);

  it("load_demo with scope setup loads only the demo asset and objectives", async () => {
    await signIn(OWNER);
    const loaded = await json(
      await inWorkspace(workspace.id, () => iegpPost(post("/api/iegp", { action: "load_demo", scope: "setup" }))),
    );
    expect(loaded.status).toBe(200);
    const state = await inWorkspace(workspace.id, loadState);
    expect(state.asset.name).toBe("Velmara");
    expect(state.objectives.length).toBeGreaterThan(0);
    expect(state.sources).toHaveLength(0);
    expect(state.gaps).toHaveLength(0);
    expect((await getWorkspace(workspace.id))?.demo).toBe(true);
    await inWorkspace(workspace.id, () => iegpPost(post("/api/iegp", { action: "reset" })));
  }, 60_000);

  it("a member who is not the owner cannot load the demo or reset, even with Medical Affairs rights", async () => {
    await signIn(MEMBER);
    await inWorkspace(workspace.id, () =>
      createGap({ statement: `Kept ${unique}: no PRO data.`, actor_name: "Member Mo", actor_function: "medical_affairs" }),
    );
    for (const action of ["load_demo", "reset"]) {
      const refused = await json(await inWorkspace(workspace.id, () => iegpPost(post("/api/iegp", { action }))));
      expect({ action, status: refused.status, code: refused.body.code }).toEqual({ action, status: 403, code: "forbidden" });
    }
    const state = await inWorkspace(workspace.id, loadState);
    expect(state.gaps.some((gap) => gap.statement.startsWith(`Kept ${unique}`))).toBe(true);
    expect((await getWorkspace(workspace.id))?.demo).toBe(false);
  }, 60_000);

  it("a contributor is refused by role", async () => {
    await signIn(CONTRIBUTOR);
    for (const action of ["load_demo", "reset"]) {
      const refused = await json(await inWorkspace(workspace.id, () => iegpPost(post("/api/iegp", { action }))));
      expect(refused.status).toBe(403);
    }
    expect((await getWorkspace(workspace.id))?.demo).toBe(false);
  }, 60_000);
});

describe("KAN-26: the demo opens with a prioritized plan and a timeline", () => {
  it("validates the demo bands and dates the mapped tactics, with one working dependency", async () => {
    const { replaceContentsOf } = await import("@/modules/workspaces/contents");
    const { gapTimelineView } = await import("@/modules/stages/s10-timeline/gap-view");
    const { timelineModel } = await import("@/modules/stages/s10-timeline/module");
    const { listPlacements } = await import("@/modules/stages/s8-prioritization/module");
    const owner = `demo-plan-${Math.random().toString(36).slice(2, 8)}@example.com`;
    const ws = await createWorkspace({ name: "Demo plan", owner });
    await replaceContentsOf(ws.id, "demo");
    await withWorkspace(ws.id, async () => {
      const placements = await listPlacements();
      expect(placements.filter((row) => row.validated).map((row) => [row.gap_id, row.band]).sort()).toEqual(
        [["GAP-CAREGIVER", "low"], ["GAP-CNS", "high"], ["GAP-IRA", "medium"], ["GAP-PERSIST", "high"]],
      );
      const [state, model] = await Promise.all([loadState(), timelineModel()]);
      const view = gapTimelineView({ state, placements, model });
      expect(view.prioritized.map((group) => group.gap_id)).toEqual(["GAP-CNS", "GAP-PERSIST", "GAP-IRA", "GAP-CAREGIVER"]);
      const dated = view.prioritized.flatMap((group) => group.items).filter((item) => item.activity);
      expect(dated.length).toBeGreaterThanOrEqual(3);
      expect(view.conflicts).toEqual([]);
      expect(model.activities.some((activity) => activity.depends_on.length > 0)).toBe(true);
    });
    // Only the full demo gets the plan: the setup-only fixture stays unprioritized.
    await replaceContentsOf(ws.id, "demo_setup");
    await withWorkspace(ws.id, async () => {
      expect((await listPlacements()).length).toBe(0);
    });
  }, 60_000);
});
