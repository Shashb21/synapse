import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/** A request cookie jar the route handlers read and createSession writes. */
const jar = vi.hoisted(() => ({ values: new Map<string, string>() }));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.values.has(name) ? { name, value: jar.values.get(name)! } : undefined),
    set: (name: string, value: string) => void jar.values.set(name, value),
    delete: (name: string) => void jar.values.delete(name),
  }),
  headers: async () => new Headers(),
}));

import "@/modules";
import type { ActorFunction } from "@/lib/iegp/enums";
import { POST as iegpPost } from "@/app/api/iegp/route";
import { GET as planGet, POST as planPost } from "@/app/api/plan/route";
import { listEdits } from "@/modules/kernel/edit-records";
import { resetWorkedExample } from "@/lib/iegp/store";
import type { Role } from "@/modules/auth/roles";
import { createSession } from "@/modules/auth/session";
import { WORKSPACE_COOKIE, workspaceCookieValue } from "@/modules/workspaces/context";
import { createWorkspace, inviteMember, withWorkspace, type Workspace } from "@/modules/workspaces/store";
import type { GapTimelineView } from "@/modules/stages/s10-timeline/gap-view";

/**
 * KAN-25: every timeline edit needs an edit capability. A viewer reads the
 * timeline and gets 403 on every write; an editor's write is audited with the
 * signed-in actor (never a name in the body) in their own workspace.
 */

const unique = Math.random().toString(36).slice(2, 8);
const OWNER = `kan25-owner-${unique}@example.com`;
type Person = { name: string; fn: ActorFunction; role: Role; email: string };
const LEAD: Person = { name: "Lead Lina", fn: "medical_affairs", role: "medical_affairs", email: OWNER };
const VIEWER: Person = { name: "Viewer Vik", fn: "medical_affairs", role: "viewer", email: `kan25-v-${unique}@example.com` };

let workspace: Workspace;

async function signIn(person: Person) {
  jar.values.clear();
  const session = await createSession({
    provider_id: "demo",
    subject: `demo:${person.name}`,
    email: person.email,
    actor_name: person.name,
    actor_function: person.fn,
    role: person.role,
  });
  jar.values.set(WORKSPACE_COOKIE, workspaceCookieValue(workspace.id, session.id));
}

const inWorkspace = <T,>(call: () => Promise<T>) => withWorkspace(workspace.id, call);

function post(body: Record<string, unknown>) {
  return new Request("http://localhost/api/plan", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function view(): Promise<GapTimelineView> {
  const response = await inWorkspace(planGet);
  expect(response.status).toBe(200);
  return ((await response.json()) as { timeline_view: GapTimelineView }).timeline_view;
}

beforeAll(async () => {
  vi.stubEnv("SYNAPSE_TEST_ANON_API", "0");
  workspace = await createWorkspace({ name: `KAN-25 ${unique}`, owner: OWNER });
  await inviteMember({ workspace_id: workspace.id, email: VIEWER.email, by: OWNER });
  await signIn(LEAD);
  // The worked example: open gaps with mapped tactics, in this workspace only.
  await inWorkspace(() => resetWorkedExample());
}, 60_000);

afterAll(() => {
  vi.unstubAllEnvs();
  jar.values.clear();
});

describe("KAN-25 timeline roles", () => {
  let gapId: string;
  let activityId: string;

  it("an editor creates an activity under a gap, audited with the signed-in actor", async () => {
    await signIn(LEAD);
    const current = await view();
    const group = current.not_prioritized[0] ?? current.prioritized[0];
    expect(group, "the seed has open gaps").toBeTruthy();
    gapId = group!.gap_id;
    const response = await inWorkspace(() =>
      planPost(
        post({
          action: "create_activity",
          gap_id: gapId,
          name: "KAN-25 viewer spec activity",
          type: "rwe_study",
          evidence_question: "Does it work in practice?",
          start_date: "2026-11-01",
          end_date: "2027-02-01",
          rationale: "Planning session",
          // A signed-in person is never named by the body.
          actor_name: "Mallory",
        }),
      ),
    );
    const body = (await response.json()) as { activity_id?: string; error?: string };
    expect(response.status, body.error).toBe(200);
    activityId = body.activity_id!;
    const edits = await inWorkspace(() => listEdits({ stage: "S10", entity_id: activityId }));
    expect(edits.length).toBeGreaterThan(0);
    expect(edits.every((edit) => edit.actor.name === LEAD.name && edit.workspace_id === workspace.id)).toBe(true);
  });

  it("a viewer can read the timeline but every timeline write is 403", async () => {
    await signIn(VIEWER);
    const current = await view();
    expect([...current.prioritized, ...current.not_prioritized].some((group) => group.gap_id === gapId)).toBe(true);
    const writes: Record<string, unknown>[] = [
      { action: "create_activity", gap_id: gapId, name: "Nope", type: "rwe_study", evidence_question: "q" },
      { action: "move_activity", id: activityId, start_date: "2027-01-01", end_date: "2027-06-01" },
      { action: "add_activity", tactic_id: activityId.replace(/^ACT-/, ""), start_date: "2027-01-01", end_date: "2027-06-01" },
      { action: "set_dependencies", id: activityId, depends_on: [] },
      { action: "remove_activity", id: activityId },
      { action: "save_plan", status: "draft" },
    ];
    for (const write of writes) {
      const response = await inWorkspace(() => planPost(post({ ...write, rationale: "viewer tries" })));
      expect(response.status, String(write.action)).toBe(403);
    }
    const tactic = await inWorkspace(() =>
      iegpPost(
        new Request("http://localhost/api/iegp", {
          method: "POST",
          body: JSON.stringify({ action: "modify_tactic", tactic_id: activityId.replace(/^ACT-/, ""), name: "x", rationale: "viewer" }),
        }),
      ),
    );
    expect(tactic.status).toBe(403);
    // Nothing moved.
    const after = await view();
    const item = [...after.prioritized, ...after.not_prioritized]
      .flatMap((group) => group.items)
      .find((row) => row.activity_id === activityId);
    expect(item?.activity?.start_date).toBe("2026-11-01");
  });
});
