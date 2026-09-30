import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/** A request cookie jar the route handlers read and createSession writes. */
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
import { GET as aiGet, POST as aiPost } from "@/app/api/workspaces/[id]/ai/route";
import { aiEnabled, aiState, setAiEnabled } from "@/modules/kernel/ai-switch";
import type { Role } from "@/modules/auth/roles";
import { createSession } from "@/modules/auth/session";
import { WORKSPACE_AI_AUDIT } from "@/modules/workspaces/ai-setting";
import { WORKSPACE_COOKIE, workspaceCookieValue } from "@/modules/workspaces/context";
import { createWorkspace, getWorkspace, inviteMember, withWorkspace, type Workspace } from "@/modules/workspaces/store";

/** The owner-only, audited POST /api/workspaces/[id]/ai. */

const unique = Math.random().toString(36).slice(2, 8);
type Person = { name: string; fn: ActorFunction; role: Role; email: string };
const OWNER: Person = { name: "Owner Olive", fn: "medical_affairs", role: "medical_affairs", email: `ai-set-o-${unique}@example.com` };
const MEMBER: Person = { name: "Member Milo", fn: "heor", role: "medical_affairs", email: `ai-set-m-${unique}@example.com` };
const OUTSIDER: Person = { name: "Outsider Oz", fn: "medical_affairs", role: "medical_affairs", email: `ai-set-x-${unique}@example.com` };

let workspace: Workspace;
let other: Workspace;

async function signIn(person: Person, ws: Workspace = workspace) {
  jar.values.clear();
  const session = await createSession({
    provider_id: "demo",
    subject: `demo:${person.name}`,
    email: person.email,
    actor_name: person.name,
    actor_function: person.fn,
    role: person.role,
  });
  jar.values.set(WORKSPACE_COOKIE, workspaceCookieValue(ws.id, session.id));
  return session;
}

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function post(id: string, body: unknown) {
  const res = await aiPost(
    new Request(`http://localhost/api/workspaces/${id}/ai`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    params(id),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function aiAudit(ws: Workspace) {
  const state = await withWorkspace(ws.id, loadState);
  return state.audit.filter((row) => row.entity_type === WORKSPACE_AI_AUDIT.entity_type && row.entity_id === ws.id);
}

beforeAll(async () => {
  vi.stubEnv("SYNAPSE_TEST_ANON_API", "0");
  await setAiEnabled({ enabled: true, actor_name: OWNER.name });
  workspace = await createWorkspace({ name: `AI setting ${unique}`, owner: OWNER.email, ai_enabled: true });
  other = await createWorkspace({ name: `AI setting other ${unique}`, owner: OWNER.email, ai_enabled: true });
  await inviteMember({ workspace_id: workspace.id, email: MEMBER.email, by: OWNER.email });
}, 60_000);

afterAll(async () => {
  vi.unstubAllEnvs();
  jar.values.clear();
  await setAiEnabled({ enabled: true, actor_name: OWNER.name });
});

beforeEach(() => jar.values.clear());

describe("AI toggle in settings: the workspace AI API", () => {
  it("needs a session", async () => {
    expect((await post(workspace.id, { enabled: false })).status).toBe(401);
  });

  it("a member gets 403 and the setting does not change", async () => {
    await signIn(MEMBER);
    const res = await post(workspace.id, { enabled: false });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("forbidden");
    expect(String(res.body.error)).toMatch(/only the workspace owner/i);
    expect((await getWorkspace(workspace.id))!.ai_enabled).toBe(true);

    // A member still reads the state.
    const read = await aiGet(new Request(`http://localhost/api/workspaces/${workspace.id}/ai`), params(workspace.id));
    expect(read.status).toBe(200);
    expect(((await read.json()) as { ai: { enabled: boolean }; role: string })).toMatchObject({
      ai: { enabled: true },
      role: "member",
    });
  });

  it("someone outside the workspace gets 403", async () => {
    await signIn(OUTSIDER, other);
    expect((await post(workspace.id, { enabled: false })).status).toBe(403);
  });

  it("rejects a body without a boolean", async () => {
    await signIn(OWNER);
    expect((await post(workspace.id, { enabled: "off" })).status).toBe(400);
  });

  it("the owner turns it off and on; each change is audited with the session's actor", async () => {
    await signIn(OWNER);
    const before = (await aiAudit(workspace)).length;

    const off = await post(workspace.id, { enabled: false });
    expect(off.status).toBe(200);
    expect(off.body.ai).toMatchObject({ enabled: false, workspace: false, platform: true, off_by: "workspace" });
    expect((await getWorkspace(workspace.id))!.ai_enabled).toBe(false);
    // The request's own workspace (from the signed cookie) now resolves AI as off.
    expect(await aiEnabled()).toBe(false);
    // The other workspace is untouched.
    expect((await aiState(other.id)).enabled).toBe(true);

    const rows = await aiAudit(workspace);
    expect(rows.length).toBe(before + 1);
    const entry = rows.find((row) => row.action === WORKSPACE_AI_AUDIT.off)!;
    expect(entry).toMatchObject({ actor_name: OWNER.name, actor_function: OWNER.fn, action: "ai_disabled" });

    // The same value again is not a change and files nothing.
    expect((await post(workspace.id, { enabled: false })).status).toBe(200);
    expect((await aiAudit(workspace)).length).toBe(before + 1);

    const on = await post(workspace.id, { enabled: true });
    expect(on.body.ai).toMatchObject({ enabled: true, off_by: null });
    const after = await aiAudit(workspace);
    expect(after.length).toBe(before + 2);
    expect(after.some((row) => row.action === WORKSPACE_AI_AUDIT.on && row.actor_name === OWNER.name)).toBe(true);
  });

  it("with the platform master switch off, the workspace setting cannot turn AI on", async () => {
    await setAiEnabled({ enabled: false, actor_name: OWNER.name });
    try {
      await signIn(OWNER);
      const res = await post(workspace.id, { enabled: true });
      expect(res.status).toBe(200);
      expect(res.body.ai).toMatchObject({ enabled: false, workspace: true, platform: false, off_by: "platform" });
      expect(await aiEnabled()).toBe(false);
    } finally {
      await setAiEnabled({ enabled: true, actor_name: OWNER.name });
    }
  });
});
