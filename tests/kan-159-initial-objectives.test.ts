/** Regression coverage for initial objective creation versus later revisions. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => jar.has(name) ? { value: jar.get(name) } : undefined,
    set: (name: string, value: string) => jar.set(name, value),
    delete: (name: string) => jar.delete(name),
  }),
  headers: async () => new Headers(),
}));

import "@/modules";
import { sql } from "drizzle-orm";
import { POST } from "@/app/api/iegp/route";
import { entityHistory } from "@/lib/iegp/entity-history";
import { parsePlanningContext, setupContextFromState, type PlanningContext } from "@/lib/iegp/planning-context";
import { loadState, saveProductSetup } from "@/lib/iegp/store";
import { createSession } from "@/modules/auth/session";
import { listEdits } from "@/modules/kernel/edit-records";
import { sharedDb } from "@/modules/kernel/db";
import { WORKSPACE_COOKIE, workspaceCookieValue } from "@/modules/workspaces/context";
import { createWorkspace, withWorkspace, type Workspace } from "@/modules/workspaces/store";

const actor = { actor_name: "Initial Objective Editor", actor_function: "medical_affairs" } as const;
const owner = `kan159-${Date.now()}@example.com`;
const workspaces: Workspace[] = [];
let sessionId: string;

beforeAll(async () => {
  vi.stubEnv("SYNAPSE_TEST_ANON_API", "0");
  const session = await createSession({ provider_id: "demo", subject: owner, email: owner, ...actor, role: "medical_affairs" });
  sessionId = session.id;
});
afterAll(async () => {
  for (const workspace of workspaces) {
    await sharedDb().execute(sql.raw(`DROP SCHEMA IF EXISTS "${workspace.schema_name}" CASCADE`));
  }
  jar.clear();
  vi.unstubAllEnvs();
});

async function fresh() {
  const workspace = await createWorkspace({ name: "KAN159 initial objectives", owner });
  workspaces.push(workspace);
  jar.set(WORKSPACE_COOKIE, workspaceCookieValue(workspace.id, sessionId));
  return workspace;
}

function initialContext(): PlanningContext {
  return parsePlanningContext({
    asset_name: "Initial objective study", lifecycle_stage: "growth",
    indications: [{ name: "Psoriasis", status: "current" }], markets: ["US"],
    objectives: [{ name: "Support reimbursement", key_decision: "Committee submission", decision_date: "2028-06-30" }],
  });
}

async function post(context: PlanningContext, reason?: string) {
  const response = await POST(new Request("http://localhost/api/iegp", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...actor, action: "save_product_setup", context, reason }),
  }));
  return { status: response.status, body: await response.json() };
}

async function snapshot() {
  const state = await loadState();
  return { asset: state.asset, objectives: state.objectives, audit: state.audit, edits: await listEdits() };
}

describe("initial objectives", () => {
  it.each([undefined, "", "  ", "x"])("creates the first objective without a meaningful reason (%j) and records its actor", async reason => {
    const workspace = await fresh();
    await withWorkspace(workspace.id, async () => {
      const saved = await post(initialContext(), reason);
      expect(saved.status).toBe(200);
      const state = await loadState();
      expect(state.objectives).toHaveLength(1);
      expect(state.objectives[0]).toMatchObject({ name: "Support reimbursement", key_decision: "Committee submission", decision_date: "2028-06-30" });
      const history = await entityHistory([state.objectives[0]!.id]);
      expect(history.length).toBeGreaterThan(0);
      for (const entry of history) {
        expect(entry).toMatchObject({ action: "add", actor_name: actor.actor_name, actor_function: actor.actor_function, actor_principal: owner });
        expect(entry.rationale).toMatch(/creat|initial/i);
      }
    });
  });

  it.each([undefined, "Initial committee planning"])("permits first creation after reloading a partial draft (reason: %j)", async reason => {
    const workspace = await fresh();
    await withWorkspace(workspace.id, async () => {
      const draft = await post(parsePlanningContext({ asset_name: "Partial plan" }));
      expect(draft.status).toBe(200);
      const reloaded = setupContextFromState(await loadState());
      expect(reloaded.saved_at).not.toBe("");
      expect(reloaded.objectives).toEqual([]);
      const saved = await post({ ...initialContext(), saved_at: reloaded.saved_at }, reason);
      expect(saved.status).toBe(200);
      const state = await loadState();
      const history = await entityHistory([state.objectives[0]!.id]);
      expect(history.length).toBeGreaterThan(0);
      if (reason) expect(history.every(entry => entry.rationale === reason)).toBe(true);
      else expect(history.every(entry => /creat|initial/i.test(entry.rationale ?? ""))).toBe(true);
    });
  });
});

describe("later objective changes", () => {
  const changes: { name: string; change: (ctx: PlanningContext) => PlanningContext }[] = [
    { name: "name", change: ctx => ({ ...ctx, objectives: [{ ...ctx.objectives[0]!, name: "Revised objective" }] }) },
    { name: "key decision", change: ctx => ({ ...ctx, objectives: [{ ...ctx.objectives[0]!, key_decision: "New committee" }] }) },
    { name: "decision date", change: ctx => ({ ...ctx, objectives: [{ ...ctx.objectives[0]!, decision_date: "2029-06-30" }] }) },
    { name: "evidence deadline", change: ctx => ({ ...ctx, objectives: [{ ...ctx.objectives[0]!, evidence_needed_by: "2028-06-01" }] }) },
    { name: "global lifecycle", change: ctx => ({ ...ctx, lifecycle_stage: "pre-launch" }) },
    { name: "global indication", change: ctx => parsePlanningContext({ ...ctx, indications: [{ name: "Arthritis", status: "current" }] }) },
    { name: "global geography", change: ctx => parsePlanningContext({ ...ctx, markets: ["Japan"] }) },
    { name: "additional objective", change: ctx => ({ ...ctx, objectives: [...ctx.objectives, { ...ctx.objectives[0]!, id: "", name: "Another objective" }] }) },
    { name: "replacement objective", change: ctx => ({ ...ctx, objectives: [{ ...ctx.objectives[0]!, id: "", name: "Replacement objective" }] }) },
    { name: "mixed insertion and edit", change: ctx => ({ ...ctx, objectives: [{ ...ctx.objectives[0]!, id: "", name: "Inserted objective" }, { ...ctx.objectives[0]!, decision_date: "2029-06-30" }] }) },
  ];
  it.each(changes)("rejects $name without a reason and rolls back state and history", async ({ change }) => {
    const workspace = await fresh();
    await withWorkspace(workspace.id, async () => {
      const saved = await saveProductSetup({ ...actor, context: initialContext(), reason: "Original objective context" });
      const before = await snapshot();
      const rejected = await post(change(saved), "  ");
      expect(rejected.status).toBe(400);
      expect(rejected.body.error).toMatch(/rationale/i);
      expect(await snapshot()).toEqual(before);
    });
  });

  it("records later revisions with their supplied reason", async () => {
    const workspace = await fresh();
    await withWorkspace(workspace.id, async () => {
      const saved = await saveProductSetup({ ...actor, context: initialContext(), reason: "Original objective context" });
      const revised = { ...saved, objectives: [{ ...saved.objectives[0]!, key_decision: "Updated committee decision" }] };
      expect((await post(revised, "Committee remit changed")).status).toBe(200);
      expect((await loadState()).objectives[0]!.key_decision).toBe("Updated committee decision");
      expect(await entityHistory([saved.objectives[0]!.id])).toContainEqual(expect.objectContaining({
        field: "key_decision", action: "edit", rationale: "Committee remit changed", actor_name: actor.actor_name,
      }));
    });
  });
});
