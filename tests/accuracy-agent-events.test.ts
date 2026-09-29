/** Persistence and tenant boundaries for agent loop events. */
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { appendAgentEvent, readAgentProgression } from "@/accuracy/kernel/agent-events";
import { accuracyDb, ensureAccuracySchema } from "@/accuracy/store/db";
import * as t from "@/accuracy/store/schema";
import { createOrganization, createWorkspace, deleteWorkspace } from "@/accuracy/store/tenant";
import { newId, nowIso } from "@/modules/kernel/ids";

async function fixture(status = "ok") {
  await ensureAccuracySchema();
  const org_id = await createOrganization("agent-events-test");
  const workspace_id = await createWorkspace({ org_id, name: "Agent events", slug: newId("slug") });
  const run_id = newId("arun");
  await accuracyDb().insert(t.accuracyModuleRuns).values({
    id: run_id, org_id, workspace_id, call_kind: "need_extract", agent_role: "proposer",
    module_id: "agent-events-test", module_version: "1", status, started_at: nowIso(),
    actor_name: "test", actor_function: "medical_affairs", input: {}, steps: [],
  });
  return { run_id, workspace_id };
}

const v0 = {
  event_type: "snapshot" as const,
  iteration: 0,
  output: { gaps: [{ id: "gap-1", statement: "Exact V0", evidence: "x".repeat(5000) }] },
  evaluation_context: "production" as const,
  signals: {
    quote_validity: { valid_count: 1, invalid_count: 0, unchecked_count: 0 },
    invariant_failures: [],
    completeness: "not_checked" as const,
  },
  latency_ms: 120,
  token_usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  cost_usd: 0.001,
};

const critique = {
  event_type: "critique" as const,
  iteration: 0,
  score: 0.7,
  issues: [{
    issue_id: "issue-1", category: "omission", code: "missing_gap", severity: "high" as const,
    claim: "Regional evidence need omitted",
    source_ref: { source_file_id: "source-1", block_id: "block-2" },
    suggested_action: "Add the source-backed gap",
  }],
  latency_ms: 60,
  token_usage: { prompt_tokens: 8, completion_tokens: 7, total_tokens: 15 },
  cost_usd: 0.0005,
};

describe("agent event persistence", () => {
  it("retains exact V0, critique, V1 and judgment in progression order", async () => {
    const ids = await fixture();
    const v1 = { ...v0, iteration: 1, output: { gaps: [{ id: "gap-1", statement: "Exact V1" }] } };
    const judgment = {
      event_type: "judgment" as const, selected_iteration: 1, reason: "Source-backed revision",
      latency_ms: 25, token_usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 }, cost_usd: 0.0002,
    };
    for (const event of [v0, critique, v1, judgment]) {
      await appendAgentEvent({ ...ids, event });
    }

    const progression = await readAgentProgression(ids);
    expect(progression).not.toBeNull();
    expect(progression?.events.map(({ event_type, iteration }) => [event_type, iteration])).toEqual([
      ["snapshot", 0], ["critique", 0], ["snapshot", 1], ["judgment", -1],
    ]);
    expect(progression?.events.map(({ id }) => id).every((id) => typeof id === "string" && id.length > 0)).toBe(true);
    expect(new Set(progression?.events.map(({ id }) => id)).size).toBe(4);
    expect(progression?.events.map(({ event }) => event)).toEqual([v0, critique, v1, judgment]);
    expect(progression?.events[0].recorded_at).toBeTruthy();
  });

  it("rejects duplicate events and gold metrics in production payloads", async () => {
    const ids = await fixture();
    await appendAgentEvent({ ...ids, event: v0 });
    await expect(appendAgentEvent({ ...ids, event: v0 })).rejects.toThrow();
    await expect(appendAgentEvent({ ...ids, event: { ...v0, precision: 0.99 } as never })).rejects.toThrow();
    await expect(appendAgentEvent({ ...ids, event: { ...v0, iteration: 1, output: undefined } as never })).rejects.toThrow();
    expect((await readAgentProgression(ids))?.events).toHaveLength(1);
  });

  it("scopes appends and reads to the run's workspace", async () => {
    const ids = await fixture();
    const other = await fixture();
    await expect(appendAgentEvent({ run_id: ids.run_id, workspace_id: other.workspace_id, event: v0 })).rejects.toThrow();
    await appendAgentEvent({ ...ids, event: v0 });
    expect(await readAgentProgression({ run_id: ids.run_id, workspace_id: other.workspace_id })).toBeNull();
  });

  it("keeps early events after a run errors", async () => {
    const ids = await fixture("error");
    await appendAgentEvent({ ...ids, event: v0 });
    expect((await readAgentProgression(ids))?.events[0].event).toEqual(v0);
  });

  it("deletes event rows with their workspace", async () => {
    const ids = await fixture();
    await appendAgentEvent({ ...ids, event: v0 });
    const result = await deleteWorkspace(ids.workspace_id);
    expect(result.deleted.agent_events).toBe(1);
    expect(await accuracyDb().select().from(t.accuracyAgentEvents).where(eq(t.accuracyAgentEvents.workspace_id, ids.workspace_id))).toEqual([]);
  });
});
