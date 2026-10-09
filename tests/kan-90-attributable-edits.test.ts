import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * KAN-90: every plan change is attributable. Edit records and the workspace's
 * audit rows carry the signed-in principal, their role and the request id, in
 * the request's real workspace; each is mirrored to the platform audit log
 * (category plan) with the same request id. A gate action records the field's
 * real value before and after, even without a rationale. Refused attempts by a
 * signed-in person are logged as denied. The gap's History lists it all.
 * The audit log is append-only, so assertions are scoped by this run's ids.
 */

const jar = vi.hoisted(() => ({ values: new Map<string, string>(), requestId: "kan90-request-boot" }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.values.has(name) ? { name, value: jar.values.get(name)! } : undefined),
    set: (name: string, value: string) => void jar.values.set(name, value),
    delete: (name: string) => void jar.values.delete(name),
  }),
  headers: async () => new Headers({ "x-request-id": jar.requestId, "user-agent": "vitest" }),
}));

import "@/modules";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ActorFunction } from "@/lib/iegp/enums";
import { POST as iegpPost } from "@/app/api/iegp/route";
import { POST as planPost } from "@/app/api/plan/route";
import { GET as adminUsersGet } from "@/app/api/admin/users/route";
import { EntityHistory } from "@/components/entity-history";
import { displayedGapStatus } from "@/lib/iegp/engine";
import { entityHistory } from "@/lib/iegp/entity-history";
import { loadState, resetDemo } from "@/lib/iegp/store";
import type { Role } from "@/modules/auth/roles";
import { TEST_AS_CUSTOMER_COOKIE } from "@/modules/auth/owner";
import { createSession, currentSession } from "@/modules/auth/session";
import { db } from "@/lib/iegp/db";
import { listAuditEvents, type AuditEvent } from "@/modules/kernel/audit";
import { listEdits, recordEdit } from "@/modules/kernel/edit-records";
import { listSignals } from "@/modules/kernel/hillclimb";
import { WORKSPACE_COOKIE, workspaceCookieValue } from "@/modules/workspaces/context";
import { createWorkspace, inviteMember, withWorkspace, type Workspace } from "@/modules/workspaces/store";

const run = Math.random().toString(36).slice(2, 8);
const OWNER = `kan90-owner-${run}@kan90.example.test`;
type Person = { name: string; fn: ActorFunction; role: Role; email: string };
const LEAD: Person = { name: `Lead ${run}`, fn: "medical_affairs", role: "medical_affairs", email: OWNER };
const VIEWER: Person = { name: `Viewer ${run}`, fn: "medical_affairs", role: "viewer", email: `kan90-viewer-${run}@kan90.example.test` };

let workspace: Workspace;
let requestCount = 0;

async function signIn(person: Person) {
  jar.values.clear();
  const session = await createSession({
    provider_id: "demo",
    subject: `demo:${person.email}`,
    email: person.email,
    actor_name: person.name,
    actor_function: person.fn,
    role: person.role,
  });
  jar.values.set(WORKSPACE_COOKIE, workspaceCookieValue(workspace.id, session.id));
}

/** A fresh request id per call, as the proxy gives each request. */
function nextRequest(): string {
  requestCount += 1;
  jar.requestId = `kan90-${run}-${String(requestCount).padStart(4, "0")}`;
  return jar.requestId;
}

const inWorkspace = <T,>(call: () => Promise<T>) => withWorkspace(workspace.id, call);

async function call(handler: (request: Request) => Promise<Response>, url: string, body: Record<string, unknown>) {
  const request_id = nextRequest();
  const response = await inWorkspace(() =>
    handler(
      new Request(`http://localhost${url}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    ),
  );
  return { request_id, status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function eventsFor(request_id: string): Promise<AuditEvent[]> {
  return (await listAuditEvents({ request_id }, { limit: 100 })).events;
}

let gapId = "";
let target: "validated_open" | "validated_addressed" = "validated_addressed";
let computedBefore: string | null = null;

beforeAll(async () => {
  vi.stubEnv("SYNAPSE_TEST_ANON_API", "0");
  workspace = await createWorkspace({ name: `KAN-90 ${run}`, owner: OWNER });
  await inviteMember({ workspace_id: workspace.id, email: VIEWER.email, by: OWNER });
  await signIn(LEAD);
  await inWorkspace(() => resetDemo());
  const state = await inWorkspace(() => loadState());
  const gap = state.gaps.find(
    (row) =>
      !row.retired &&
      !row.status_override &&
      row.computed_status !== null &&
      (row.status === "validated_open" || row.status === "validated_addressed") &&
      displayedGapStatus(row) !== "validated_partial",
  );
  expect(gap, "the demo has a mapped gap").toBeTruthy();
  gapId = gap!.id;
  computedBefore = gap!.computed_status;
  target = gap!.status === "validated_open" ? "validated_addressed" : "validated_open";
}, 90_000);

afterAll(() => {
  vi.unstubAllEnvs();
  jar.values.clear();
});

describe("KAN-90 attributable plan edits", () => {
  let overrideRequest = "";

  it("a gate action records the real before and after, the principal, role, request and workspace", async () => {
    await signIn(LEAD);
    const res = await call(iegpPost, "/api/iegp", {
      action: "override_gap_status",
      gap_id: gapId,
      status: target,
      reason: "Reviewed the registry readout",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    overrideRequest = res.request_id;
    const edit = (await inWorkspace(() => listEdits({ entity_id: gapId, limit: 20 }))).find(
      (row) => row.request_id === overrideRequest && row.field === "computed_status",
    );
    expect(edit).toMatchObject({
      workspace_id: workspace.id,
      before: computedBefore,
      after: `${target} (override)`,
      rationale: "Reviewed the registry readout",
      actor_principal: OWNER,
      actor_role: "medical_affairs",
      actor: { name: LEAD.name },
    });
  });

  it("the workspace's audit row and the platform log carry the same attribution and request id", async () => {
    const state = await inWorkspace(() => loadState());
    expect(state.audit.length).toBeGreaterThan(0);
    const history = await inWorkspace(() => entityHistory([gapId]));
    const row = history.find((entry) => entry.request_id === overrideRequest);
    expect(row).toMatchObject({ actor_principal: OWNER, actor_role: "medical_affairs" });

    const events = await eventsFor(overrideRequest);
    const mirrored = events.filter((event) => event.category === "plan");
    // One copy of the plan audit row and one of the edit record.
    expect(mirrored.map((event) => event.meta?.source).sort()).toEqual(["edit_record", "plan_audit"]);
    for (const event of mirrored) {
      expect(event).toMatchObject({
        actor_principal: OWNER,
        actor_name: LEAD.name,
        actor_role: "medical_affairs",
        workspace_id: workspace.id,
        entity_id: gapId,
        request_id: overrideRequest,
      });
    }
    const edit = mirrored.find((event) => event.meta?.source === "edit_record")!;
    expect(edit.before).toEqual({ computed_status: computedBefore });
    expect(edit.after).toEqual({ computed_status: `${target} (override)` });
  });

  it("a gate action with no rationale is still recorded, with a null rationale", async () => {
    const res = await call(iegpPost, "/api/iegp", { action: "clear_gap_status_override", gap_id: gapId });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const edit = (await inWorkspace(() => listEdits({ entity_id: gapId, limit: 20 }))).find(
      (row) => row.request_id === res.request_id && row.field === "computed_status",
    );
    expect(edit).toMatchObject({ before: `${target} (override)`, rationale: null, actor_principal: OWNER });
    expect(edit!.after).not.toContain("(override)");
    // The learning signal keeps its provenance.
    const signal = (await inWorkspace(() => listSignals({ limit: 50 }))).find(
      (row) => row.subject === `gap:${gapId}` && row.actor_principal === OWNER,
    );
    expect(signal).toMatchObject({ actor_name: LEAD.name });
  });

  it("a signed-in change recorded inside a transaction needs no second connection", async () => {
    // Vitest and Vercel run one connection: a session query inside the transaction would wait forever.
    await signIn(LEAD);
    const request_id = nextRequest();
    await currentSession(); // the request's guard verifies the session before any change
    const record = await inWorkspace(() =>
      db().transaction((tx) =>
        recordEdit(
          {
            stage: "S5",
            entity_type: "gap",
            entity_id: gapId,
            field: "probe",
            action: "edit",
            before: "a",
            after: "b",
            rationale: "Recorded inside a transaction",
            actor: { name: LEAD.name, function: "medical_affairs" },
          },
          tx,
        ),
      ),
    );
    expect(record).toMatchObject({ actor_principal: OWNER, actor_role: "medical_affairs", request_id, workspace_id: workspace.id });
    expect((await eventsFor(request_id)).some((event) => event.meta?.edit_id === record.id)).toBe(true);
  }, 15_000);

  it("plan-route actions (gap settings) are audited and mirrored too", async () => {
    const res = await call(planPost, "/api/plan", { action: "set_gap_settings", gap_id: gapId, settings: ["hospital"] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const events = await eventsFor(res.request_id);
    expect(events.some((event) => event.category === "plan" && event.entity_id === gapId && event.actor_principal === OWNER)).toBe(true);
  });

  it("the gap's History lists who, role, when, before → after and rationale, newest first", async () => {
    const history = await inWorkspace(() => entityHistory([gapId]));
    expect(history.length).toBeGreaterThanOrEqual(3);
    const times = history.map((entry) => entry.at);
    expect([...times].sort().reverse()).toEqual(times);
    // An audit row from the same request as an edit is folded into the edit.
    expect(history.filter((entry) => entry.request_id === overrideRequest)).toHaveLength(1);
    const html = renderToStaticMarkup(createElement(EntityHistory, { entries: history }));
    expect(html).toContain("History");
    expect(html).toContain(LEAD.name);
    expect(html).toContain(OWNER);
    expect(html).toContain("Medical Affairs");
    expect(html).toContain(`${target} (override)`);
    expect(html).toContain("Reviewed the registry readout");
    expect(html).toContain("No rationale given.");
    expect(renderToStaticMarkup(createElement(EntityHistory, { entries: [] }))).toContain("No changes recorded yet.");
  });
});

describe("KAN-90 refused attempts", () => {
  it("a viewer's refused plan edit is logged as denied with the reason", async () => {
    await signIn(VIEWER);
    const res = await call(planPost, "/api/plan", { action: "set_gap_settings", gap_id: gapId, settings: ["home"] });
    expect(res.status).toBe(403);
    const denied = (await eventsFor(res.request_id)).find((event) => event.action === "permission.denied");
    expect(denied).toMatchObject({
      category: "workspace",
      actor_principal: VIEWER.email,
      actor_role: "viewer",
      meta: { outcome: "denied", code: "forbidden" },
    });
    expect(String(denied!.meta?.reason)).toMatch(/Viewer may not/);
  });

  it("a non-owner workspace member's reset is refused and logged", async () => {
    await signIn({ ...VIEWER, role: "medical_affairs" });
    const res = await call(iegpPost, "/api/iegp", { action: "reset" });
    expect(res.status).toBe(403);
    const denied = (await eventsFor(res.request_id)).find((event) => event.action === "reset.denied");
    expect(denied).toMatchObject({ entity_id: workspace.id, meta: { outcome: "denied" } });
  });

  it("a signed-in non-owner on an owner API is logged as denied", async () => {
    await signIn(LEAD);
    // Without the test owner bypass: this person is a customer.
    jar.values.set(TEST_AS_CUSTOMER_COOKIE, "customer");
    const request_id = nextRequest();
    const response = await adminUsersGet();
    expect(response.status).toBe(403);
    const denied = (await eventsFor(request_id)).find((event) => event.action === "owner_api.denied");
    expect(denied).toMatchObject({ category: "admin", actor_principal: OWNER, meta: { outcome: "denied", code: "owner_only" } });
  });

  it("signed-out traffic on an owner API is not logged", async () => {
    jar.values.clear();
    jar.values.set(TEST_AS_CUSTOMER_COOKIE, "customer");
    const request_id = nextRequest();
    const response = await adminUsersGet();
    expect(response.status).toBe(403);
    expect(await eventsFor(request_id)).toHaveLength(0);
  });
});
