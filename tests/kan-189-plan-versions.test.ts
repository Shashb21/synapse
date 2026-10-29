/** PostgreSQL regressions for atomic Accuracy plan history and legacy migration. */
import { randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { accuracyDb, ensureAccuracySchema } from "@/accuracy/store/db";
import { ACCURACY_DDL, ACCURACY_MIGRATIONS, accuracyPlans } from "@/accuracy/store/schema";
import { getAccuracyPlanById, latestAccuracyPlan, listAccuracyPlans, saveAccuracyPlan } from "@/accuracy/store/plan-store";
import { eq } from "drizzle-orm";

// Run this before store imports initialize a pool: ordinary CI has a one-
// connection Vitest default, which cannot expose simultaneous save transactions.
vi.hoisted(() => { vi.stubEnv("DATABASE_PLATFORM_POOL_MAX", "6"); });

const pg = postgres(process.env.DATABASE_URL!, { max: 6, connection: { client_min_messages: "warning" } });
const workspaces: string[] = [];
const schemas: string[] = [];
const actor = { name: "Plan reviewer", function: "medical_affairs" as const };
const snapshot = { activities: [], tactic_ids: [], counts: { activities: 0, validated_tactics: 0 } };

/** Give every fixture a separate workspace without creating unrelated tenant records. */
function workspace() {
  const id = `kan189-${randomUUID()}`;
  workspaces.push(id);
  return id;
}

/** Exercise the public save API with valid audit information. */
function save(workspace_id: string, note = "Reviewed plan history") {
  return saveAccuracyPlan({ workspace_id, status: "final", actor, snapshot, note });
}

/** Wait on observable PostgreSQL lock state; no timing sleeps coordinate requests. */
async function waitForBlockedQueries(count: number, fragment?: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const [row] = await pg`select count(*)::int as count from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock'
      and (case when ${fragment ?? null}::text is not null then query like ${`%${fragment}%`}
        else query like '%insert into "accuracy_plans"%' or query like '%pg_advisory_xact_lock%' end)`;
    if (row.count >= count) return;
    await setImmediate();
  }
  throw new Error(`Expected ${count} requests to reach the database lock barrier`);
}

/** Run production migration SQL against a connection-scoped isolated schema. */
async function migrate(tx: Pick<postgres.TransactionSql, "unsafe">) {
  const statements = ACCURACY_MIGRATIONS.filter((statement) => statement.includes("accuracy_plans"));
  expect(statements).toHaveLength(1);
  for (const statement of statements) await tx.unsafe(statement);
}

/** Create a legacy table without uniqueness so historical races can be seeded. */
async function legacySchema() {
  const name = `kan189_${randomUUID().replaceAll("-", "")}`;
  schemas.push(name);
  await pg.unsafe(`create schema "${name}"`);
  await pg.unsafe(`create table "${name}".accuracy_plans (
    id text primary key, workspace_id text not null, version integer not null,
    status text not null, snapshot jsonb not null, note text,
    saved_by text not null, saved_function text not null, saved_at text not null)`);
  return name;
}

/** Match runtime migration execution: one statement, with no surrounding transaction. */
async function inAutocommitSchema<T>(name: string, work: (connection: Pick<postgres.TransactionSql, "unsafe">) => Promise<T>) {
  const connection = await pg.reserve();
  try {
    await connection.unsafe(`set search_path to "${name}"`);
    await connection.unsafe("set lock_timeout = '5s'");
    return await work(connection);
  } finally {
    await connection.unsafe("reset search_path");
    await connection.unsafe("reset lock_timeout");
    connection.release();
  }
}

/** Scope fixture transactions to the isolated legacy schema. */
async function inSchema<T>(name: string, work: (tx: postgres.TransactionSql) => Promise<T>) {
  return pg.begin(async (tx) => {
    await tx.unsafe(`set local search_path to "${name}"`);
    await tx`set local lock_timeout = '5s'`;
    return work(tx);
  });
}

/** Seed immutable payload and audit fields so repair cannot silently discard history. */
async function legacyRow(tx: postgres.TransactionSql, id: string, workspace_id: string, version: number, saved_at = "2026-01-01") {
  await tx`insert into accuracy_plans values (${id}, ${workspace_id}, ${version}, 'final',
    ${tx.json({ frozen: id })}, ${`note-${id}`}, ${`actor-${id}`}, 'medical_affairs', ${saved_at})`;
}

beforeAll(async () => { await ensureAccuracySchema(); });
afterEach(async () => {
  for (const id of workspaces.splice(0)) await accuracyDb().delete(accuracyPlans).where(eq(accuracyPlans.workspace_id, id));
  for (const name of schemas.splice(0)) await pg.unsafe(`drop schema if exists "${name}" cascade`);
});
afterAll(async () => { await pg.end(); vi.unstubAllEnvs(); });

describe("KAN-189 Accuracy plan allocation", () => {
  it("allocates unique consecutive versions to saves blocked behind a real database barrier", async () => {
    const id = workspace();
    let release!: () => void;
    let ready!: () => void;
    const locked = new Promise<void>((resolve) => { ready = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    const barrier = pg.begin(async (tx) => {
      await tx`set local lock_timeout = '5s'`;
      await tx`lock table accuracy_plans in share mode`;
      ready();
      await released;
    });
    await locked;
    const pending = Promise.allSettled(Array.from({ length: 3 }, () => save(id)));
    try { await waitForBlockedQueries(3); } finally { release(); await barrier; await pending; }
    const results = await pending;
    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    const versions = results.flatMap((result) => result.status === "fulfilled" ? [result.value.version] : []);
    expect(versions.sort((a, b) => a - b)).toEqual([1, 2, 3]);
    expect((await listAccuracyPlans(id)).map((plan) => plan.version)).toEqual([3, 2, 1]);
    expect((await latestAccuracyPlan(id))?.version).toBe(3);
  });

  it("rejects direct duplicate versions while isolating workspace histories", async () => {
    const id = workspace();
    const other = workspace();
    const first = await save(id);
    await expect(accuracyDb().insert(accuracyPlans).values({ ...first, id: randomUUID() })).rejects.toThrow();
    expect((await save(other)).version).toBe(1);
    expect(await getAccuracyPlanById(other, first.id)).toBeNull();
    expect((await listAccuracyPlans(id)).map((plan) => plan.id)).toEqual([first.id]);
  });

  it("rolls back an insert error and reuses the unconsumed next version", async () => {
    const id = workspace();
    const first = await save(id);
    // PostgreSQL rejects JSONB containing a null byte, after version allocation.
    const invalid = { ...snapshot, tactic_ids: ["invalid\u0000id"] };
    await expect(saveAccuracyPlan({ workspace_id: id, actor, status: "final", note: "Rejected payload", snapshot: invalid })).rejects.toThrow();
    expect((await listAccuracyPlans(id)).map((plan) => plan.id)).toEqual([first.id]);
    expect((await save(id)).version).toBe(2);
  });

  it("returns empty history and keeps rationale validation", async () => {
    const id = workspace();
    expect(await latestAccuracyPlan(id)).toBeNull();
    expect(await listAccuracyPlans(id)).toEqual([]);
    await expect(save(id, " ")).rejects.toThrow();
    expect(await listAccuracyPlans(id)).toEqual([]);
  });
});

describe("KAN-189 historical plan migration", () => {
  it("preserves all payload/audit fields and version order, repairing only duplicate workspaces", async () => {
    const name = await legacySchema();
    await inSchema(name, async (tx) => {
      await legacyRow(tx, "z-old", "broken", 2, "2026-09-01");
      await legacyRow(tx, "b-tie", "broken", 4);
      await legacyRow(tx, "a-tie", "broken", 4);
      await legacyRow(tx, "later-time", "broken", 4, "2026-02-01");
      await legacyRow(tx, "newest-version", "broken", 8, "2025-01-01");
      await legacyRow(tx, "healthy-3", "healthy", 3);
      await legacyRow(tx, "healthy-9", "healthy", 9);
      const before = await tx`select * from accuracy_plans order by id`;
      await migrate(tx);
      const after = await tx`select * from accuracy_plans order by id`;
      expect(after.map((row) => ({ ...row, version: undefined }))).toEqual(before.map((row) => ({ ...row, version: undefined })));
      expect(after.filter((row) => row.workspace_id === "healthy").map((row) => row.version)).toEqual([3, 9]);
      expect((await tx`select id, version from accuracy_plans where workspace_id = 'broken' order by version`).map((row) => [row.id, row.version])).toEqual([
        ["z-old", 1], ["a-tie", 2], ["b-tie", 3], ["later-time", 4], ["newest-version", 5],
      ]);
      await migrate(tx);
      expect(await tx`select * from accuracy_plans order by id`).toEqual(after);
    });
  });

  it("enforces uniqueness on a fresh schema using production DDL and migration", async () => {
    const name = await legacySchema();
    await inSchema(name, async (tx) => {
      await tx`drop table accuracy_plans`;
      await tx.unsafe(ACCURACY_DDL.find((statement) => statement.startsWith("CREATE TABLE IF NOT EXISTS accuracy_plans"))!);
      await migrate(tx);
      await legacyRow(tx, "first", "fresh", 1);
    });
    await expect(inSchema(name, (tx) => legacyRow(tx, "duplicate", "fresh", 1))).rejects.toMatchObject({ code: "23505" });
  });

  it("rolls repair back when uniqueness installation fails, then retries safely", async () => {
    const name = await legacySchema();
    await inSchema(name, async (tx) => {
      await legacyRow(tx, "a", "broken", 4);
      await legacyRow(tx, "b", "broken", 4);
      // A conflicting relation name forces ADD CONSTRAINT's backing index to fail.
      await tx`create table accuracy_plans_workspace_version_unique (id text)`;
    });
    await expect(inAutocommitSchema(name, migrate)).rejects.toThrow();
    await inSchema(name, async (tx) => {
      expect((await tx`select version from accuracy_plans order by id`).map((row) => row.version)).toEqual([4, 4]);
      await tx`drop table accuracy_plans_workspace_version_unique`;
    });
    await inAutocommitSchema(name, migrate);
    await inSchema(name, async (tx) => {
      expect((await tx`select version from accuracy_plans order by id`).map((row) => row.version)).toEqual([1, 2]);
    });
  });

  it("serializes concurrent migration attempts without losing rows", async () => {
    const name = await legacySchema();
    await inSchema(name, async (tx) => {
      await legacyRow(tx, "a", "broken", 1);
      await legacyRow(tx, "b", "broken", 1);
    });
    let release!: () => void;
    let ready!: () => void;
    const locked = new Promise<void>((resolve) => { ready = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    const barrier = inSchema(name, async (tx) => {
      await tx`lock table accuracy_plans in access exclusive mode`;
      ready();
      await released;
    });
    await locked;
    const pending = Promise.allSettled(Array.from({ length: 3 }, () => inAutocommitSchema(name, migrate)));
    try { await waitForBlockedQueries(3, "DO $$"); } finally { release(); await barrier; await pending; }
    expect((await pending).every((result) => result.status === "fulfilled")).toBe(true);
    await inSchema(name, async (tx) => {
      expect((await tx`select version from accuracy_plans order by version`).map((row) => row.version)).toEqual([1, 2]);
      expect((await tx`select count(*)::int as count from pg_constraint where conrelid = 'accuracy_plans'::regclass and conname = 'accuracy_plans_workspace_version_unique'`)[0].count).toBe(1);
    });
  });
});
