import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** An in-memory cookie jar standing in for the browser, shared by every route call. */
const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => void jar.set(name, value),
    delete: (name: string) => void jar.delete(name),
  }),
}));

import { POST as loginPost } from "@/app/api/auth/login/route";
import { POST as logoutPost } from "@/app/api/auth/logout/route";
import { GET as callbackGet } from "@/app/api/auth/callback/route";
import { GET as listGet, POST as createPost } from "@/app/api/workspaces/route";
import { POST as selectPost } from "@/app/api/workspaces/select/route";
import { GET as oneGet, PATCH as renamePatch } from "@/app/api/workspaces/[id]/route";
import {
  DELETE as membersDelete,
  GET as membersGet,
  POST as membersPost,
} from "@/app/api/workspaces/[id]/members/route";
import { gateFor } from "@/modules/auth/gate";
import { afterSignIn, safeNext } from "@/modules/auth/redirect";
import { loginOptions, signInDemo } from "@/modules/auth/session";
import { WORKSPACE_COOKIE } from "@/modules/workspaces/context";
import { currentWorkspace } from "@/modules/workspaces/session";

const unique = () => Math.random().toString(36).slice(2, 8);

function req(url: string, method = "GET", body?: Record<string, unknown>) {
  return new Request(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
async function json(res: Response) {
  return (await res.json()) as Record<string, unknown> & { error?: string };
}

async function signInAs(name: string, email: string) {
  jar.clear();
  const res = await loginPost(req("/api/auth/login", "POST", { demo: true, actor_name: name, email }));
  expect(res.status).toBe(200);
  return json(res);
}

async function createWs(name: string) {
  const res = await createPost(req("/api/workspaces", "POST", { name }));
  const body = await json(res);
  expect(res.status, body.error).toBe(201);
  return body as { workspace: { id: string; name: string; role: string }; redirect: string };
}

describe("login and workspaces API", () => {
  beforeEach(() => jar.clear());
  afterEach(() => vi.unstubAllEnvs());

  it("refuses workspace calls without a session", async () => {
    expect((await listGet()).status).toBe(401);
    expect((await createPost(req("/api/workspaces", "POST", { name: "Nope" }))).status).toBe(401);
    expect((await selectPost(req("/api/workspaces/select", "POST", { workspace_id: "default" }))).status).toBe(401);
  });

  it("demo sign-in lands on the workspace picker and never keeps a previous workspace", async () => {
    jar.set(WORKSPACE_COOKIE, "stale.selection");
    const body = await loginPost(
      req("/api/auth/login", "POST", { demo: true, actor_name: "Picker Test", next: "/timeline" }),
    ).then(json);
    expect(body.redirect).toBe("/workspaces?next=%2Ftimeline");
    expect(jar.has("synapse_session")).toBe(true);
    expect(jar.has(WORKSPACE_COOKIE)).toBe(false);
  });

  it("demo sign-in needs a name", async () => {
    const res = await loginPost(req("/api/auth/login", "POST", { demo: true, actor_name: "  " }));
    expect(res.status).toBe(400);
  });

  it("creates a workspace, opens it, and sends a new one to setup", async () => {
    const email = `creator-${unique()}@example.com`;
    await signInAs("Creator", email);
    const created = await createWs("Velmara EU launch");
    expect(created.redirect).toBe("/setup?new=1");
    expect(created.workspace.role).toBe("owner");
    expect(jar.get(WORKSPACE_COOKIE)?.startsWith(`${created.workspace.id}.`)).toBe(true);
    expect((await currentWorkspace())?.id).toBe(created.workspace.id);

    const list = (await listGet().then(json)) as {
      current_id: string;
      person: { name: string; email: string };
      workspaces: { id: string; name: string; role: string; created_at: string }[];
    };
    expect(list.person).toEqual({ name: "Creator", email });
    expect(list.current_id).toBe(created.workspace.id);
    const row = list.workspaces.find((ws) => ws.id === created.workspace.id)!;
    expect(row).toMatchObject({ name: "Velmara EU launch", role: "owner" });
    expect(row.created_at).toMatch(/^\d{4}-/);

    const short = await createPost(req("/api/workspaces", "POST", { name: "x" }));
    expect(short.status).toBe(400);
  });

  it("switching workspace is membership-checked and honours only same-site next paths", async () => {
    await signInAs("Switcher", `switcher-${unique()}@example.com`);
    const a = await createWs("Switch A");
    const b = await createWs("Switch B");
    const toA = await selectPost(req("/api/workspaces/select", "POST", { workspace_id: a.workspace.id, next: "/timeline" })).then(json);
    expect(toA.redirect).toBe("/timeline");
    expect((await currentWorkspace())?.id).toBe(a.workspace.id);
    const toB = await selectPost(
      req("/api/workspaces/select", "POST", { workspace_id: b.workspace.id, next: "https://evil.example" }),
    ).then(json);
    expect(toB.redirect).toBe("/");
    expect((await currentWorkspace())?.id).toBe(b.workspace.id);

    await signInAs("Stranger", `stranger-${unique()}@example.com`);
    const refused = await selectPost(req("/api/workspaces/select", "POST", { workspace_id: a.workspace.id }));
    expect(refused.status).toBe(404);
    expect(jar.has(WORKSPACE_COOKIE)).toBe(false);
    expect((await oneGet(req(`/api/workspaces/${a.workspace.id}`), ctx(a.workspace.id))).status).toBe(404);
  });

  it("owners rename and remove; any member invites; members cannot rename or remove", async () => {
    const ownerEmail = `owner-${unique()}@example.com`;
    const guestEmail = `guest-${unique()}@example.com`;
    const otherEmail = `other-${unique()}@example.com`;
    await signInAs("Owner", ownerEmail);
    const { workspace } = await createWs("Shared plan");
    const id = workspace.id;

    const renamed = await renamePatch(req(`/api/workspaces/${id}`, "PATCH", { name: "Shared plan · EU" }), ctx(id)).then(json);
    expect((renamed.workspace as { name: string }).name).toBe("Shared plan · EU");

    const invited = await membersPost(req(`/api/workspaces/${id}/members`, "POST", { email: guestEmail.toUpperCase() }), ctx(id));
    expect(invited.status).toBe(201);
    expect(((await json(invited)).members as { principal: string }[]).map((m) => m.principal)).toEqual([
      ownerEmail,
      guestEmail,
    ]);
    const bad = await membersPost(req(`/api/workspaces/${id}/members`, "POST", { email: "not-an-email" }), ctx(id));
    expect(bad.status).toBe(400);

    // The invitee sees the workspace when they sign in.
    await signInAs("Guest", guestEmail);
    const guestList = (await listGet().then(json)) as { workspaces: { id: string; role: string }[] };
    expect(guestList.workspaces.find((ws) => ws.id === id)?.role).toBe("member");
    const detail = await oneGet(req(`/api/workspaces/${id}`), ctx(id)).then(json);
    expect((detail.workspace as { name: string }).name).toBe("Shared plan · EU");

    expect((await renamePatch(req(`/api/workspaces/${id}`, "PATCH", { name: "Hijack" }), ctx(id))).status).toBe(403);
    expect((await membersPost(req(`/api/workspaces/${id}/members`, "POST", { email: otherEmail }), ctx(id))).status).toBe(201);
    expect(
      (await membersDelete(req(`/api/workspaces/${id}/members`, "DELETE", { principal: otherEmail }), ctx(id))).status,
    ).toBe(403);

    await signInAs("Owner", ownerEmail);
    const removed = await membersDelete(
      req(`/api/workspaces/${id}/members?principal=${encodeURIComponent(otherEmail)}`, "DELETE"),
      ctx(id),
    ).then(json);
    expect((removed.members as { principal: string }[]).map((m) => m.principal)).toEqual([ownerEmail, guestEmail]);
    const ownerGone = await membersDelete(req(`/api/workspaces/${id}/members`, "DELETE", { principal: ownerEmail }), ctx(id));
    expect(ownerGone.status).toBe(400);
    const listed = await membersGet(req(`/api/workspaces/${id}/members`), ctx(id)).then(json);
    expect((listed.members as unknown[]).length).toBe(2);
  });

  it("sign-out ends the session and forgets the workspace", async () => {
    await signInAs("Leaver", `leaver-${unique()}@example.com`);
    await createWs("Leaving");
    expect(jar.has(WORKSPACE_COOKIE)).toBe(true);
    const out = await logoutPost().then(json);
    expect(out.redirect).toBe("/login");
    expect(jar.has("synapse_session")).toBe(false);
    expect(jar.has(WORKSPACE_COOKIE)).toBe(false);
    expect((await listGet()).status).toBe(401);
  });

  it("an OAuth callback without a code goes back to /login with the reason", async () => {
    const res = await callbackGet(req("/api/auth/callback?error=access_denied"));
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("error")).toBe("access_denied");
  });

  it("never offers or accepts demo sign-in in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(loginOptions().demo).toBe(false);
    await expect(signInDemo({ actor_name: "Prod", actor_function: "medical_affairs" })).rejects.toThrow(/not available in production/);
    const res = await loginPost(req("/api/auth/login", "POST", { demo: true, actor_name: "Prod" }));
    expect(res.status).toBe(400);
    expect(jar.has("synapse_session")).toBe(false);
  });

  it("offers demo sign-in in development", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(loginOptions().demo).toBe(true);
  });
});

describe("proxy gate and redirects", () => {
  it("gates customer routes by session and workspace, and leaves auth, admin and assets open", () => {
    for (const path of ["/login", "/api/auth/callback", "/api/auth/login", "/api/oauth/llm/callback", "/admin", "/admin/runs", "/api/accuracy/extract", "/api/control", "/_next/static/x.js", "/favicon.ico", "/logo.svg"]) {
      expect(gateFor(path), path).toBe("open");
    }
    for (const path of ["/workspaces", "/workspaces/w123", "/api/workspaces", "/api/workspaces/select"]) {
      expect(gateFor(path), path).toBe("session");
    }
    for (const path of ["/", "/setup", "/timeline", "/room", "/gaps/g1", "/api/iegp", "/api/plan", "/api/modules", "/api/sources/blocks", "/loginx", "/administrator"]) {
      expect(gateFor(path), path).toBe("workspace");
    }
  });

  it("only follows same-site next paths, never back to the auth pages", () => {
    expect(safeNext("/timeline?x=1")).toBe("/timeline?x=1");
    expect(safeNext("//evil.example")).toBe("/");
    expect(safeNext("https://evil.example")).toBe("/");
    expect(safeNext("/login")).toBe("/");
    expect(safeNext("/workspaces?new=1")).toBe("/");
    expect(afterSignIn(null)).toBe("/workspaces");
    expect(afterSignIn("/gaps")).toBe("/workspaces?next=%2Fgaps");
  });
});
