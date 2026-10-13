import { describe, expect, it, vi } from "vitest";

// The routes read the session cookie; outside a request there is none.
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
  headers: async () => new Headers(),
}));

import "@/modules";
import { GET as gapGet } from "@/app/api/gaps/[id]/route";
import { GET as orphansGet } from "@/app/api/admin/gap-orphans/route";
import { createGap, resetDemoSetup } from "@/lib/iegp/store";
import { resetWorkspaceModules } from "@/modules/kernel/db";

/** KAN-97: the gap record export and the owner's orphan check. */
describe("KAN-97 gap record API", () => {
  it("GET /api/gaps/[id] returns the whole record, or 404 for an unknown gap", async () => {
    await resetDemoSetup();
    await resetWorkspaceModules();
    const gapId = await createGap({ name: "Export me", statement: "Export this gap.", domain: "unmet_need", actor_name: "KAN-97", actor_function: "heor" });
    const ok = await gapGet(new Request(`http://localhost/api/gaps/${gapId}`), { params: Promise.resolve({ id: gapId }) });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { gap: { id: string }; needs: unknown[]; confirmation: { confirmed: boolean } };
    expect(body.gap.id).toBe(gapId);
    expect(body.needs.length).toBeGreaterThan(0);
    expect(body.confirmation.confirmed).toBe(false);
    const missing = await gapGet(new Request("http://localhost/api/gaps/GAP-NOPE"), { params: Promise.resolve({ id: "GAP-NOPE" }) });
    expect(missing.status).toBe(404);
  });

  it("GET /api/admin/gap-orphans counts rows pointing at retired or missing gaps", async () => {
    await resetDemoSetup();
    await resetWorkspaceModules();
    const res = await orphansGet(new Request("http://localhost/api/admin/gap-orphans"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { count: number; orphans: unknown[] };
    expect(body.count).toBe(body.orphans.length);
  });
});
