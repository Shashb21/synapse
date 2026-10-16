import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => jar.has(name) ? { value: jar.get(name) } : undefined,
    set: (name: string, value: string) => jar.set(name, value), delete: (name: string) => jar.delete(name) }),
  headers: async () => new Headers(),
}));

import "@/modules";
import { POST } from "@/app/api/plan/route";
import { createGap, resetDemoSetup } from "@/lib/iegp/store";
import { db, sharedDb } from "@/modules/kernel/db";
import { sql } from "drizzle-orm";
import { WORKSPACE_COOKIE, workspaceCookieValue } from "@/modules/workspaces/context";
import { createWorkspace, inviteMember, withWorkspace, type Workspace } from "@/modules/workspaces/store";
import { createSession } from "@/modules/auth/session";
import type { Role } from "@/modules/auth/roles";
import * as kernel from "@/modules/kernel/schema";
import { listAuditEvents } from "@/modules/kernel/audit";
import { listPlacements } from "@/modules/stages/s8-prioritization/module";
import { entityHistory } from "@/lib/iegp/entity-history";

const owner = `kan129-${Date.now()}@example.com`;
let workspace: Workspace;
const scoped = <T>(fn: () => PromiseLike<T>): Promise<T> => withWorkspace(workspace.id, async () => await fn());
async function signIn(role: Role = "medical_affairs", email = owner) {
  jar.clear();
  const session = await createSession({ provider_id: "demo", subject: email, email, actor_name: "Priority Reviewer", actor_function: "medical_affairs", role });
  jar.set(WORKSPACE_COOKIE, workspaceCookieValue(workspace.id, session.id));
  return session;
}
let gapId: string;
const post = (body: Record<string, unknown>) => scoped(async () => {
  const response = await POST(new Request("http://localhost/api/plan", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ actor_name: "Priority Reviewer", actor_function: "medical_affairs", gap_id: gapId, ...body }),
  }));
  return { status: response.status, body: await response.json() };
});

beforeAll(async () => {
  vi.stubEnv("SYNAPSE_TEST_ANON_API", "0");
  workspace = await createWorkspace({ name: "KAN129 audited priorities", owner });
  await signIn();
  await scoped(async () => {
    await resetDemoSetup();
    gapId = await createGap({ statement: "No comparative evidence for the HTA submission.", actor_name: "Priority Reviewer", actor_function: "medical_affairs" });
  });
}, 60_000);
afterAll(async () => {
  if (workspace) await sharedDb().execute(sql.raw(`DROP SCHEMA IF EXISTS "${workspace.schema_name}" CASCADE`));
  jar.clear();
  vi.unstubAllEnvs();
});

describe("audited manual priority decisions", () => {
  it("refuses a matrix drag without a human reason and leaves the judgement unset", async () => {
    const result = await post({ action: "move_placement", x_axis: "decision_impact", y_axis: "time_pressure", x: 80, y: 80, expected_version: null });
    expect(result.status).toBe(400);
    expect(result.body.error).toMatch(/reason/i);
    expect(await scoped(listPlacements)).toEqual([]);
  });

  it("records the reason separately from rationale and retains both judgements on confirmation and reconfirmation", async () => {
    const initial = await post({ action: "set_placement", band: "high", axis_scores: { decision_impact: 80, time_pressure: 80 }, rationale: "Evidence blocks the payer decision", reason: "New manual assessment", expected_version: null });
    expect(initial.status).toBe(200);
    expect(initial.body.placement.rationale).toBe("Evidence blocks the payer decision");
    const confirmed = await post({ action: "validate_band", band: "high", reason: "Reviewed for this planning cycle", expected_version: initial.body.placement.version });
    expect(confirmed.status).toBe(200);
    const reconfirmed = await post({ action: "validate_band", band: "high", reason: "Reviewed again with the team", expected_version: confirmed.body.placement.version });
    expect(reconfirmed.status).toBe(200);
    expect(reconfirmed.body.placement).toMatchObject({ validated: true, rationale: "Evidence blocks the payer decision", axis_scores: { decision_impact: 80, time_pressure: 80 } });
    const history = await scoped(() => entityHistory([gapId]));
    expect(history.filter((entry) => entry.field === "placement")).toHaveLength(3);
    const entry = history.find((row) => row.rationale === "Reviewed again with the team")!;
    expect(entry.actor_name).toBe("Priority Reviewer");
    expect(entry.actor_principal).toBe(owner);
    expect(entry.actor_role).toBe("medical_affairs");
    expect(JSON.parse(entry.before!)).toMatchObject({ band: "high", confirmed: true, rationale: "Evidence blocks the payer decision" });
    expect(JSON.parse(entry.after!)).toMatchObject({ band: "high", confirmed: true });
    expect((await scoped(listPlacements)).find((row) => row.gap_id === gapId)).toEqual(reconfirmed.body.placement);
  });

  it("ignores unchanged saves but records a score-only drag with its human reason", async () => {
    const current = (await scoped(listPlacements)).find((row) => row.gap_id === gapId)!;
    const before = await scoped(() => entityHistory([gapId]));
    const noop = await post({ action: "set_placement", band: "high", axis_scores: current.axis_scores, reason: "No changes to make", expected_version: current.version });
    expect(noop.status).toBe(200);
    expect(noop.body.placement).toEqual(current);
    expect(await scoped(() => entityHistory([gapId]))).toEqual(before);
    const moved = await post({ action: "move_placement", x_axis: "decision_impact", y_axis: "time_pressure", x: 82, y: 80, reason: "Impact increased after review", expected_version: current.version });
    expect(moved.status).toBe(200);
    expect(moved.body.placement).toMatchObject({ validated: true, band: "high", rationale: current.rationale, axis_scores: { decision_impact: 82 } });
    const entry = (await scoped(() => entityHistory([gapId]))).find((row) => row.rationale === "Impact increased after review")!;
    expect(JSON.parse(entry.before!).axis_scores.decision_impact).toBe(80);
    expect(JSON.parse(entry.after!).axis_scores.decision_impact).toBe(82);
  });

  it("rejects competing stale edits, including two first assignments, without losing the winning history", async () => {
    const current = (await scoped(listPlacements)).find((row) => row.gap_id === gapId)!;
    const edits = await Promise.all(["medium", "low"].map((band) => post({ action: "set_placement", band, reason: `Review chose ${band}`, expected_version: current.version })));
    expect(edits.filter((result) => result.status === 200)).toHaveLength(1);
    expect(edits.find((result) => result.status !== 200)!.body.error).toMatch(/review the latest priority/i);
    const winner = edits.find((result) => result.status === 200)!.body.placement;
    expect((await scoped(listPlacements)).find((row) => row.gap_id === gapId)).toEqual(winner);
    const firstId = await scoped(() => createGap({ statement: "No safety evidence in older patients.", actor_name: "Priority Reviewer", actor_function: "medical_affairs" }));
    const first = await Promise.all(["high", "low"].map((band) => post({ gap_id: firstId, action: "set_placement", band, reason: "First manual assessment", expected_version: null })));
    expect(first.filter((result) => result.status === 200)).toHaveLength(1);
    expect((await scoped(() => entityHistory([firstId]))).filter((entry) => entry.field === "placement")).toHaveLength(1);
  });

  it.each(["edit_records", "priority_placements", "public.audit_events"])("a %s persistence failure rolls back both judgement and history", async (table) => {
    const current = (await scoped(listPlacements)).find((row) => row.gap_id === gapId)!;
    const history = await scoped(() => entityHistory([gapId]));
    const audit = await listAuditEvents({ entity_id: gapId, category: "plan" });
    const triggerName = `fail_priority_${table.replace(".", "_")}`;
    await scoped(async () => {
      await db().execute(sql.raw(`CREATE FUNCTION fail_priority_save() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'KAN129 injected persistence failure'; END $$`));
      await db().execute(sql.raw(`CREATE TRIGGER ${triggerName} BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW ${table === "public.audit_events" ? `WHEN (NEW.entity_id = '${gapId}')` : ""} EXECUTE FUNCTION fail_priority_save()`));
    });
    try {
      const result = await post({ action: "set_placement", band: "defer", reason: "Must be saved atomically", expected_version: current.version });
      expect(result.status).toBe(400);
      expect((await scoped(listPlacements)).find((row) => row.gap_id === gapId)).toEqual(current);
      expect(await scoped(() => entityHistory([gapId]))).toEqual(history);
      expect(await listAuditEvents({ entity_id: gapId, category: "plan" })).toEqual(audit);
    } finally {
      await scoped(async () => {
        await db().execute(sql.raw(`DROP TRIGGER ${triggerName} ON ${table}`));
        await db().execute(sql.raw("DROP FUNCTION fail_priority_save()"));
      });
    }
  });
  it("keeps legacy confirmed human priorities confirmed without inventing a reason", async () => {
    const legacyId = await scoped(() => createGap({ statement: "Long-term comparative safety remains uncertain.", actor_name: "Priority Reviewer", actor_function: "medical_affairs" }));
    await scoped(() => db().insert(kernel.priorityPlacements).values({ gap_id: legacyId, axis_scores: { decision_impact: 70 }, suggested_band: "high", suggested_rationale: "Original model rationale", band: "high", validated: true, rationale: "Original human rationale", actor_name: "Earlier reviewer", actor_function: "medical_affairs", at: "2025-01-01T00:00:00.000Z" }));
    const legacy = (await scoped(listPlacements)).find((row) => row.gap_id === legacyId)!;
    expect(legacy).toMatchObject({ validated: true, rationale: "Original human rationale", band: "high" });
    expect(await scoped(() => entityHistory([legacyId]))).not.toEqual(expect.arrayContaining([expect.objectContaining({ field: "placement" })]));
    const result = await post({ action: "validate_band", gap_id: legacyId, band: "high", reason: "Reviewed legacy decision today", expected_version: legacy.version });
    expect(result.status).toBe(200);
    const entry = (await scoped(() => entityHistory([legacyId]))).find((row) => row.field === "placement")!;
    expect(JSON.parse(entry.before!)).toMatchObject({ confirmed: true, rationale: "Original human rationale", actor_name: "Earlier reviewer", at: "2025-01-01T00:00:00.000Z" });
  });

  it("retains the suggested band when a reviewer edits one score on an unbanded suggestion", async () => {
    const id = await scoped(() => createGap({ statement: "No comparative subgroup evidence.", actor_name: "Priority Reviewer", actor_function: "medical_affairs" }));
    await scoped(() => db().insert(kernel.priorityPlacements).values({ gap_id: id, axis_scores: { decision_impact: 60 }, suggested_band: "medium", suggested_rationale: "Relevant to the decision", band: null, validated: false, at: "2026-01-01T00:00:00.000Z" }));
    const current = (await scoped(listPlacements)).find((row) => row.gap_id === id)!;
    const result = await post({ action: "set_placement", gap_id: id, axis_scores: { decision_impact: 70 }, reason: "Reviewed the decision impact", expected_version: current.version });
    expect(result.status).toBe(200);
    expect(result.body.placement).toMatchObject({ band: "medium", axis_scores: { decision_impact: 70 }, suggested_rationale: "Relevant to the decision" });
  });

  it("rejects missing/short reasons and missing versions for every priority entry point", async () => {
    const current = (await scoped(listPlacements)).find((row) => row.gap_id === gapId)!;
    const history = await scoped(() => entityHistory([gapId]));
    for (const action of ["set_placement", "move_placement", "validate_band"]) {
      for (const reason of [undefined, "  ", "x"]) {
        const result = await post({ action, band: "high", x_axis: "decision_impact", y_axis: "time_pressure", x: 80, y: 80, reason, expected_version: current.version });
        expect(result.status).toBe(400);
        expect(result.body.error).toMatch(/reason/i);
      }
      expect((await post({ action, band: "high", x_axis: "decision_impact", y_axis: "time_pressure", x: 80, y: 80, reason: "Review completed" })).status).toBe(400);
    }
    expect((await scoped(listPlacements)).find((row) => row.gap_id === gapId)).toEqual(current);
    expect(await scoped(() => entityHistory([gapId]))).toEqual(history);
  });

  it("refuses all priority actions for a viewer and prevents cross-workspace writes", async () => {
    const current = (await scoped(listPlacements)).find((row) => row.gap_id === gapId)!;
    const history = await scoped(() => entityHistory([gapId]));
    const viewer = `viewer-${owner}`;
    await inviteMember({ workspace_id: workspace.id, email: viewer, by: owner });
    await signIn("viewer", viewer);
    try {
      for (const action of ["set_placement", "move_placement", "validate_band"]) {
        const result = await post({ action, band: "high", x_axis: "decision_impact", y_axis: "time_pressure", x: 80, y: 80, reason: "Forged viewer decision", expected_version: current.version });
        expect(result.status).toBe(403);
      }
    } finally { await signIn(); }
    const other = await createWorkspace({ name: "KAN129 other workspace", owner });
    const session = await signIn();
    jar.set(WORKSPACE_COOKIE, workspaceCookieValue(other.id, session.id));
    try {
      const response = await withWorkspace(other.id, () => POST(new Request("http://localhost/api/plan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "validate_band", gap_id: gapId, band: "high", reason: "Wrong workspace", expected_version: current.version }) })));
      expect(response.status).toBe(400);
      expect(await withWorkspace(other.id, listPlacements)).toEqual([]);
    } finally {
      await sharedDb().execute(sql.raw(`DROP SCHEMA IF EXISTS "${other.schema_name}" CASCADE`));
      await signIn();
    }
    expect((await scoped(listPlacements)).find((row) => row.gap_id === gapId)).toEqual(current);
    expect(await scoped(() => entityHistory([gapId]))).toEqual(history);
  });

});
