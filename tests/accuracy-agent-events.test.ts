/** Persistence and tenant boundaries for agent loop events. */
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement, ReactNode } from "react";
import { vi } from "vitest";
import { GET as detailGet } from "@/app/api/accuracy/runs/[run_id]/route";
import AccuracyRunDetailPage from "@/app/accuracy/runs/[run_id]/page";
import { appendAgentEvent, readAgentProgression } from "@/accuracy/kernel/agent-events";
import { accuracyDb, ensureAccuracySchema } from "@/accuracy/store/db";
import * as t from "@/accuracy/store/schema";
import { createOrganization, createWorkspace, deleteWorkspace } from "@/accuracy/store/tenant";
import { newId, nowIso } from "@/modules/kernel/ids";

const auth = vi.hoisted(() => ({ signed_in: true }));
vi.mock("@/modules/auth/session", () => ({
  sessionContext: async () => ({ signed_in: auth.signed_in, demo: true }),
}));

function renderPageContent(page: ReactElement): string {
  return renderToStaticMarkup((page as ReactElement<{ children: ReactNode }>).props.children);
}

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
  completeness: {
    risk_level: "important" as const,
    checked_block_ids: ["block-2"], unchecked_block_ids: [],
    suspected_omissions: [{
      issue_id: "issue-1", item_kind: "gap" as const, summary: "Regional evidence need omitted",
      source_ref: { source_file_id: "source-1", block_id: "block-2" },
      evidence_quote: "Regional evidence need", basis: "explicit" as const,
      importance: "important" as const, reason: "No matching gap",
      suggested_action: "Add the source-backed gap",
    }],
    prior_issue_resolutions: [],
  },
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
    await expect(appendAgentEvent({ ...ids, event: { ...critique, recall: 0.99 } as never })).rejects.toThrow();
    await expect(appendAgentEvent({ ...ids, event: { ...critique, completeness: {
      ...critique.completeness, f1: 0.99 }, iteration: 1 } as never })).rejects.toThrow();
    await expect(appendAgentEvent({ ...ids, event: { ...critique, completeness: {
      ...critique.completeness, suspected_omissions: [{ ...critique.completeness.suspected_omissions[0],
        precision: 0.99 }] }, iteration: 1 } as never })).rejects.toThrow();
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

  it("removes an event appended between event cleanup and parent run deletion", async () => {
    const ids = await fixture();
    const db = accuracyDb();
    // Force the dangerous order of a concurrent append and workspace deletion.
    await db.delete(t.accuracyAgentEvents).where(eq(t.accuracyAgentEvents.workspace_id, ids.workspace_id));
    await appendAgentEvent({ ...ids, event: v0 });
    await db.delete(t.accuracyModuleRuns).where(eq(t.accuracyModuleRuns.id, ids.run_id));

    expect(await db.select().from(t.accuracyAgentEvents).where(eq(t.accuracyAgentEvents.run_id, ids.run_id))).toEqual([]);
    await expect(appendAgentEvent({ ...ids, event: v0 })).rejects.toThrow();
  });
});

describe("run progression detail", () => {
  it("shows an input error for repeated workspace IDs without reading snapshots", async () => {
    auth.signed_in = true;
    const ids = await fixture();
    await appendAgentEvent({ ...ids, event: v0 });

    const html = renderPageContent(await AccuracyRunDetailPage({
      params: Promise.resolve({ run_id: ids.run_id }),
      searchParams: Promise.resolve({ workspace_id: [ids.workspace_id, "other-workspace"] }),
    }));
    expect(html).toContain("One workspace_id is required");
    expect(html).not.toContain("Exact V0");
  });

  it("returns exact V0 and V1, critique, and selected version for a signed-in user", async () => {
    auth.signed_in = true;
    const ids = await fixture();
    const v1 = { ...v0, iteration: 1, output: { gaps: [{ statement: "Exact V1" }] },
      signals: { ...v0.signals, quote_validity: { valid_count: 0, invalid_count: 0, unchecked_count: 0 } } };
    const judgment = {
      event_type: "judgment" as const, selected_iteration: 1, reason: "Source-backed revision",
      latency_ms: 25, token_usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 }, cost_usd: 0.0002,
    };
    for (const event of [v0, critique, v1, judgment]) await appendAgentEvent({ ...ids, event });

    const response = await detailGet(
      new Request(`http://localhost/api/accuracy/runs/${ids.run_id}?workspace_id=${ids.workspace_id}`),
      { params: Promise.resolve({ run_id: ids.run_id }) },
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.progression.events.map((row: { event: unknown }) => row.event)).toEqual([v0, critique, v1, judgment]);

    const html = renderPageContent(await AccuracyRunDetailPage({
      params: Promise.resolve({ run_id: ids.run_id }),
      searchParams: Promise.resolve({ workspace_id: ids.workspace_id }),
    }));
    expect(html).toContain("V0");
    expect(html).toContain("V1");
    expect(html).toContain("Exact V0");
    expect(html).toContain("Exact V1");
    expect(html).toContain("Source-backed revision");
    expect(html).toContain("Selected version");
    expect(html).toContain("No invariant failures recorded");
    expect(html).not.toContain("Invariant failures: none");
    expect(html).toContain("No source quote spans to check");
  });

  it("requires a session even in demo mode and hides wrong-workspace runs", async () => {
    const ids = await fixture();
    const other = await fixture();
    await appendAgentEvent({ ...ids, event: v0 });
    const request = new Request(`http://localhost/api/accuracy/runs/${ids.run_id}?workspace_id=${ids.workspace_id}`);
    auth.signed_in = false;
    try {
      expect((await detailGet(request, { params: Promise.resolve({ run_id: ids.run_id }) })).status).toBe(401);
      const html = renderPageContent(await AccuracyRunDetailPage({
        params: Promise.resolve({ run_id: ids.run_id }),
        searchParams: Promise.resolve({ workspace_id: ids.workspace_id }),
      }));
      expect(html).toContain("Sign in");
      expect(html).not.toContain("Exact V0");
    } finally {
      auth.signed_in = true;
    }
    const wrong = await detailGet(
      new Request(`http://localhost/api/accuracy/runs/${ids.run_id}?workspace_id=${other.workspace_id}`),
      { params: Promise.resolve({ run_id: ids.run_id }) },
    );
    expect(wrong.status).toBe(404);
  });
});
