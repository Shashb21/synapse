/** Route responses own actionable fallback wording even for unforeseen failures. */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as owner from "@/modules/auth/owner";
import * as tenant from "@/accuracy/store/tenant";
import * as claimEdit from "@/accuracy/store/claim-edit";
import * as sourceSeed from "@/accuracy/store/seed-from-gold";
import { POST as createClaim } from "@/app/api/accuracy/claims/route";
import { POST as seed } from "@/app/api/accuracy/seed/route";
import { customerErrorResponse } from "@/app/api/admin/customers/_shared";
import { postJson } from "@/lib/post-json";
const secret = "SELECT * FROM private WHERE password=sample-secret provider failed";
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe("final API recovery", () => {
  it("the claim route sends a task-specific check-before-repeat message through the browser boundary", async () => {
    vi.spyOn(tenant, "getWorkspace").mockResolvedValue({ id: "w", org_id: "o" } as Awaited<ReturnType<typeof tenant.getWorkspace>>);
    vi.spyOn(owner, "ownerGate").mockResolvedValue(null);
    vi.spyOn(owner, "ownerAccess").mockResolvedValue({ actor: { name: "owner", function: "medical_affairs" } } as Awaited<ReturnType<typeof owner.ownerAccess>>);
    vi.spyOn(claimEdit, "createManualClaim").mockRejectedValue(new Error(secret));
    const response = await createClaim(new Request("http://localhost/api/accuracy/claims", { method: "POST", body: JSON.stringify({ workspace_id: "w", claim_type: "gap", statement: "Gap", rationale: "Reason" }) }));
    const body = await response.clone().json(); expect(body.error).toMatch(/creat.*claim/i); expect(body.error).toMatch(/check.*before/i); expect(body.error).not.toContain(secret);
    vi.stubGlobal("fetch", vi.fn(async () => response));
    expect((await postJson("/api/accuracy/claims", {})).json.error).toBe(body.error);
  });
  it.each(["read", "create", "update", "delete", "assign", "unassign"])("customer administration %s gives usable recovery", async action => {
    const body = await customerErrorResponse(new Error(secret), action).json();
    expect(body.error).toMatch(/customer|seat/i); expect(body.error).toMatch(/reload|check|load/i); expect(body.error).not.toContain(secret); expect(body.error).not.toContain("That did not work");
  });
  it("successful seed responses project arbitrary partial parse failures to fixed recovery", async () => {
    vi.spyOn(owner, "ownerGate").mockResolvedValue(null);
    vi.spyOn(sourceSeed, "seedWorkspaceFromGold").mockResolvedValue({ org_id: "o", workspace_id: "w", source_file_id: "s", gaps: 1, tactics: 2, parse_blocks: 0, parse_error: secret, parse_skipped: null, pack_id: "p" });
    const response = await seed(new Request("http://localhost/api/accuracy/seed", { method: "POST", body: JSON.stringify({ pack_id: "p", parse_source: false }) }));
    const body = await response.json(); expect(body.ok).toBe(true); expect(body.parse_error).toMatch(/reading.*did not finish.*source/i); expect(JSON.stringify(body)).not.toContain(secret);
  });
});
