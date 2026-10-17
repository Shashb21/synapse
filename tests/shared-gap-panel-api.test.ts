import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => jar.has(name) ? { value: jar.get(name) } : undefined,
    set: (name: string, value: string) => jar.set(name, value), delete: (name: string) => jar.delete(name) }),
  headers: async () => new Headers(),
}));
import "@/modules";
import { GET } from "@/app/api/gaps/[id]/route";
import { GET as referenceGet } from "@/app/api/plan/references/route";
import { createGap, resetDemoSetup } from "@/lib/iegp/store";
import { createWorkspace, withWorkspace, type Workspace } from "@/modules/workspaces/store";
import { WORKSPACE_COOKIE, workspaceCookieValue } from "@/modules/workspaces/context";
import { createSession } from "@/modules/auth/session";
import { db, sharedDb } from "@/modules/kernel/db";
import { editRecords } from "@/modules/kernel/schema";
import { sql } from "drizzle-orm";
import type { GapRecord } from "@/lib/iegp/gap-record";

let own: Workspace, other: Workspace, gapId = "", foreignId = "";
const owner = `kan133-${Date.now()}@example.com`;
async function signIn(email = owner) {
  jar.clear();
  const session = await createSession({ provider_id: "demo", subject: email, email, actor_name: "Panel reader", actor_function: "medical_affairs", role: "medical_affairs" });
  jar.set(WORKSPACE_COOKIE, workspaceCookieValue(own.id, session.id));
}
const read = (id: string) => withWorkspace(own.id, () => GET(new Request(`http://localhost/api/gaps/${id}`), { params: Promise.resolve({ id }) }));

beforeAll(async () => {
  vi.stubEnv("SYNAPSE_TEST_ANON_API", "0");
  own = await createWorkspace({ name: "KAN133 panel read isolation", owner });
  other = await createWorkspace({ name: "KAN133 foreign records", owner });
  await signIn();
  gapId = await withWorkspace(own.id, async () => {
    await resetDemoSetup();
    return createGap({ statement: "Our evidence needed", actor_name: "Panel reader", actor_function: "medical_affairs" });
  });
  foreignId = await withWorkspace(other.id, async () => {
    await resetDemoSetup();
    await createGap({ statement: "First foreign evidence", actor_name: "Foreign reader", actor_function: "medical_affairs" });
    return createGap({ statement: "Secret foreign evidence", actor_name: "Foreign reader", actor_function: "medical_affairs" });
  });
}, 60_000);
afterAll(async () => {
  for (const workspace of [own, other]) if (workspace) await sharedDb().execute(sql.raw(`DROP SCHEMA IF EXISTS "${workspace.schema_name}" CASCADE`));
  jar.clear(); vi.unstubAllEnvs();
});

describe("shared gap panel authorised read boundary", () => {
  it("returns the full record, rejects missing/foreign gaps and isolates historical reference targets", async () => {
    await withWorkspace(own.id, () => db().insert(editRecords).values({ id: "KAN133-isolated-reference", workspace_id: own.id, at: "2030-01-01T00:00:00Z", stage: "S8", entity_type: "gap", entity_id: gapId, action: "validate", field: "placement", before: null, after: "High", rationale: "Historical suggestion acceptance", actor_name: "Panel reviewer", actor_function: "medical_affairs", supporting_references: [{ entity_type: "gap", entity_id: foreignId, reason: "Recorded reference now outside the workspace" }] }));
    const response = await read(gapId);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json() as GapRecord;
    expect(body.gap.id).toBe(gapId);
    expect(body.coverage_status).toMatchObject({ computed: "validated_open", shown: "validated_open", needs_review: false });
    expect(body.history.find(row => row.id === "KAN133-isolated-reference")?.supporting_references?.[0]?.target).toBeNull();
    expect(JSON.stringify(body)).not.toContain("Secret foreign evidence");
    expect((await read(foreignId)).status).toBe(404);
    expect((await read("GAP-MISSING")).status).toBe(404);
    const refs = await withWorkspace(own.id, () => referenceGet(new Request(`http://localhost/api/plan/references?gap_id=${foreignId}`)));
    expect(refs.status).toBe(404);
  });

  it("bounds long histories to 200 newest entries without rewriting missing old reasons", async () => {
    await withWorkspace(own.id, () => db().insert(editRecords).values(Array.from({ length: 205 }, (_, i) => ({
      id: `KAN133-long-${i}`, workspace_id: own.id, at: new Date(Date.UTC(2031, 0, 1, 0, i)).toISOString(), stage: "S2", entity_type: "gap", entity_id: gapId,
      action: "edit", field: "statement", before: `Evidence ${i}`, after: `Evidence ${i + 1}`, rationale: null, actor_name: "Historical editor", actor_function: "medical_affairs",
    }))));
    const body = await (await read(gapId)).json() as GapRecord;
    expect(body.history).toHaveLength(200);
    expect(body.history[0]).toMatchObject({ id: "KAN133-long-204", before: "Evidence 204", after: "Evidence 205", rationale: null });
    expect(body.history[199]!.id).toBe("KAN133-long-5");
  });

  it("refuses details, history and references after membership cannot be verified", async () => {
    await signIn(`kan133-outsider-${Date.now()}@example.com`);
    const response = await read(gapId);
    expect(response.status).toBe(403);
    expect(await response.json()).not.toHaveProperty("history");
    expect((await withWorkspace(own.id, () => referenceGet(new Request(`http://localhost/api/plan/references?gap_id=${gapId}`)))).status).toBe(403);
    await signIn();
  });
});
