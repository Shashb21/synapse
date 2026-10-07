/** The owner API accepts only an action/stage and uses server-selected identity. */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as owner from "@/modules/auth/owner";
import * as admin from "@/modules/workspaces/admin-context";
import * as revisions from "@/modules/kernel/prompt-revisions";
import { GET, POST } from "@/app/api/admin/learning/route";
import { sql } from "drizzle-orm";
import { sharedDb } from "@/modules/kernel/db";
import { listDecisionExamples } from "@/modules/kernel/decision-examples";
import { NextResponse } from "next/server";
afterEach(() => vi.restoreAllMocks());
const request = (body: unknown) => new Request("http://localhost/api/admin/learning", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
describe("owner learning API", () => {
  it("denies non-owners before reading or generating", async () => {
    vi.spyOn(owner, "ownerGate").mockResolvedValue(NextResponse.json({ code: "owner_only" }, { status: 403 }));
    expect((await GET(new Request("http://localhost/api/admin/learning"))).status).toBe(403);
    expect((await POST(request({ action: "propose", stage: "S2" }))).status).toBe(403);
  });
  it("rejects forged workspace, actor, holdouts and unknown actions", async () => {
    for (const extra of [{ workspace_id: "foreign" }, { actor: { name: "forged" } }, { exclude_ids: [] }]) expect((await POST(request({ action: "propose", stage: "S2", ...extra }))).status).toBe(400);
    expect((await POST(request({ action: "activate", stage: "S2" }))).status).toBe(400);
    expect((await POST(request({ action: "propose", stage: "S5" }))).status).toBe(400);
  });
  it("resolves workspace and actor on the server and never accepts exclusions", async () => {
    const actor = { name: "Authenticated Owner", function: "medical_affairs" as const };
    vi.spyOn(owner, "ownerAccess").mockResolvedValue({ owner: true, actor } as Awaited<ReturnType<typeof owner.ownerAccess>>);
    const scope = vi.spyOn(admin, "withAdminWorkspace").mockImplementation(async fn => fn({ id: "selected", name: "Selected", schema_name: "public", demo: false, source: "picked" }));
    const propose = vi.spyOn(revisions, "proposePromptRevision").mockResolvedValue({ id: "candidate", state: "candidate" } as revisions.PromptRevision);
    const response = await POST(request({ action: "propose", stage: "S2" }));
    expect(response.status).toBe(201);
    expect(scope.mock.calls[0]).toHaveLength(1);
    expect(propose).toHaveBeenCalledWith({ stage: "S2", workspace_id: "selected", actor, exclude_ids: [] });
  });
  it("reports every selected-workspace decision beyond the former global cap", async () => {
    const workspace_id = `report-${crypto.randomUUID()}`;
    await listDecisionExamples({ limit: 1 });
    await sharedDb().execute(sql`insert into decision_examples (id, workspace_id, stage, kind, subject_id, ai_input, ai_output, outcome, created_at)
      select ${workspace_id} || '-' || n, ${workspace_id}, 'S2', 'gap_suggestion', 'subject-' || n, '{}'::jsonb, '{}'::jsonb, 'accepted', '2026-10-05T12:00:00Z' from generate_series(1, 501) n`);
    vi.spyOn(admin, "withAdminWorkspace").mockImplementation(async fn => fn({ id: workspace_id, name: "Report", schema_name: "public", demo: false, source: "picked" }));
    const response = await GET(new Request("http://localhost/api/admin/learning?workspace_id=foreign"));
    const body = await response.json();
    expect(response.status).toBe(200); expect(body.total).toBe(501);
    expect(body.agreement[0]).toMatchObject({ total: 501, accepted: 501, accepted_share: 1 });
    expect(body.workspace.id).toBe(workspace_id);
    expect((await listDecisionExamples({ workspace_id, limit: null })).length).toBe(501);
    expect((await listDecisionExamples({ workspace_id })).length).toBe(500);
  });

});
