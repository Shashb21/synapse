/** Preloaded identity reuses the existing owner decision without an additional session read. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const session = vi.hoisted(() => vi.fn());
const admin = vi.hoisted(() => vi.fn());
vi.mock("@/modules/auth/session", () => ({ sessionContext: session }));
vi.mock("@/modules/auth/accounts", () => ({ isAdminAccount: admin, PASSWORD_PROVIDER: "password" }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
import { ownerAccess } from "@/modules/auth/owner";
import type { sessionContext } from "@/modules/auth/session";
const context = {
  actor: { name: "Customer", function: "medical_affairs" }, role: "medical_affairs",
  signed_in: true, demo: false,
  session: { subject: "customer", provider_id: "okta", email: "customer@example.test" },
} as Awaited<ReturnType<typeof sessionContext>>;
beforeEach(() => { vi.stubEnv("SYNAPSE_TEST_STUB_LLM", "0"); session.mockReset(); admin.mockReset(); });
afterEach(() => vi.unstubAllEnvs());
it("does not grant owner access to a preloaded customer or read their session again", async () => {
  expect((await ownerAccess(context)).owner).toBe(false);
  expect(session).not.toHaveBeenCalled();
});
it("preserves the password admin-account check for a preloaded identity", async () => {
  admin.mockResolvedValue(true);
  expect((await ownerAccess({ ...context, session: { ...context.session!, provider_id: "password" } })).owner).toBe(true);
  admin.mockRejectedValue(new Error("database unavailable"));
  expect((await ownerAccess({ ...context, session: { ...context.session!, provider_id: "password" } })).owner).toBe(false);
  expect(session).not.toHaveBeenCalled();
});
it("surfaces a password admin lookup failure when the caller requires confirmed authorization", async () => {
  // Arrange: a valid password session exists, but account authorization cannot be read.
  const passwordContext = { ...context, session: { ...context.session!, provider_id: "password" } };
  admin.mockRejectedValue(new Error("authorization store unavailable"));
  // Act / Assert: control-panel reads must distinguish unavailable from confirmed denial.
  await expect(ownerAccess(passwordContext, { requireConfirmedLookup: true })).rejects.toThrow("authorization store unavailable");
  expect(session).not.toHaveBeenCalled();
});

vi.mock("@/modules/kernel/ai-switch", () => ({
  aiSwitch: async () => ({ enabled: true, updated_by: null, updated_at: null, rationale: null }),
  storedAiSections: async () => ({ sections: {} }),
}));
vi.mock("@/modules/kernel/registry", () => ({ stageWiring: async () => [] }));
vi.mock("@/modules/kernel/routing", () => ({ routeConfigs: async () => [], resolveRoute: vi.fn() }));
import { loadControlPanel } from "@/components/platform/control-panel-load";
it("marks real owner lookup failure unavailable in the control-panel loader without leaking its error", async () => {
  const passwordContext = { ...context, session: { ...context.session!, provider_id: "password" } };
  session.mockResolvedValue(passwordContext);
  admin.mockResolvedValueOnce(true).mockRejectedValue(new Error("select secret from admin_accounts; token=private"));
  // The initial page guard can confirm the owner before a later account lookup fails.
  expect((await ownerAccess(passwordContext)).owner).toBe(true);
  const logging = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const result = await loadControlPanel();
    expect(result.owner).toEqual({ status: "unavailable" });
    expect(result.identity.status).toBe("ready");
    expect(result.master.status).toBe("ready");
    expect(JSON.stringify(result)).not.toContain("token=private");
    expect(session).toHaveBeenCalledTimes(1);
  } finally { logging.mockRestore(); }
});

it("keeps normal identity failures denied while confirmed reads surface the same failure", async () => {
  session.mockRejectedValue(new Error("identity service unavailable"));
  expect((await ownerAccess()).owner).toBe(false);
  await expect(ownerAccess(undefined, { requireConfirmedLookup: true })).rejects.toThrow("identity service unavailable");
});
