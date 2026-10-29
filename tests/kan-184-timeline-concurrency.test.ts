/** Real PostgreSQL races: independent requests must preserve edits, graph validity and audit atomicity. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import { eq } from "drizzle-orm";

vi.hoisted(() => { process.env.DATABASE_POOL_MAX = "4"; });

import "@/modules";
import { db, ensureWorkspaceSchema } from "@/lib/iegp/db";
import { resetDemo } from "@/lib/iegp/store";
import { clearIngestedFiles } from "@/modules/workspaces/clear-ingested-files";
import { runInWorkspace } from "@/modules/workspaces/context";
import * as t from "@/modules/kernel/schema";
import { listEdits } from "@/modules/kernel/edit-records";
import { addTimelineActivity, removeTimelineActivity, acceptTimelineEstimates, reviewTimelineDependency,
  setTimelineDependencies, timelineModel, timelineModule, updateTimelineActivity } from "@/modules/stages/s10-timeline/module";
import type { ModuleContext } from "@/modules/kernel/contracts";

const actor = { name: "KAN-184 tester", function: "medical_affairs" as const };
const schema = `ws_kan184_${process.pid}`;
const workspace = { workspace_id: "kan184", schema };
const inside = <T>(fn: () => T) => runInWorkspace(workspace, fn);
const pg = postgres(process.env.DATABASE_URL!, { max: 3, connection: { client_min_messages: "warning" } });
let ids: string[];
const rationale = "Reviewed in planning workshop";
const context = (): ModuleContext => ({
  ai: false, workspace_id: workspace.workspace_id, actor, role: "medical_affairs",
  route: { stage: "S10", provider_id: "anthropic-claude", provider_label: "Claude", model: "test", auth: "none", connected: false,
    params: { temperature: 0, max_tokens: 4096 }, fallbacks: [], degraded: true, reason: "offline" },
  run: { id: "kan184", step: async (_name, fn) => fn(), note: () => {}, steps: () => [] },
  complete: async () => { throw new Error("No model needed"); },
});

/** Wait on an observed database condition; the deadline diagnoses a broken barrier, never orders requests. */
async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 8_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Database barrier was not reached");
  }
}

/** Hold writes at a DB trigger until both independent requests are waiting on database locks. */
async function race(first: () => Promise<unknown>, second: () => Promise<unknown>) {
  await pg.unsafe(`CREATE OR REPLACE FUNCTION "${schema}".gate_write() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN PERFORM pg_advisory_xact_lock(184,184); RETURN NEW; END $$`);
  await pg.unsafe(`CREATE TRIGGER gate_write BEFORE UPDATE ON "${schema}".timeline_activities FOR EACH ROW EXECUTE FUNCTION "${schema}".gate_write()`);
  const gate = await pg.reserve();
  await gate`select pg_advisory_lock(184,184)`;
  const pending = Promise.allSettled([inside(first), inside(second)]);
  try {
    try {
      await until(async () => {
        const [row] = await pg`select count(*)::int as n from pg_stat_activity
          where datname = current_database() and pid <> pg_backend_pid() and wait_event_type = 'Lock'
          and (query ilike '%timeline_activities%' or query ilike '%pg_advisory_xact_lock%')`;
        return row!.n >= 2;
      });
    } finally {
      await gate`select pg_advisory_unlock(184,184)`;
      gate.release();
    }
    return await pending;
  } finally {
    await pending;
    await pg.unsafe(`DROP TRIGGER gate_write ON "${schema}".timeline_activities`);
  }
}

async function row(id: string) {
  return inside(async () => (await db().select().from(t.timelineActivities).where(eq(t.timelineActivities.id, id)))[0]!);
}

beforeAll(async () => {
  await ensureWorkspaceSchema(schema);
  await inside(() => resetDemo());
  const model = await inside(() => timelineModel("2026-01-01"));
  ids = model.pending.slice(0, 3).map(activity => activity.activity_id);
  for (const activity of model.pending.slice(0, 3)) {
    await inside(() => addTimelineActivity({ tactic_id: activity.tactic_id, start_date: "2026-01-01", end_date: "2026-06-01", actor, rationale }));
  }
}, 90_000);

beforeEach(async () => inside(async () => {
  for (const id of ids) await db().update(t.timelineActivities).set({ start_date: "2026-01-01", end_date: "2026-06-01", lane: "low", depends_on: [],
    meta: { schedule_basis: { start: "model", end: "model", readout: null }, depends_locked: false } }).where(eq(t.timelineActivities.id, id));
  await db().delete(t.editRecords);
}));

afterAll(async () => {
  await pg.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await pg.end();
});

describe("KAN-184 timeline mutations", () => {
  it("keeps schedule/lane metadata and dependency metadata from concurrent independent requests", async () => {
    const [a, b] = ids as [string, string];
    const results = await race(
      () => updateTimelineActivity({ id: a, start_date: "2026-02-01", lane: "high", actor, rationale }),
      () => setTimelineDependencies({ id: a, depends_on: [b], reasons: { [b]: "Needs these results" }, actor, rationale }),
    );
    expect(results.map(result => result.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(await row(a)).toMatchObject({ start_date: "2026-02-01", lane: "high", depends_on: [b], meta: {
      lane_locked: true, schedule_basis: { start: "human", end: "model" }, depends_locked: true, dependency_reasons: { [b]: "Needs these results" },
    } });
    expect(await inside(() => listEdits({ entity_id: a }))).toHaveLength(3);
  });

  it("rejects one competing edge when independently valid edges would together form a cycle", async () => {
    const [a, b] = ids as [string, string];
    const results = await race(
      () => setTimelineDependencies({ id: a, depends_on: [b], actor, rationale }),
      () => setTimelineDependencies({ id: b, depends_on: [a], actor, rationale }),
    );
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(result => result.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason.message).toMatch(/cycle/);
    const rows = await Promise.all([row(a), row(b)]);
    expect(rows.filter(value => (value.depends_on as string[]).length)).toHaveLength(1);
    expect(await inside(() => listEdits({ stage: "S10" }))).toHaveLength(1);
  });

  it("rolls back activity and earlier audit records when a later audit write fails", async () => {
    const a = ids[0]!;
    const before = await row(a);
    const [auditBefore] = await pg`select count(*)::int as n from public.audit_events where workspace_id = ${workspace.workspace_id}`;
    const signalsBefore = await inside(async () => await db().select().from(t.hillclimbSignals));
    await pg.unsafe(`CREATE FUNCTION "${schema}".fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.field = 'lane' THEN RAISE EXCEPTION 'forced audit failure'; END IF; RETURN NEW; END $$`);
    await pg.unsafe(`CREATE TRIGGER fail_audit BEFORE INSERT ON "${schema}".edit_records FOR EACH ROW EXECUTE FUNCTION "${schema}".fail_audit()`);
    try {
      await expect(inside(() => updateTimelineActivity({ id: a, start_date: "2026-02-01", lane: "high", actor, rationale }))).rejects.toMatchObject({ cause: { message: "forced audit failure" } });
      expect(await row(a)).toEqual(before);
      expect(await inside(() => listEdits({ entity_id: a }))).toHaveLength(0);
      const [auditAfter] = await pg`select count(*)::int as n from public.audit_events where workspace_id = ${workspace.workspace_id}`;
      expect(auditAfter!.n).toBe(auditBefore!.n);
      expect(await inside(async () => await db().select().from(t.hillclimbSignals))).toEqual(signalsBefore);
    } finally {
      await pg.unsafe(`DROP TRIGGER fail_audit ON "${schema}".edit_records`);
    }
  });

  it("rolls back every rebuild row if a later activity write fails", async () => {
    const before = await Promise.all(ids.map(row));
    await pg.unsafe(`CREATE FUNCTION "${schema}".fail_activity() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.id = '${ids[1]}' THEN RAISE EXCEPTION 'forced activity failure'; END IF; RETURN NEW; END $$`);
    await pg.unsafe(`CREATE TRIGGER fail_activity BEFORE UPDATE ON "${schema}".timeline_activities FOR EACH ROW EXECUTE FUNCTION "${schema}".fail_activity()`);
    try {
      await expect(inside(() => timelineModule.run(timelineModule.inputSchema.parse({ anchor: "2026-01-01", persist: true }), context())))
        .rejects.toMatchObject({ cause: { message: "forced activity failure" } });
      expect(await Promise.all(ids.map(row))).toEqual(before);
      expect(await inside(() => listEdits({ stage: "S10" }))).toHaveLength(0);
    } finally {
      await pg.unsafe(`DROP TRIGGER fail_activity ON "${schema}".timeline_activities`);
    }
  });

  it("refuses invalid dependencies without changing activity or audit", async () => {
    const a = ids[0]!;
    const before = await row(a);
    for (const dependency of [a, "ACT-missing"]) {
      await expect(inside(() => setTimelineDependencies({ id: a, depends_on: [dependency], actor, rationale }))).rejects.toThrow(/itself|Unknown activity/);
    }
    expect(await row(a)).toEqual(before);
    expect(await inside(() => listEdits({ entity_id: a }))).toHaveLength(0);
  });

  it("preserves add/remove, estimate acceptance and proposal review behavior", async () => {
    const [a, b] = ids as [string, string];
    expect(await inside(() => acceptTimelineEstimates({ ids: [a], actor, rationale }))).toEqual({ accepted: [a] });
    await inside(async () => await db().update(t.timelineActivities).set({ meta: { inputs_key: "fixture", proposed_dependencies: [{ id: b, reason: "Readout required" }] } }).where(eq(t.timelineActivities.id, a)));
    await inside(() => reviewTimelineDependency({ id: a, upstream_id: b, decision: "accept", actor, rationale }));
    expect(await row(a)).toMatchObject({ depends_on: [b], meta: { depends_locked: true, proposed_dependencies: [] } });
    await inside(() => removeTimelineActivity({ id: a, actor, rationale }));
    await inside(() => addTimelineActivity({ tactic_id: a.replace(/^ACT-/, ""), actor, rationale }));
    expect(await row(a)).toMatchObject({ depends_on: [b], meta: { removed: false } });
  });

  it("rejects a rebuild whose saved metadata changed while the model was running", async () => {
    const savedStub = process.env.SYNAPSE_TEST_STUB_LLM;
    delete process.env.SYNAPSE_TEST_STUB_LLM;
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ctx = context();
    ctx.ai = true;
    ctx.route = { ...ctx.route, connected: true, auth: "api_key", degraded: false, reason: null };
    ctx.complete = async ({ purpose, user }) => {
      const body = JSON.parse(user);
      if (purpose === "timeline-dependencies") {
        entered();
        await gate;
        return { activities: body.answer_for.map((id: string) => ({ id, depends_on: [] })) };
      }
      return { activities: body.activities.map((activity: { id: string }) => ({ id: activity.id,
        start_offset_months: 0, duration_months: 6, readout_lag_months: 1, rationale: "Estimated from study design" })) };
    };
    const building = inside(() => timelineModule.run(timelineModule.inputSchema.parse({ anchor: "2026-01-01", persist: true }), ctx));
    // Attach immediately so an unexpected provider error cannot become an unhandled rejection.
    const result = Promise.allSettled([building]);
    try {
      await started;
      await inside(() => updateTimelineActivity({ id: ids[0]!, lane: "high", actor, rationale }));
      release();
      const [outcome] = await result;
      expect(outcome!.status).toBe("rejected");
      if (outcome!.status === "rejected") expect(outcome.reason.message).toMatch(/changed.*rebuild/i);
      expect(await row(ids[0]!)).toMatchObject({ lane: "high", meta: { lane_locked: true } });
    } finally {
      release();
      await result;
      if (savedStub === undefined) delete process.env.SYNAPSE_TEST_STUB_LLM;
      else process.env.SYNAPSE_TEST_STUB_LLM = savedStub;
    }
  });

  it.each(["edit", "clear"] as const)("%s uses the resolved schema lock even when callers supply different workspace ids", async (writer) => {
    const a = ids[0]!;
    const gate = await pg.reserve();
    const lockKey = `timeline_mutations:${schema}`;
    await gate`select pg_advisory_lock(hashtext(${lockKey}))`;
    const pending = runInWorkspace({ workspace_id: "alias-for-same-schema", schema }, () =>
      writer === "edit" ? updateTimelineActivity({ id: a, lane: "high", workspace_id: "untrusted-id", actor, rationale }) : clearIngestedFiles());
    try {
      await until(async () => {
        const [count] = await pg`select count(*)::int as n from pg_locks where locktype='advisory' and not granted and objid=hashtext(${lockKey})::bigint & 4294967295`;
        return count!.n > 0;
      });
      expect((await row(a)).lane).toBe("low");
    } finally {
      await gate`select pg_advisory_unlock(hashtext(${lockKey}))`;
      gate.release();
      await pending;
    }
  });
});
