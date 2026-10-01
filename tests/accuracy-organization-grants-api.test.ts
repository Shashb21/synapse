import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as grantOrganizationAccess } from "@/app/api/accuracy/organizations/[org_id]/grants/route";
import { createOrganization, createWorkspace, deleteWorkspace, getAuthorizedWorkspace } from "@/accuracy/store/tenant";

const { sessionContext } = vi.hoisted(() => ({ sessionContext: vi.fn() }));
vi.mock("@/modules/auth/session", () => ({ sessionContext }));

const createdWorkspaces: string[] = [];

beforeEach(() => {
  sessionContext.mockResolvedValue({
    signed_in: true,
    session: { subject: "operator-subject" },
    actor: { name: "Platform operator", function: "medical_affairs" },
    role: "operator",
  });
});

afterEach(async () => {
  for (const workspace_id of createdWorkspaces.splice(0)) await deleteWorkspace(workspace_id);
});

describe("existing organization access grants", () => {
  it("lets an operator provision a contributor for an existing organization", async () => {
    const org_id = await createOrganization(`existing-org-${Date.now()}`);
    const workspace_id = await createWorkspace({ org_id, name: "Existing workspace", slug: `existing-${Date.now()}` });
    createdWorkspaces.push(workspace_id);

    const response = await grantOrganizationAccess(
      new Request(`http://localhost/api/accuracy/organizations/${org_id}/grants`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subject: "existing-contributor" }),
      }),
      { params: Promise.resolve({ org_id }) },
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ ok: true, org_id, subject: "existing-contributor" });
    await expect(getAuthorizedWorkspace({ workspace_id, subject: "existing-contributor", role: "contributor" }))
      .resolves.toMatchObject({ id: workspace_id });
  });

  it("refuses a non-operator grant request", async () => {
    const org_id = await createOrganization(`protected-org-${Date.now()}`);
    const workspace_id = await createWorkspace({ org_id, name: "Protected workspace", slug: `protected-${Date.now()}` });
    createdWorkspaces.push(workspace_id);
    sessionContext.mockResolvedValue({
      signed_in: true,
      session: { subject: "viewer-subject" },
      actor: { name: "Viewer", function: "medical_affairs" },
      role: "viewer",
    });

    const response = await grantOrganizationAccess(
      new Request(`http://localhost/api/accuracy/organizations/${org_id}/grants`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subject: "viewer-subject" }),
      }),
      { params: Promise.resolve({ org_id }) },
    );

    expect(response.status).toBe(403);
    await expect(getAuthorizedWorkspace({ workspace_id, subject: "viewer-subject", role: "viewer" })).resolves.toBeNull();
  });

  it("does not create a grant for an unknown organization", async () => {
    const org_id = `missing-org-${Date.now()}`;

    const response = await grantOrganizationAccess(
      new Request(`http://localhost/api/accuracy/organizations/${org_id}/grants`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subject: "existing-contributor" }),
      }),
      { params: Promise.resolve({ org_id }) },
    );

    expect(response.status).toBe(404);
  });
});
