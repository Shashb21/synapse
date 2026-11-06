/** Route responses own actionable fallback wording even for unforeseen failures. */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as owner from "@/modules/auth/owner";
import { customerErrorResponse, invalidJson } from "@/app/api/admin/customers/_shared";
import { CustomerError } from "@/modules/auth/customers";
import { AccountError } from "@/modules/auth/accounts";
import * as adminUsers from "@/modules/auth/admin-users";
import * as session from "@/modules/auth/session";
import * as audit from "@/modules/kernel/audit";
import { POST as updateUser } from "@/app/api/admin/users/route";
import { postJson } from "@/lib/post-json";
const secret = "SELECT * FROM private WHERE password=sample-secret provider failed";
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe("final API recovery", () => {
  it.each(["read", "create", "update", "delete", "assign", "unassign"])("customer administration %s gives usable recovery", async action => {
    const body = await customerErrorResponse(new Error(secret), action).json();
    expect(body.error).toMatch(/customer|seat/i); expect(body.error).toMatch(/reload|check|load/i); expect(body.error).not.toContain(secret); expect(body.error).not.toContain("That did not work");
  });
});


describe("admin rejection outcomes", () => {
  it("allows correction of a malformed customer request before any write", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => invalidJson()));
    expect(await postJson("/api/admin/customers", {})).toMatchObject({
      ok: false, outcome: "rejected", json: { code: "invalid_json" },
    });
  });
  it("requires a state check for an unexpected customer write failure", async () => {
    const response = customerErrorResponse(new Error(secret), "create");
    vi.stubGlobal("fetch", vi.fn(async () => response));
    expect(await postJson("/api/admin/customers", {})).toMatchObject({
      ok: false, outcome: "unknown", json: { error: expect.stringMatching(/check.*before/i) },
    });
  });
  it.each(["invalid", "seat_limit", "taken", "conflict", "not_found"] as const)("allows correction after customer %s rejection", async code => {
    const response = customerErrorResponse(new CustomerError("Check the customer details and correct the entry.", code), "assign");
    vi.stubGlobal("fetch", vi.fn(async () => response));
    expect(await postJson("/api/admin/customers/c/seats", {})).toMatchObject({ ok: false, outcome: "rejected" });
  });
  it("requires a state check when customer lookup fails after removing a seat", async () => {
    const response = customerErrorResponse(new CustomerError("That customer does not exist.", "not_found"), "unassign");
    const body = await response.clone().json();
    expect(response.status).toBe(404);
    expect(body.code).toBe("not_found");
    expect(body.error).toMatch(/check.*before/i);
    vi.stubGlobal("fetch", vi.fn(async () => response));
    expect(await postJson("/api/admin/customers/c/seats", {})).toMatchObject({ ok: false, outcome: "unknown" });
  });
  it("allows correction after a staff-only account rejection", async () => {
    vi.spyOn(owner, "ownerGate").mockResolvedValue(null);
    vi.spyOn(owner, "ownerAccess").mockResolvedValue({ actor: { name: "owner" } } as Awaited<ReturnType<typeof owner.ownerAccess>>);
    vi.spyOn(session, "currentSession").mockResolvedValue(null);
    vi.spyOn(audit, "recordDenied").mockResolvedValue(undefined);
    vi.spyOn(adminUsers, "runAdminUserAction").mockRejectedValue(new AccountError("Choose the Platform operator role for staff."));
    const response = await updateUser(new Request("http://localhost/api/admin/users", { method: "POST", body: JSON.stringify({ action: "create" }) }));
    vi.stubGlobal("fetch", vi.fn(async () => response));
    expect(await postJson("/api/admin/users", {})).toMatchObject({ ok: false, outcome: "rejected" });
  });
});
