/** Real-owner lock-order regression proofs for the PR111/KAN121 integration. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }), headers: async () => new Headers() }));
import "@/modules";
import { POST } from "@/app/api/iegp/route";
import { relationshipSnapshot, relationshipVersion } from "@/lib/iegp/relationship-version";
import { sql } from "drizzle-orm";
import { db, poolSize, withWorkspaceTransaction } from "@/lib/iegp/db";
import * as store from "@/lib/iegp/store";
import { createManualSource } from "@/lib/iegp/source-blocks";
import { linkSourceSupport } from "@/lib/iegp/source-review";
import * as sourceReviews from "@/lib/iegp/source-review";
import { compareSource, listSourceComparisons } from "@/lib/ingest/compare-source";
import { findProvider } from "@/modules/llm/provider";
import { setupContextFromState } from "@/lib/iegp/planning-context";
import { modelMappingSupport } from "./support/model-mapping";

const actor = { actor_name: "Merge lock reviewer", actor_function: "medical_affairs" as const };
let gapId: string, tacticId: string;
beforeEach(async () => {
  await store.resetDemoSetup();
  gapId = await store.createGap({ statement: "Adult comparative outcomes", ...actor });
  tacticId = await store.recordMissedTactic({ name: "Lock-order protocol", type: "rwe_study", evidence_question: "Adult comparative outcomes", status: "ongoing", ...actor });
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

/** Hold the canonical tactic row while the production owners acquire their earlier locks. */
async function holdTactic() {
  let ready!: () => void, release!: () => void;
  const held = new Promise<void>(resolve => { ready = resolve; });
  const resume = new Promise<void>(resolve => { release = resolve; });
  const done = withWorkspaceTransaction(async () => {
    await db().execute(sql`select id from tactics where id = ${tacticId} for update`);
    ready(); await resume;
  });
  await held;
  return { release, done };
}

/** Observe actual blocked sessions instead of guessing scheduling from elapsed time. */
async function waiter(fragment: string) {
  let row: { pid: number; blockers: number[] } | undefined;
  await vi.waitFor(async () => {
    const rows = await db().execute(sql`select pid, pg_blocking_pids(pid) as blockers from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like ${`%${fragment}%`}`);
    expect(rows).toHaveLength(1);
    row = rows[0] as unknown as { pid: number; blockers: number[] };
  }, { timeout: 3000, interval: 20 });
  return row!;
}

it.skipIf(poolSize("workspace") < 4)("makes Setup wait on model gap membership before either owner can reverse objective locks", async () => {
  const support = await modelMappingSupport(gapId, tacticId);
  const context = setupContextFromState(await store.loadState());
  const held = await holdTactic();
  const model = store.assignTacticToGap({ gap_id: gapId, tactic_id: tacticId, coverage: "partial", model: true, assessment_origin: "ai", note: "Model proposes supported partial coverage", ...support, ...actor });
  let setup: Promise<unknown> | undefined;
  try {
    const waitingModel = await waiter('from "tactics"');
    const membership = await db().execute(sql`select pid from pg_locks where pid = ${waitingModel.pid} and relation = 'gaps'::regclass and mode = 'RowExclusiveLock' and granted`);
    expect(membership).toHaveLength(1);
    setup = store.saveProductSetup({ context: { ...context, markets: ["Updated integration geography"] }, reason: "Setup reviews its context after model proposal", ...actor });
    const waitingSetup = await waiter("LOCK TABLE gaps IN EXCLUSIVE MODE");
    expect(waitingSetup.blockers).toContain(waitingModel.pid);
  } finally {
    held.release(); await held.done;
    await Promise.all([model, ...(setup ? [setup] : [])]);
  }
  const state = await store.loadState();
  expect(state.coverages).toHaveLength(1);
  expect(state.coverages[0]).toMatchObject({ overall: "partial", stale: true, assessment_origin: "ai" });
});

it.skipIf(poolSize("workspace") < 4)("serializes source support and model owners before they can reserve source and tactic in opposite orders", async () => {
  const source = await createManualSource({ title: "Cited protocol", source_type: "stakeholder_interview", stakeholder_function: "medical_affairs", blocks: [{ text: "The study includes adults." }], rationale: "Retain source for lock-order proof", actor: { name: actor.actor_name, function: actor.actor_function } });
  const support = await modelMappingSupport(gapId, tacticId);
  const held = await holdTactic();
  const creation = linkSourceSupport({ source_id: source.source_id, block_id: source.blocks[0].id, passage: "The study includes adults.", tactic_id: tacticId, rationale: "The retained protocol supports this relationship", origin: "human", ...actor });
  let model: Promise<unknown> | undefined;
  try {
    const waitingSource = await waiter("from tactics where id =");
    model = store.assignTacticToGap({ gap_id: gapId, tactic_id: tacticId, coverage: "partial", model: true, assessment_origin: "ai", note: "Model proposes partial coverage after source review", ...support, ...actor });
    const waitingModel = await waiter("pg_advisory_xact_lock");
    expect(waitingModel.blockers).toContain(waitingSource.pid);
  } finally {
    held.release(); await held.done;
    await Promise.all([creation, ...(model ? [model] : [])]);
  }
  const state = await store.loadState();
  expect(state.source_reviews).toHaveLength(1);
  expect(state.source_reviews![0]).toMatchObject({ kind: "support", status: "linked" });
  expect(state.coverages).toHaveLength(1);
  expect(state.coverages[0]).toMatchObject({ overall: "partial", assessment_origin: "ai" });
});


it.skipIf(poolSize("workspace") < 3)("rejects an opened unassign after a canonical design edit while preserving its relationship and history", async () => {
  await store.assignTacticToGap({ gap_id: gapId, tactic_id: tacticId, coverage: "partial", human: true, note: "Original reviewed partial relationship", ...actor });
  const opening = relationshipVersion(relationshipSnapshot(await store.loadState(), gapId, tacticId));
  let ready!: () => void, release!: () => void;
  const held = new Promise<void>(resolve => { ready = resolve; });
  const resume = new Promise<void>(resolve => { release = resolve; });
  let edited: Awaited<ReturnType<typeof store.loadState>> | undefined;
  const editor = withWorkspaceTransaction(async () => {
    await store.modifyTactic({ tactic_id: tacticId, fields: { population: "Children" }, rationale: "Canonical design changed after unassign opened", ...actor });
    edited = await store.loadState();
    ready(); await resume;
  });
  await held;
  const pending = POST(new Request("http://localhost/api/iegp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "unassign_tactic", gap_id: gapId, tactic_id: tacticId, expected_relationship: opening, rationale: "Opened removal on the earlier adult design", ...actor }) }));
  try { await waiter("from tactics where id ="); }
  finally { release(); await editor; }
  const response = await pending;
  expect(response.status).toBe(400);
  expect((await response.json()).error).toContain("Relationship changed");
  const after = await store.loadState();
  expect(after.coverages).toEqual(edited!.coverages);
  expect(after.coverages[0]).toMatchObject({ overall: "partial", stale: true });
  expect(after.mapping_suggestions).toEqual(edited!.mapping_suggestions);
  expect(after.audit).toEqual(edited!.audit);
});


it.skipIf(poolSize("workspace") < 4)("holds the relationship advisory throughout real comparison application before a model owner can reserve records", async () => {
  const source = await createManualSource({ title: "Compared protocol", source_type: "stakeholder_interview", stakeholder_function: "medical_affairs", blocks: [{ text: "The study includes children." }], rationale: "Retain the actual compared protocol", actor: { name: actor.actor_name, function: actor.actor_function } });
  const support = await modelMappingSupport(gapId, tacticId);
  vi.stubEnv("XAI_API_KEY", "task146-deterministic-provider");
  vi.spyOn(findProvider("xai-grok")!, "complete").mockResolvedValue(JSON.stringify({ outcomes: [{ block_id: source.blocks[0].id, passage: "The study includes children.", match: "same", judgment: "conflict", gap_id: null, tactic_id: tacticId, coverage_id: null, rationale: "The retained protocol challenges adult design" }] }));
  let ready!: () => void, release!: () => void;
  const applying = new Promise<void>(resolve => { ready = resolve; });
  const resume = new Promise<void>(resolve => { release = resolve; });
  const original = sourceReviews.createSourceDiscrepancy;
  vi.spyOn(sourceReviews, "createSourceDiscrepancy").mockImplementationOnce(async args => {
    // This is inside the real comparison transaction, before its nested review owner.
    ready(); await resume; return original(args);
  });
  const comparison = compareSource(source.source_id, { name: actor.actor_name, function: actor.actor_function });
  await applying;
  const model = store.assignTacticToGap({ gap_id: gapId, tactic_id: tacticId, coverage: "partial", model: true, assessment_origin: "ai", note: "Model proposes partial coverage after comparison", ...support, ...actor });
  try { await waiter("pg_advisory_xact_lock"); }
  finally { release(); await Promise.all([comparison, model]); }
  // Model may change the compared basis between comparison transactions; retry the new basis explicitly.
  await compareSource(source.source_id, { name: actor.actor_name, function: actor.actor_function });
  const state = await store.loadState();
  expect(state.source_reviews).toHaveLength(1);
  expect(state.source_reviews![0]).toMatchObject({ kind: "discrepancy", status: "pending", tactic_id: tacticId });
  expect(state.coverages).toHaveLength(1);
  expect(state.coverages[0]).toMatchObject({ overall: "partial", assessment_origin: "ai" });
  expect((await listSourceComparisons())[0]).toMatchObject({ status: "completed", basis_current: true, review_ids: [state.source_reviews![0].id] });
});
