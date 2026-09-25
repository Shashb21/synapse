import { describe, expect, it } from "vitest";
import "@/modules";
import { createGap, loadState, resetSeed } from "@/lib/iegp/store";
import { runStage } from "@/modules/kernel/run";
import { listRuns } from "@/modules/kernel/observability";
import { runInWorkspace, verifyWorkspaceCookie, workspaceCookieValue } from "@/modules/workspaces/context";
import {
  claimDefaultWorkspace,
  createWorkspace,
  DEFAULT_WORKSPACE_ID,
  inviteMember,
  listMembers,
  listWorkspacesFor,
  memberRole,
  removeMember,
  withWorkspace,
} from "@/modules/workspaces/store";

const ACTOR = { name: "Workspace Test", function: "medical_affairs" as const };
const unique = () => Math.random().toString(36).slice(2, 8);

async function addGap(statement: string) {
  return createGap({ statement, actor_name: ACTOR.name, actor_function: ACTOR.function });
}

describe("workspaces", () => {
  it("keeps each workspace's IEGP data in its own schema", async () => {
    const owner = `owner-${unique()}@example.com`;
    const a = await createWorkspace({ name: "Velmara EU", owner });
    const b = await createWorkspace({ name: "Velmara US", owner });

    await withWorkspace(a.id, async () => {
      await resetSeed();
      await addGap("Only in workspace A: no real-world data in elderly patients.");
    });
    await withWorkspace(b.id, async () => {
      await resetSeed();
    });

    const inA = await withWorkspace(a.id, loadState);
    const inB = await withWorkspace(b.id, loadState);
    expect(inA.gaps.some((gap) => gap.statement.startsWith("Only in workspace A"))).toBe(true);
    expect(inB.gaps.some((gap) => gap.statement.startsWith("Only in workspace A"))).toBe(false);

    // The Default workspace (public schema) never sees either.
    const inDefault = await loadState();
    expect(inDefault.gaps.some((gap) => gap.statement.startsWith("Only in workspace A"))).toBe(false);
  }, 60_000);

  it("scopes stage runs and their records to the workspace", async () => {
    const owner = `owner-${unique()}@example.com`;
    const a = await createWorkspace({ name: "Runs A", owner });
    const b = await createWorkspace({ name: "Runs B", owner });
    const run = await withWorkspace(a.id, async () => {
      await resetSeed();
      return runStage({ stage: "S7", input: {}, actor: ACTOR, role: "medical_affairs" });
    });
    const runsA = await withWorkspace(a.id, () => listRuns({ limit: 100 }));
    const runsB = await withWorkspace(b.id, () => listRuns({ limit: 100 }));
    expect(runsA.some((row) => row.id === run.run_id)).toBe(true);
    expect(runsB.some((row) => row.id === run.run_id)).toBe(false);
  }, 60_000);

  it("lists a person's workspaces, and invites and removals follow the owner", async () => {
    const owner = `Owner-${unique()}@Example.com`;
    const guest = `guest-${unique()}@example.com`;
    const ws = await createWorkspace({ name: "Shared plan", owner });
    expect(await memberRole(ws.id, owner.toLowerCase())).toBe("owner");

    await inviteMember({ workspace_id: ws.id, email: guest, by: owner });
    expect((await listWorkspacesFor(guest)).map((row) => row.id)).toContain(ws.id);
    expect((await listMembers(ws.id)).map((row) => row.principal)).toEqual([owner.toLowerCase(), guest]);

    await expect(inviteMember({ workspace_id: ws.id, email: "not-an-email", by: owner })).rejects.toThrow(/valid email/);
    await expect(inviteMember({ workspace_id: ws.id, email: "x@example.com", by: "stranger@example.com" })).rejects.toThrow(
      /not a member/,
    );
    await expect(removeMember({ workspace_id: ws.id, principal: owner, by: guest })).rejects.toThrow(/Only the workspace owner/);
    await removeMember({ workspace_id: ws.id, principal: guest, by: owner });
    expect(await memberRole(ws.id, guest)).toBeNull();
  });

  it("the first sign-in claims the Default workspace, later ones do not", async () => {
    const first = `first-${unique()}@example.com`;
    await claimDefaultWorkspace(first);
    const owner = await memberRole(DEFAULT_WORKSPACE_ID, first);
    const second = `second-${unique()}@example.com`;
    await claimDefaultWorkspace(second);
    expect(await memberRole(DEFAULT_WORKSPACE_ID, second)).toBeNull();
    // Whoever claimed it first (this run or an earlier one) still owns it.
    if (owner) expect(owner).toBe("owner");
  });

  it("a workspace cookie only verifies for the session it was issued to", () => {
    const value = workspaceCookieValue("wabc", "session-1");
    expect(verifyWorkspaceCookie(value, "session-1")).toBe("wabc");
    expect(verifyWorkspaceCookie(value, "session-2")).toBeNull();
    expect(verifyWorkspaceCookie("wabc.forged", "session-1")).toBeNull();
    expect(verifyWorkspaceCookie(undefined, "session-1")).toBeNull();
  });

  it("an explicit scope wins over everything else", async () => {
    const owner = `owner-${unique()}@example.com`;
    const ws = await createWorkspace({ name: "Scoped", owner });
    const statement = `Scoped gap ${unique()}`;
    await runInWorkspace({ workspace_id: ws.id, schema: ws.schema_name }, async () => {
      await resetSeed();
      await addGap(statement);
    });
    expect((await withWorkspace(ws.id, loadState)).gaps.some((gap) => gap.statement === statement)).toBe(true);
    expect((await loadState()).gaps.some((gap) => gap.statement === statement)).toBe(false);
  }, 60_000);
});
