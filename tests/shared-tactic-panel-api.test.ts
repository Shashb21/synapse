import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TacticRecordContent } from "@/components/tactic-record-content";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
import { addTimelineActivity, timelineModel } from "@/modules/stages/s10-timeline/module";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => jar.has(name) ? { value: jar.get(name) } : undefined,
    set: (name: string, value: string) => jar.set(name, value), delete: (name: string) => jar.delete(name) }),
  headers: async () => new Headers(),
}));
import "@/modules";
import { GET } from "@/app/api/tactics/[id]/route";
import { POST } from "@/app/api/iegp/route";
import { assignTacticToGap, createGap, createProposedTactic, loadState, modifyTactic, resetDemoSetup } from "@/lib/iegp/store";
import { createWorkspace, withWorkspace, type Workspace } from "@/modules/workspaces/store";
import { WORKSPACE_COOKIE, workspaceCookieValue } from "@/modules/workspaces/context";
import { createSession } from "@/modules/auth/session";
import { db, sharedDb } from "@/modules/kernel/db";
import { editRecords } from "@/modules/kernel/schema";
import { sql } from "drizzle-orm";
import type { TacticRecord } from "@/lib/iegp/tactic-record";

let own: Workspace, other: Workspace, tacticId = "", foreignId = "", foreignGap = "";
let firstGap = "", secondGap = "";
const owner = `kan134-${Date.now()}@example.com`;
const actor = { actor_name: "Tactic panel reader", actor_function: "medical_affairs" as const };
async function signIn(email = owner, role = "medical_affairs" as "medical_affairs" | "viewer") {
  jar.clear();
  const session = await createSession({ provider_id: "demo", subject: email, email, ...actor, role });
  jar.set(WORKSPACE_COOKIE, workspaceCookieValue(own.id, session.id));
}
const read = (id = tacticId) => withWorkspace(own.id, () => GET(new Request(`http://localhost/api/tactics/${id}`), { params: Promise.resolve({ id }) }));
const save = (body: Record<string, unknown>) => withWorkspace(own.id, () => POST(new Request("http://localhost/api/iegp", { method: "POST", body: JSON.stringify({ action: "modify_tactic", tactic_id: tacticId, ...body }) })));
const record = async () => (await (await read()).json()) as TacticRecord;
const create = (name: string) => createProposedTactic({ name, type: "registry", description: "A shared study", evidence_question: "What is routine-care persistence?", population: "Adults", intervention: "Treatment A", comparator: "Routine care", outcomes: "Persistence", owner: "Lead", function: "medical_affairs", residual_ids: [], ...actor });

beforeAll(async () => {
  vi.stubEnv("SYNAPSE_TEST_ANON_API", "0");
  own = await createWorkspace({ name: "KAN134 tactic record", owner });
  other = await createWorkspace({ name: "KAN134 foreign tactics", owner });
  await signIn();
  await withWorkspace(own.id, async () => {
    await resetDemoSetup();
    firstGap = await createGap({ statement: "First distinct evidence need", ...actor });
    secondGap = await createGap({ statement: "Second distinct evidence need", ...actor });
    tacticId = await create("Shared panel tactic");
    for (const gap_id of [firstGap, secondGap]) await assignTacticToGap({ gap_id, tactic_id: tacticId, note: "Existing study applies separately", ...actor });
  });
  foreignId = await withWorkspace(other.id, async () => { await resetDemoSetup(); await create("Foreign filler"); await createGap({ statement: "Foreign filler need", ...actor }); await createGap({ statement: "Another foreign need", ...actor }); foreignGap = await createGap({ statement: "Secret foreign evidence", ...actor }); return create("Secret foreign tactic"); });
}, 60_000);
afterAll(async () => {
  for (const workspace of [own, other]) if (workspace) await sharedDb().execute(sql.raw(`DROP SCHEMA IF EXISTS "${workspace.schema_name}" CASCADE`));
  jar.clear(); vi.unstubAllEnvs();
});

it("reads one tactic with distinct gap relationships, bounded attributable history and isolated references", async () => {
  const initial = await record();
  expect(initial.tactic.name).toBe("Shared panel tactic");
  expect(initial.coverages.map(row => row.gap?.id).sort()).toEqual([firstGap, secondGap].sort());
  expect(initial.permissions).toMatchObject({ edit: true, coverage: true });
  const coverage = initial.coverages.find(row => row.gap_id === secondGap)!;
  await withWorkspace(own.id, () => db().insert(editRecords).values({ id: "KAN134-relationship", workspace_id: own.id, at: "2030-01-01T00:00:00Z", stage: "S5", entity_type: "coverage", entity_id: coverage.id, action: "suggest", field: "overall", before: "none", after: "partial", rationale: null, ...actor, supporting_references: [{ entity_type: "gap", entity_id: firstGap, reason: "The supplied gap statement supports this assessment" }, { entity_type: "gap", entity_id: foreignGap, reason: "Historical foreign target" }] }));
  const response = await read();
  expect(response.headers.get("cache-control")).toBe("no-store");
  const loaded = await response.json() as TacticRecord;
  const event = loaded.history.find(row => row.id === "KAN134-relationship")!;
  expect(event.counterpart_gaps).toEqual([{ id: secondGap, name: "Second distinct evidence need" }]);
  expect(event.rationale).toBeNull();
  expect(event.supporting_references?.[0]?.target).toEqual({ title: "First distinct evidence need", href: `/gaps/${firstGap}` });
  expect(event.supporting_references?.[1]?.target).toBeNull();
  expect(JSON.stringify(loaded)).not.toContain("Secret foreign tactic");
  expect((await read(foreignId)).status).toBe(404);
  expect((await read("TACTIC-MISSING")).status).toBe(404);
  expect((await save({ tactic_id: foreignId, name: "Forbidden foreign edit", rationale: "Cannot cross workspace boundaries" })).status).toBe(404);
});

it("saves fields and status together with a reason, rejects stale drafts, and leaves no no-op history", async () => {
  const opening = await record();
  expect((await save({ budget: "$480K", expected_tactic: opening.version })).status).toBe(400);
  expect((await save({ budget: "$480K", status: "invalid", expected_tactic: opening.version, rationale: "Invalid lifecycle must not save fields" })).status).toBe(400);
  expect((await record()).tactic).toEqual(opening.tactic);
  expect((await save({ budget: "$480K", status: "planned", expected_tactic: opening.version, rationale: "Budget and lifecycle approved together" })).status).toBe(200);
  const saved = await record();
  expect(saved.tactic).toMatchObject({ budget: "$480K", status: "planned" });
  expect(saved.history).toEqual(expect.arrayContaining([
    expect.objectContaining({ field: "budget", before: null, after: "$480K", rationale: "Budget and lifecycle approved together" }),
    expect.objectContaining({ field: "status", before: "proposed", after: "planned", rationale: "Budget and lifecycle approved together" }),
  ]));
  const stale = await save({ owner: "Stale lead", expected_tactic: opening.version, rationale: "Old opening snapshot" });
  expect(stale.status).toBe(400);
  expect(await stale.json()).toMatchObject({ error: expect.stringContaining("Tactic changed") });
  expect((await save({ budget: "$480K", status: "planned", expected_tactic: saved.version, rationale: "No substantive change" })).status).toBe(400);
  expect((await record()).history).toEqual(saved.history);
});

it.each(["field", "status"])("requires the HTTP opening token for %s changes and leaves rejected writes and history unchanged", async kind => {
  const id = await withWorkspace(own.id, () => create(`Snapshot guarded ${kind}`));
  const currentRecord = async () => (await (await read(id)).json()) as TacticRecord;
  const initial = await currentRecord();
  const change = kind === "field" ? { budget: "$100K" } : { status: "planned" };
  const nextChange = kind === "field" ? { budget: "$999K" } : { status: "ongoing" };
  const before = await withWorkspace(own.id, loadState);
  const missing = await save({ tactic_id: id, ...change, rationale: "This request has no opening snapshot" });
  expect(missing.status).toBe(400);
  expect(await missing.json()).toMatchObject({ error: expect.stringContaining("Tactic changed") });
  expect(await withWorkspace(own.id, loadState)).toEqual(before);
  expect((await currentRecord()).history).toEqual(initial.history);
  expect((await save({ tactic_id: id, ...change, expected_tactic: initial.version, rationale: "Save this reviewed opening snapshot" })).status).toBe(200);
  const saved = await currentRecord();
  const savedState = await withWorkspace(own.id, loadState);
  for (const token of [{}, { expected_tactic: initial.version }, { expected_tactic: null }]) {
    const response = await save({ tactic_id: id, ...nextChange, ...token, rationale: "An absent or stale opening cannot overwrite a newer review" });
    expect(response.status).toBe(400);
    expect(await withWorkspace(own.id, loadState)).toEqual(savedState);
    expect((await currentRecord()).history).toEqual(saved.history);
  }
  await withWorkspace(own.id, () => modifyTactic({ tactic_id: id, fields: { owner: "Trusted internal owner" }, rationale: "An internal owner retains the existing optional-token contract", ...actor }));
  expect((await currentRecord()).tactic.owner).toBe("Trusted internal owner");
});

it("loads the opening tactic token for timeline detail editors", async () => {
  const id = await withWorkspace(own.id, () => create("Timeline token cohort"));
  const initial = (await (await read(id)).json()) as TacticRecord;
  const model = await withWorkspace(own.id, async () => {
    await addTimelineActivity({ tactic_id: id, start_date: "2027-01-01", end_date: "2027-06-30", rationale: "Schedule this manually reviewed cohort", actor: { name: actor.actor_name, function: actor.actor_function } });
    return timelineModel();
  });
  expect(model.activities.some(activity => activity.tactic_id === id)).toBe(true);
  expect(model.tactic_versions?.[id]).toBe(initial.version);
  expect((await save({ tactic_id: id, budget: "$250K", expected_tactic: model.tactic_versions?.[id], rationale: "Budget reviewed from the timeline opening" })).status).toBe(200);
});

it("rolls fields, lifecycle, related state and history back if the required edit record fails", async () => {
  const before = await record();
  await withWorkspace(own.id, async () => {
    await db().execute(sql.raw("CREATE FUNCTION fail_tactic_edit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'KAN134 injected history failure'; END $$"));
    await db().execute(sql.raw("CREATE TRIGGER fail_tactic_edit BEFORE INSERT ON edit_records FOR EACH ROW WHEN (NEW.field = 'status') EXECUTE FUNCTION fail_tactic_edit()"));
  });
  try {
    expect((await save({ budget: "$999K", status: "ongoing", expected_tactic: before.version, rationale: "Must fail together with history" })).status).toBe(400);
    const after = await record();
    expect(after.tactic).toEqual(before.tactic);
    expect(after.coverages).toEqual(before.coverages);
    expect(after.history).toEqual(before.history);
  } finally {
    await withWorkspace(own.id, async () => {
      await db().execute(sql.raw("DROP TRIGGER fail_tactic_edit ON edit_records"));
      await db().execute(sql.raw("DROP FUNCTION fail_tactic_edit()"));
    });
  }
});

it("allows a workspace viewer to inspect history but refuses edits and denies nonmembers and signed-out reads", async () => {
  await signIn(owner, "viewer");
  const before = await record();
  expect(before.permissions).toEqual({ edit: false, coverage: false });
  expect((await save({ name: "Forbidden change", rationale: "A viewer cannot edit" })).status).toBe(403);
  expect((await record()).tactic).toEqual(before.tactic);
  await signIn(`kan134-outsider-${Date.now()}@example.com`);
  const denied = await read();
  expect(denied.status).toBe(403);
  expect(await denied.json()).not.toHaveProperty("history");
  jar.clear();
  expect((await read()).status).toBe(401);
  await signIn();
});

it("returns only the 200 newest recorded changes and preserves missing legacy reasons", async () => {
  await withWorkspace(own.id, () => db().insert(editRecords).values(Array.from({ length: 205 }, (_, i) => ({
    id: `KAN134-long-${i}`, workspace_id: own.id, at: new Date(Date.UTC(2031, 0, 1, 0, i)).toISOString(), stage: "S3", entity_type: "tactic", entity_id: tacticId,
    action: "edit", field: "owner", before: `Lead ${i}`, after: `Lead ${i + 1}`, rationale: null, ...actor,
  }))));
  const loaded = await record();
  expect(loaded.history).toHaveLength(200);
  expect(loaded.history[0]).toMatchObject({ id: "KAN134-long-204", before: "Lead 204", after: "Lead 205", rationale: null, actor_name: actor.actor_name });
  expect(loaded.history[199]!.id).toBe("KAN134-long-5");
});

it.each([false, true])("read-only current type is visible for panel=%s with viewer and editor permissions", async panel => {
  const current = await record();
  for (const edit of [false, true]) {
    for (const custom_type of [null, { label: "Advisory board", color: "#be185d" }]) {
      const html = renderToStaticMarkup(createElement(TacticRecordContent, {
        panel,
        record: { ...current, tactic: { ...current.tactic, type: "rwe_study", custom_type }, permissions: { edit, coverage: edit } },
      }));
      expect(html).toContain(">Type</dt>");
      expect(html).toContain(`>${custom_type ? "Advisory board" : "RWE study"}</dd>`);
    }
  }
});
