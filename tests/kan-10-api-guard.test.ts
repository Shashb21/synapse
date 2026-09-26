import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/** A request cookie jar the route handlers read and createSession/signOut write. */
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
import { loadState } from "@/lib/iegp/store";
import { POST as iegpPost } from "@/app/api/iegp/route";
import { iegpActionCapability } from "@/app/api/iegp/capabilities";
import { GET as planGet, POST as planPost } from "@/app/api/plan/route";
import { POST as modulesPost } from "@/app/api/modules/route";
import { GET as blocksGet, POST as blocksPost } from "@/app/api/sources/blocks/route";
import { GET as roomGet, POST as roomPost } from "@/app/api/room/route";
import { GET as walkthroughGet, POST as walkthroughPost } from "@/app/api/walkthrough/route";
import { POST as controlPost } from "@/app/api/control/route";
import { requireCustomerContext, testAnonymousApiAllowed } from "@/modules/auth/api-guard";
import { can, type Role } from "@/modules/auth/roles";
import { createSession, SESSION_COOKIE, signOut, type Session } from "@/modules/auth/session";
import { WORKSPACE_COOKIE, workspaceCookieValue } from "@/modules/workspaces/context";
import { createWorkspace, inviteMember, removeMember, withWorkspace, type Workspace } from "@/modules/workspaces/store";

const unique = Math.random().toString(36).slice(2, 8);
const OWNER_EMAIL = `kan10-owner-${unique}@example.com`;

type Person = { name: string; fn: ActorFunction; role: Role; email: string };
const LEAD: Person = { name: "Lead Lena", fn: "medical_affairs", role: "medical_affairs", email: OWNER_EMAIL };
const CONTRIBUTOR: Person = { name: "Contributor Carl", fn: "heor", role: "contributor", email: `kan10-c-${unique}@example.com` };
const VIEWER: Person = { name: "Viewer Vera", fn: "medical_affairs", role: "viewer", email: `kan10-v-${unique}@example.com` };
const OUTSIDER: Person = { name: "Outsider Olga", fn: "medical_affairs", role: "medical_affairs", email: `kan10-o-${unique}@example.com` };

let workspace: Workspace;

/** Signs in (a real auth_sessions row) and selects `ws` with a validly signed cookie. */
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

/**
 * Calls that reach the data layer run inside the workspace's query scope:
 * under Vitest, concurrent dynamic imports of the mocked next/headers (the db
 * resolver's cookie read) race and fall back to the real module. The guard
 * still checks membership of the scoped workspace against the session.
 */
function inWorkspace<T>(call: () => Promise<T>): Promise<T> {
  return withWorkspace(workspace.id, call);
}

function post(url: string, body: unknown): Request {
  return new Request(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function json(response: Response) {
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** Every customer route, as a signed-out caller would hit it. */
const CUSTOMER_CALLS: [string, () => Promise<Response>][] = [
  ["iegp POST", () => iegpPost(post("/api/iegp", { action: "reset", actor_name: "Mallory", actor_function: "medical_affairs" }))],
  ["plan GET", () => planGet()],
  ["plan POST", () => planPost(post("/api/plan", { action: "save_plan", status: "draft" }))],
  ["modules POST", () => modulesPost(post("/api/modules", { stage: "S10", input: {} }))],
  ["sources/blocks GET", () => blocksGet(new Request("http://localhost/api/sources/blocks?source_id=SRC-1"))],
  ["sources/blocks POST", () => blocksPost(post("/api/sources/blocks", { action: "delete", block_id: "B1", rationale: "tidy" }))],
  ["room GET", () => roomGet(new Request("http://localhost/api/room"))],
  ["room POST", () => roomPost(post("/api/room", { op: "bump" }))],
  ["walkthrough GET", () => walkthroughGet(new Request("http://localhost/api/walkthrough?actor_name=Mallory"))],
  ["walkthrough POST", () => walkthroughPost(post("/api/walkthrough", { action: "start", actor_name: "Mallory" }))],
  ["control save_axes", () => controlPost(post("/api/control", { action: "save_axes", config: {} }))],
];

beforeAll(async () => {
  // The Vitest-only anonymous path is off here: every call needs a real session.
  vi.stubEnv("SYNAPSE_TEST_ANON_API", "0");
  workspace = await createWorkspace({ name: `KAN-10 ${unique}`, owner: OWNER_EMAIL });
  for (const person of [CONTRIBUTOR, VIEWER]) {
    await inviteMember({ workspace_id: workspace.id, email: person.email, by: OWNER_EMAIL });
  }
  // Seed the workspace's plan as its lead.
  await signIn(LEAD);
  const reset = await json(await inWorkspace(() => iegpPost(post("/api/iegp", { action: "reset" }))));
  expect(reset).toEqual({ status: 200, body: { ok: true } });
}, 60_000);

afterAll(() => {
  vi.unstubAllEnvs();
  jar.values.clear();
});

beforeEach(() => jar.values.clear());

describe("KAN-10: every customer API needs a live session", () => {
  it.each(CUSTOMER_CALLS)("%s without a session → 401 no_session", async (_name, call) => {
    const { status, body } = await json(await call());
    expect(status).toBe(401);
    expect(body.code).toBe("no_session");
  });

  it.each(CUSTOMER_CALLS)("%s after sign-out, replaying the old cookies → 401", async (_name, call) => {
    await signIn(LEAD);
    const stolen = new Map(jar.values);
    await signOut();
    for (const [name, value] of stolen) jar.values.set(name, value);
    const { status } = await json(await call());
    expect(status).toBe(401);
  });

  it("an unknown session id is refused even with a workspace cookie signed for it", async () => {
    jar.values.set(SESSION_COOKIE, "forged-session-id");
    jar.values.set(WORKSPACE_COOKIE, workspaceCookieValue(workspace.id, "forged-session-id"));
    const { status } = await json(await planGet());
    expect(status).toBe(401);
  });

  it("the anonymous path exists only under Vitest's explicit opt-in and never in production", () => {
    expect(testAnonymousApiAllowed({ NODE_ENV: "test", SYNAPSE_TEST_STUB_LLM: "1", SYNAPSE_TEST_ANON_API: "1" })).toBe(true);
    expect(testAnonymousApiAllowed({ NODE_ENV: "production", SYNAPSE_TEST_STUB_LLM: "1", SYNAPSE_TEST_ANON_API: "1" })).toBe(false);
    expect(testAnonymousApiAllowed({ NODE_ENV: "development", SYNAPSE_TEST_STUB_LLM: "1" })).toBe(false);
    expect(testAnonymousApiAllowed({ NODE_ENV: "test", SYNAPSE_TEST_ANON_API: "1" })).toBe(false);
  });
});

describe("KAN-10: workspace membership is checked on every request", () => {
  it("a non-member with a validly signed workspace cookie → 403 not_member", async () => {
    await signIn(OUTSIDER);
    for (const [, call] of CUSTOMER_CALLS) {
      const { status, body } = await json(await call());
      expect(status).toBe(403);
      expect(body.code).toBe("not_member");
    }
  });

  it("a removed member loses access at once, with the same cookies", async () => {
    const person: Person = { ...CONTRIBUTOR, name: "Removed Rita", email: `kan10-r-${unique}@example.com` };
    await inviteMember({ workspace_id: workspace.id, email: person.email, by: OWNER_EMAIL });
    await signIn(person);
    expect((await inWorkspace(planGet)).status).toBe(200);
    await removeMember({ workspace_id: workspace.id, principal: person.email, by: OWNER_EMAIL });
    const { status, body } = await json(await planGet());
    expect(status).toBe(403);
    expect(body.code).toBe("not_member");
    expect((await inWorkspace(planGet)).status).toBe(403);
    expect((await iegpPost(post("/api/iegp", { action: "create_gap", statement: "Should not land." }))).status).toBe(403);
  });

  it("save_axes with a session but no workspace selected is refused, never the Default workspace", async () => {
    await signIn(LEAD, null);
    const { status, body } = await json(await controlPost(post("/api/control", { action: "save_axes", config: {} })));
    expect(status).toBe(409);
    expect(body.code).toBe("no_workspace");
  });

  it("a workspace cookie signed for another session does not verify", async () => {
    const other = await signIn(LEAD);
    const foreign = workspaceCookieValue(workspace.id, `${other.id}-someone-else`);
    jar.values.set(WORKSPACE_COOKIE, foreign);
    const { status, body } = await json(await planGet());
    expect(status).toBe(409);
    expect(body.code).toBe("no_workspace");
  });
});

describe("KAN-10: roles are enforced server-side", () => {
  it("maps every /api/iegp action to a capability; reset needs Medical Affairs", () => {
    expect(iegpActionCapability("reset")).toBe("reset_workspace");
    expect(iegpActionCapability("ingest")).toBe("upload");
    expect(iegpActionCapability("validate_gap")).toBe("validate");
    expect(iegpActionCapability("no_such_action")).toBeUndefined();
    expect(iegpActionCapability("toString")).toBeUndefined();
    expect(can("medical_affairs", "reset_workspace")).toBe(true);
    expect(can("contributor", "reset_workspace")).toBe(false);
    expect(can("viewer", "reset_workspace")).toBe(false);
  });

  it("a viewer can read but cannot reset, validate, edit, run S10, save a plan, edit blocks or drive the room", async () => {
    await signIn(VIEWER);
    expect((await inWorkspace(planGet)).status).toBe(200);
    expect((await inWorkspace(() => roomGet(new Request("http://localhost/api/room")))).status).toBe(200);
    const refused: [string, () => Promise<Response>][] = [
      ["reset", () => iegpPost(post("/api/iegp", { action: "reset" }))],
      ["validate_gap", () => iegpPost(post("/api/iegp", { action: "validate_gap", gap_id: "GAP-001" }))],
      ["create_gap", () => iegpPost(post("/api/iegp", { action: "create_gap", statement: "Viewer gap." }))],
      ["ingest", () => iegpPost(post("/api/iegp", { action: "ingest", title: "x", text: "y" }))],
      ["S10 run", () => modulesPost(post("/api/modules", { stage: "S10", input: {} }))],
      ["save_plan draft", () => planPost(post("/api/plan", { action: "save_plan", status: "draft" }))],
      ["save_plan final", () => planPost(post("/api/plan", { action: "save_plan", status: "final" }))],
      ["block edit", () => blocksPost(post("/api/sources/blocks", { action: "delete", block_id: "B1", rationale: "tidy" }))],
      ["room slide", () => roomPost(post("/api/room", { op: "slide", slide_id: "s1" }))],
      ["room note", () => roomPost(post("/api/room", { op: "note", slide_id: "s1", notes: "hi" }))],
      ["save_axes", () => controlPost(post("/api/control", { action: "save_axes", config: {} }))],
    ];
    for (const [name, call] of refused) {
      const { status, body } = await json(await call());
      expect({ name, status, code: body.code }).toEqual({ name, status: 403, code: "forbidden" });
    }
  });

  it("a contributor can edit but cannot save final or reset", async () => {
    await signIn(CONTRIBUTOR);
    const created = await json(
      await inWorkspace(() => iegpPost(post("/api/iegp", { action: "create_gap", statement: `Contributor gap ${unique}.` }))),
    );
    expect(created.status).toBe(200);
    expect((await json(await iegpPost(post("/api/iegp", { action: "reset" })))).status).toBe(403);
    const final = await json(await planPost(post("/api/plan", { action: "save_plan", status: "final" })));
    expect(final.status).toBe(403);
    expect(final.body.code).toBe("forbidden");
    // A draft is an edit: not refused on role (it may still fail on plan content).
    const draft = await json(await inWorkspace(() => planPost(post("/api/plan", { action: "save_plan", status: "draft" }))));
    expect(draft.status).not.toBe(403);
    // S10 is an edit capability now, not "export".
    const s10 = await json(await inWorkspace(() => modulesPost(post("/api/modules", { stage: "S10", input: {} }))));
    expect(s10.status).not.toBe(403);
  }, 60_000);

  it("records the signed-in person as the actor, whatever the body says", async () => {
    await signIn(CONTRIBUTOR);
    const statement = `Forged actor gap ${unique}.`;
    const res = await json(
      await inWorkspace(() =>
        iegpPost(
          post("/api/iegp", {
            action: "create_gap",
            statement,
            actor_name: "Forged Name",
            actor_function: "evidence_lead",
          }),
        ),
      ),
    );
    expect(res.status).toBe(200);
    const state = await withWorkspace(workspace.id, loadState);
    const gap = state.gaps.find((row) => row.statement === statement);
    expect(gap).toBeDefined();
    expect(gap?.status_lock.actor_name).toBe(CONTRIBUTOR.name);
    expect(gap?.status_lock.actor_function).toBe(CONTRIBUTOR.fn);
    expect(state.audit.some((row) => row.actor_name === "Forged Name")).toBe(false);
  }, 60_000);

  it("the guard returns the session's actor, role and verified workspace", async () => {
    await signIn(VIEWER);
    const context = await requireCustomerContext({ body: { actor_name: "Forged", actor_function: "heor" } });
    expect(context.actor).toEqual({ name: VIEWER.name, function: VIEWER.fn });
    expect(context.role).toBe("viewer");
    expect(context.workspace?.id).toBe(workspace.id);
    expect(context.anonymous_test).toBe(false);
  });
});

describe("KAN-10: request errors", () => {
  it("malformed JSON is a 400, not a 500", async () => {
    await signIn(LEAD);
    for (const call of [
      () => iegpPost(post("/api/iegp", "{not json")),
      () => planPost(post("/api/plan", "{not json")),
      () => modulesPost(post("/api/modules", "{not json")),
      () => roomPost(post("/api/room", "{not json")),
      () => walkthroughPost(post("/api/walkthrough", "{not json")),
      () => controlPost(post("/api/control", "{not json")),
      () => blocksPost(post("/api/sources/blocks", "{not json")),
    ]) {
      const { status, body } = await json(await call());
      expect(status).toBe(400);
      expect(body.code).toBe("invalid_json");
    }
  });
});
