import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@/modules/auth/session";
import type { Workspace } from "@/modules/workspaces/store";

const auth = vi.hoisted(() => ({
  session: null as Session | null,
  workspace: null as Workspace | null,
  member: true,
  approve: vi.fn(async () => 2),
}));
vi.mock("@/modules/auth/session", async importOriginal => ({
  ...(await importOriginal<typeof import("@/modules/auth/session")>()),
  currentSession: async () => auth.session,
}));
vi.mock("@/modules/workspaces/context", async importOriginal => ({
  ...(await importOriginal<typeof import("@/modules/workspaces/context")>()),
  selectedWorkspaceId: async () => "velmara",
}));
vi.mock("@/modules/workspaces/store", async importOriginal => ({
  ...(await importOriginal<typeof import("@/modules/workspaces/store")>()),
  getWorkspace: async () => auth.workspace,
  memberRole: async () => auth.member ? "member" : null,
}));
vi.mock("@/modules/kernel/audit", async importOriginal => ({
  ...(await importOriginal<typeof import("@/modules/kernel/audit")>()),
  recordDenied: vi.fn(async () => undefined),
}));
vi.mock("@/modules/stages/s9-ideation/module", () => ({ acceptDemoIdeationProposals: auth.approve }));

import { POST } from "@/app/api/demo/ideation-approvals/route";

const proposals = [
  { id: "first", expected_version: "a".repeat(64) },
  { id: "second", expected_version: "b".repeat(64) },
];

function approve(extra = {}) {
  return POST(new Request("http://localhost/api/demo/ideation-approvals", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspace_id: "velmara", proposals, rationale: "Presented Velmara options", ...extra }),
  }));
}

beforeEach(() => {
  vi.stubEnv("SYNAPSE_TEST_ANON_API", "0");
  vi.stubEnv("SYNAPSE_DEMO_RECORD", "0");
  auth.approve.mockClear();
  auth.member = true;
  auth.session = {
    id: "demo-session", provider_id: "demo", subject: "presenter", email: "presenter@example.com",
    actor: { name: "Actual presenter", function: "medical_affairs" }, role: "medical_affairs",
    created_at: "", expires_at: "",
  };
  auth.workspace = {
    id: "velmara", schema_name: "ws_velmara", name: "Presentations", demo: true, demo_mode: true,
    ai_enabled: true, created_by: "presenter@example.com", created_at: "",
  };
});

afterEach(() => vi.unstubAllEnvs());

describe("Velmara ideation approval endpoint", () => {
  it.each([
    ["unsigned", 401, "no_session"],
    ["nonmember", 403, "not_member"],
    ["viewer", 403, "forbidden"],
    ["demo data without client demo mode", 403, "forbidden"],
    ["no demo data", 403, "forbidden"],
  ] as const)("refuses a %s request without reaching the decision owner", async (problem, status, code) => {
    if (problem === "unsigned") auth.session = null;
    if (problem === "nonmember") auth.member = false;
    if (problem === "viewer") auth.session!.role = "viewer";
    if (problem === "demo data without client demo mode") auth.workspace!.demo_mode = false;
    if (problem === "no demo data") auth.workspace!.demo = false;
    const response = await approve();
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ code });
    expect(auth.approve).not.toHaveBeenCalled();
  });

  it.each([
    { proposals: [{ id: "first" }] },
    { proposals: [] },
    { rationale: " " },
    { actor: { name: "Forged" } },
    { judgement_origin: "manual" },
  ])("refuses unsupported approval inputs %j", async body => {
    const response = await approve(body);
    expect(response.status).toBe(400);
    expect(auth.approve).not.toHaveBeenCalled();
  });

  it("refuses a selection from a different workspace", async () => {
    const response = await approve({ workspace_id: "other" });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "workspace_mismatch" });
    expect(auth.approve).not.toHaveBeenCalled();
  });

  it("uses the verified Velmara scope, current actor and exact selection", async () => {
    const response = await approve();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, accepted: 2 });
    expect(auth.approve).toHaveBeenCalledOnce();
    expect(auth.approve).toHaveBeenCalledWith({
      workspace_id: "velmara", proposals, rationale: "Presented Velmara options", actor: auth.session?.actor,
      demo: { workspace_id: "velmara", fixture: "velmara-client-demo", mode: "replay" },
    });
  });
});
