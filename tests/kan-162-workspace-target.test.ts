import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

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
import * as workspaceDb from "@/lib/iegp/db";
import { loadState, resetDemoSetup } from "@/lib/iegp/store";
import { POST as iegpPost } from "@/app/api/iegp/route";
import type { Role } from "@/modules/auth/roles";
import { createSession, type Session } from "@/modules/auth/session";
import { WORKSPACE_COOKIE, workspaceCookieValue } from "@/modules/workspaces/context";
import { createWorkspace, getWorkspace, inviteMember, withWorkspace, type Workspace } from "@/modules/workspaces/store";
import { listAuditEvents } from "@/modules/kernel/audit";
import * as audit from "@/modules/kernel/audit";
import { setWorkspaceDemo } from "@/modules/workspaces/store";
import { postJson } from "@/lib/post-json";
const unique = crypto.randomUUID();
const owner = `kan162-${unique}@example.com`;
let a: Workspace;
let b: Workspace;
let session: Session;
const request = (body: unknown) => new Request("http://localhost/api/iegp", { method: "POST", body: JSON.stringify(body) });
async function selected(ws: Workspace, role: Role = "medical_affairs", email = owner) {
  jar.values.clear();
  session = await createSession({ provider_id: "demo", subject: email, email, actor_name: "Verified owner", actor_function: "medical_affairs", role });
  jar.values.set(WORKSPACE_COOKIE, workspaceCookieValue(ws.id, session.id));
}
async function snapshot(ws: Workspace) {
  return { state: await withWorkspace(ws.id, loadState), demo: (await getWorkspace(ws.id))?.demo, audit: await listAuditEvents({ workspace_id: ws.id }) };
}
beforeAll(async () => {
  vi.stubEnv("SYNAPSE_TEST_ANON_API", "0");
  a = await createWorkspace({ name: "KAN162 A", owner });
  b = await createWorkspace({ name: "KAN162 B", owner });
  await withWorkspace(a.id, resetDemoSetup);
  await withWorkspace(b.id, resetDemoSetup);
}, 60_000);
afterAll(() => { vi.unstubAllEnvs(); jar.values.clear(); });

describe.each(["reset", "load_demo"])("%s fixed workspace", (action) => {
  it("rejects a changed authenticated selection without changing either workspace or audits", async () => {
    // Arrange: the dialog was opened in A; another tab selected B using this real session.
    await selected(a);
    jar.values.set(WORKSPACE_COOKIE, workspaceCookieValue(b.id, session.id));
    const before = await Promise.all([snapshot(a), snapshot(b)]);
    const schema = vi.spyOn(workspaceDb, "currentSchemaName");
    // Act: use a real authenticated cookie, with the matching database scope used by route tests.
    const response = await withWorkspace(b.id, () => iegpPost(request({ action, expected_workspace_id: a.id })));
    // Assert: mismatch must not even add a denial audit.
    expect(schema).not.toHaveBeenCalled();
    schema.mockRestore();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ safe_error: true, request_outcome: "rejected", code: "workspace_mismatch", error: "The selected workspace changed. Reopen the intended workspace and try again. No contents were changed." });
    expect(await Promise.all([snapshot(a), snapshot(b)])).toEqual(before);
  });
  it.each([undefined, null, 123, "", [], {}])("rejects malformed target %j before writes", async (target) => {
    await selected(a);
    const before = await snapshot(a);
    const response = await withWorkspace(a.id, () => iegpPost(request({ action, expected_workspace_id: target })));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_request" });
    expect(await snapshot(a)).toEqual(before);
  });
  it("allows the matching owner and attributes the action to the session", async () => {
    await selected(a);
    const response = await withWorkspace(a.id, () => iegpPost(request({ action, expected_workspace_id: a.id, scope: "setup", actor_name: "Spoof", actor_function: "heor" })));
    expect(response.status).toBe(200);
    expect((await getWorkspace(a.id))?.demo).toBe(action === "load_demo");
    const events = (await listAuditEvents({ workspace_id: a.id })).events;
    expect(events.find(e => e.action === (action === "reset" ? "workspace.reset_blank" : "workspace.load_demo_setup"))).toMatchObject({ actor_name: "Verified owner", actor_principal: owner });
  });
  it.each(["member", "capability"])("rejects a mismatched %s target before denial audits or schema initialization", async (kind) => {
    const email = `${kind}-mismatch-${owner}`;
    await inviteMember({ workspace_id: b.id, email, by: owner });
    await selected(b, kind === "capability" ? "contributor" : "medical_affairs", email);
    const before = await Promise.all([snapshot(a), snapshot(b)]);
    const schema = vi.spyOn(workspaceDb, "currentSchemaName");
    const response = await withWorkspace(b.id, () => iegpPost(request({ action, expected_workspace_id: a.id })));
    expect(schema).not.toHaveBeenCalled();
    schema.mockRestore();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "workspace_mismatch" });
    expect(await Promise.all([snapshot(a), snapshot(b)])).toEqual(before);
  });
  it.each(["member", "capability"])("retains %s rejection for matching targets", async (kind) => {
    const email = `${kind}-${owner}`;
    await inviteMember({ workspace_id: a.id, email, by: owner });
    await selected(a, kind === "capability" ? "contributor" : "medical_affairs", email);
    const before = await withWorkspace(a.id, loadState);
    const response = await withWorkspace(a.id, () => iegpPost(request({ action, expected_workspace_id: a.id })));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "forbidden" });
    expect(await withWorkspace(a.id, loadState)).toEqual(before);
  });
});


describe.each(["reset", "load_demo"])("%s atomic replacement", (action) => {
  it("rolls back contents and demo metadata when the required audit fails", async () => {
    // Arrange: start with the opposite flag so the committed shared write is visible.
    await selected(a);
    await setWorkspaceDemo(a.id, action === "reset");
    const before = await withWorkspace(a.id, loadState);
    const failure = vi.spyOn(audit, "recordAuditVia").mockRejectedValueOnce(new Error("private audit failure"));
    try {
      // Act: fail the required audit after contents and metadata have been written.
      const response = await withWorkspace(a.id, () => iegpPost(request({ action, expected_workspace_id: a.id, scope: "setup" })));
      expect(response.status).toBe(400);
      expect((await getWorkspace(a.id))?.demo).toBe(action === "reset");
      expect(await withWorkspace(a.id, loadState)).toEqual(before);
      vi.stubGlobal("fetch", vi.fn(async () => response));
      // Assert: a rejected outcome is truthful only after every write rolls back.
      expect(await postJson("/api/iegp", {})).toMatchObject({ ok: false, outcome: "rejected" });
    } finally {
      failure.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});
