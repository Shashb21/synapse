/** Authenticated API boundary tests; persistence is covered by mixed-records integration tests. */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MixedComparisonError, MIXED_GATE_POLICY } from "@/accuracy/experiments/mixed-types";

const { closePool } = vi.hoisted(() => ({ closePool: vi.fn() }));
vi.mock("@/lib/iegp/db", async () => {
  const { default: postgres } = await import("postgres");
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const client = postgres(process.env.DATABASE_URL!, { max: 4 });
  closePool.mockImplementation(() => client.end({ timeout: 5 }));
  return { db: () => drizzle(client) };
});
afterAll(async () => { await closePool(); });

const mocks = vi.hoisted(() => ({ sessionContext: vi.fn(), authorizedSourceWorkspace: vi.fn(), runMixedComparison: vi.fn(), exportMixedComparison: vi.fn() }));
vi.mock("@/accuracy", () => ({ registerAccuracyStack: vi.fn() }));
vi.mock("@/modules/auth/session", () => ({ sessionContext: mocks.sessionContext }));
vi.mock("@/app/api/accuracy/experiments/request", () => ({ authorizedSourceWorkspace: mocks.authorizedSourceWorkspace }));
vi.mock("@/accuracy/experiments/mixed-comparison", () => ({ runMixedComparison: mocks.runMixedComparison }));
vi.mock("@/accuracy/experiments/mixed-records", async () => ({
  ...await vi.importActual<typeof import("@/accuracy/experiments/mixed-records")>("@/accuracy/experiments/mixed-records"),
  exportMixedComparison: mocks.exportMixedComparison,
}));
import { GET, POST } from "@/app/api/accuracy/experiments/mixed-comparisons/route";

const session = { signed_in: true, session: { subject: "owner" }, role: "contributor", actor: { name: "Session actor", function: "medical_affairs" } };
const body = { source_workspace_id: "source", source_file_ids: ["doc"], pack_id: "beone-bgb-58067-prmt5i",
  mixed: { assembly_id: "mixed", fingerprint: "mixed-fingerprint" }, baseline: { assembly_id: "baseline", fingerprint: "baseline-fingerprint" } };
const url = "http://localhost/api/accuracy/experiments/mixed-comparisons";
function post(value: unknown = body) { return POST(new Request(url, { method: "POST", body: JSON.stringify(value) })); }
function get(query = "source_workspace_id=source&comparison_id=comparison") { return GET(new Request(`${url}?${query}`)); }

beforeEach(() => {
  vi.resetAllMocks();
  mocks.sessionContext.mockResolvedValue(session);
  mocks.authorizedSourceWorkspace.mockImplementation(async id => id === "source" ? { id } : null);
  mocks.runMixedComparison.mockResolvedValue({ status: "blocked", header: { id: "comparison" } });
  mocks.exportMixedComparison.mockResolvedValue(JSON.stringify({ status: "blocked" }));
});

describe("authenticated mixed comparison API", () => {
  it("server_session_owns_actor", async () => {
    const response = await post();
    expect(response.status).toBe(201);
    expect(mocks.runMixedComparison).toHaveBeenCalledWith({ ...body, actor: session.actor });
    expect(await response.json()).toMatchObject({ comparison: { status: "blocked" } });
  });

  it("requires sign-in and validation capability before any service boundary", async () => {
    mocks.sessionContext.mockResolvedValue({ ...session, signed_in: false });
    expect((await post()).status).toBe(401);
    expect((await get()).status).toBe(401);
    mocks.sessionContext.mockResolvedValue({ ...session, role: "viewer" });
    expect((await post()).status).toBe(403);
    expect(mocks.runMixedComparison).not.toHaveBeenCalled();
    expect(mocks.exportMixedComparison).not.toHaveBeenCalled();
  });

  it.each(["actor", "org_id", "workspace_id", "comparison_id", "gold", "trusted_scope", "gate_policy", "configuration", "condition"])
  ("unknown_fields_and_gate_overrides_are_rejected: %s", async key => {
    const response = await post({ ...body, [key]: "forged" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid comparison request", code: "invalid_input" });
    expect(mocks.runMixedComparison).not.toHaveBeenCalled();
  });

  it.each([{}, { ...body, baseline: undefined }, { ...body, source_file_ids: ["doc", " doc "] },
    { ...body, mixed: { ...body.mixed, actor: session.actor } }, { ...body, baseline: { assembly_id: "baseline" } }])
  ("rejects missing nominations, nested overrides and normalized duplicate IDs", async value => {
    expect((await post(value)).status).toBe(400);
    expect(mocks.runMixedComparison).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON with a typed public validation response", async () => {
    const response = await POST(new Request(url, { method: "POST", body: "{" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid comparison request", code: "invalid_input" });
  });

  it("unauthorized_reads_do_not_disclose_comparisons", async () => {
    mocks.authorizedSourceWorkspace.mockResolvedValue(null);
    const response = await get();
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Source workspace not found" });
    expect((await post()).status).toBe(404);
    expect(mocks.exportMixedComparison).not.toHaveBeenCalled();
    expect(mocks.runMixedComparison).not.toHaveBeenCalled();
  });

  it("cannot bypass source authorization with a private copy UUID", async () => {
    expect((await get("source_workspace_id=private-copy&comparison_id=comparison")).status).toBe(404);
    expect(mocks.exportMixedComparison).not.toHaveBeenCalled();
  });

  it.each(["", "comparison_id=comparison", "source_workspace_id=source&comparison_id=",
    "source_workspace_id=source&source_workspace_id=source&comparison_id=comparison",
    "source_workspace_id=source&comparison_id=a&comparison_id=b",
    "source_workspace_id=source&comparison_id=a&format=json&format=json",
    "source_workspace_id=source&comparison_id=a&format=csv", "source_workspace_id=source&comparison_id=a&trusted_scope=true"])
  ("rejects strict query violation %s", async query => {
    const response = await get(query);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid comparison query", code: "invalid_input" });
    expect(mocks.exportMixedComparison).not.toHaveBeenCalled();
  });

  it("scopes missing and foreign comparisons identically and permits authorized viewers", async () => {
    mocks.sessionContext.mockResolvedValue({ ...session, role: "viewer" });
    mocks.exportMixedComparison.mockResolvedValue(null);
    const response = await get();
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Comparison not found in source workspace" });
    expect(mocks.exportMixedComparison).toHaveBeenCalledWith({ source_workspace_id: "source", comparison_id: "comparison", format: "json" });
  });

  it("exports_round_trip_after_live_state_changes at the retained-service boundary", async () => {
    // A frozen durable fixture is intentionally independent of mutable live inventory.
    const live = { inventory: [{ id: "live-gap" }] };
    const retained = { header: { id: "comparison", request: body, gate_policy: MIXED_GATE_POLICY }, status: "blocked", links: { mixed_experiment_id: "mixed-attempt", baseline_experiment_id: "baseline-attempt" },
      result: { evidence: { candidates: { mixed: { copied_workspace_id: "private-copy", final_outputs: { inventory: [], plan: { activities: [] } },
        stages: [{ stage: "partial_split", status: "skipped", input_count: 0 }, { stage: "prioritize", status: "blocked" }] } }, evaluation: { applicability: [{ dimension: "priority", status: "unscored" }] } } },
      attempts: { mixed: { calls: [{ input: {}, output: { placements: [] } }], evaluations: [] }, baseline: { calls: [], evaluations: [] } } };
    mocks.exportMixedComparison.mockImplementation(async ({ format }) => JSON.stringify(retained) + (format === "jsonl" ? "\n" : ""));
    const first = await get();
    live.inventory.length = 0;
    for (const format of ["json", "jsonl"]) {
      const response = await get(`source_workspace_id=source&comparison_id=comparison&format=${format}`);
      const text = await response.text();
      expect(JSON.parse(text)).toEqual(retained);
      expect(response.headers.get("content-type")).toContain(format === "jsonl" ? "application/x-ndjson" : "application/json");
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      if (format === "jsonl") expect(text.endsWith("\n")).toBe(true);
    }
    expect(await first.json()).toEqual(retained);
  });

  it.each(["invalid_input", "identity_mismatch", "invalid_attempt", "incomplete_evidence", "conflict"] as const)
  ("maps typed %s validation errors safely", async code => {
    mocks.runMixedComparison.mockRejectedValue(new MixedComparisonError(code, "Private evidence details"));
    const response = await post();
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid comparison request", code });
  });

  it("maps typed not-found errors and hides unexpected service errors", async () => {
    mocks.runMixedComparison.mockRejectedValue(new MixedComparisonError("not_found", "Private nomination"));
    expect((await post()).status).toBe(404);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.runMixedComparison.mockRejectedValue(new Error("Private store detail"));
    mocks.exportMixedComparison.mockRejectedValue(new Error("Private store detail"));
    for (const response of [await post(), await get()]) {
      expect(response.status).toBe(500);
      expect(JSON.stringify(await response.json())).not.toContain("Private");
    }
    vi.restoreAllMocks();
  });
});


describe("mixed API durable Postgres integration", () => {
  it("exports_round_trip_after_live_state_changes with real authorization and retained attempts", async () => {
    const { eq } = await import("drizzle-orm");
    const { accuracyDb } = await import("@/accuracy/store/db");
    const t = await import("@/accuracy/store/schema");
    const tenant = await import("@/accuracy/store/tenant");
    const { insertSourceFile } = await import("@/accuracy/store/source-store");
    const { publishGeneratedItemHistory } = await import("@/accuracy/store/item-history-store");
    const { createAssembly } = await import("@/accuracy/store/assembly-store");
    const { newId, nowIso } = await import("@/modules/kernel/ids");
    const actualStack = await vi.importActual<typeof import("@/accuracy")>("@/accuracy");
    const actualRequest = await vi.importActual<typeof import("@/app/api/accuracy/experiments/request")>("@/app/api/accuracy/experiments/request");
    const actualRun = await vi.importActual<typeof import("@/accuracy/experiments/mixed-comparison")>("@/accuracy/experiments/mixed-comparison");
    const actualRecords = await vi.importActual<typeof import("@/accuracy/experiments/mixed-records")>("@/accuracy/experiments/mixed-records");
    actualStack.registerAccuracyStack();
    mocks.authorizedSourceWorkspace.mockImplementation(actualRequest.authorizedSourceWorkspace);
    mocks.runMixedComparison.mockImplementation(actualRun.runMixedComparison);
    mocks.exportMixedComparison.mockImplementation(actualRecords.exportMixedComparison);
    const org_id = await tenant.createOrganization("KAN-40 API integration");
    const workspace_id = await tenant.createWorkspace({ org_id, name: "API source", slug: newId("slug") });
    const workspaces = [workspace_id];
    try {
      await tenant.grantOrganizationAccess({ subject: session.session.subject, org_id });
      const source = await insertSourceFile({ workspace_id, filename: "input.txt", mime: "text/plain", checksum: "api-original" });
      const block_id = newId("block"), run_id = newId("run"), now = nowIso();
      await accuracyDb().insert(t.accuracyParseBlocks).values({ id: block_id, workspace_id, source_file_id: source.id, index: 0,
        kind: "prose", heading: null, text: "Original evidence supports the selected tactic.", parser: "fixture", created_at: now });
      const payload = { id: newId("tactic"), name: "Selected tactic", type: "publication", status: "planned", origin: "inventory",
        evidence_question: "Evidence question", start: "2026-01-01", end: "2026-02-01",
        provenance: [{ source_file_id: source.id, block_id, quote: "supports the selected tactic" }] };
      await accuracyDb().insert(t.accuracyModuleRuns).values({ id: run_id, org_id, workspace_id, call_kind: "inventory_extract", agent_role: "judge",
        module_id: "fixture", module_version: "1", status: "ok", started_at: now, finished_at: now, actor_name: session.actor.name,
        actor_function: "medical_affairs", input: { workspace_id, source_file_id: source.id }, output: { workspace_id, source_file_id: source.id, tactics: [payload] }, steps: [] });
      await publishGeneratedItemHistory({ workspace_id, source_file_id: source.id, run_id, claim_type: "tactic",
        final_claims: [{ id: payload.id, workspace_id, source_file_id: source.id, claim_type: "tactic", statement: payload.name }] });
      const [version] = await accuracyDb().select().from(t.accuracyItemVersions).where(eq(t.accuracyItemVersions.run_id, run_id));
      const assembly = await createAssembly({ workspace_id, actor: { name: session.actor.name, function: "medical_affairs" }, source_file_ids: [source.id],
        selections: [{ item_version_id: version.id, reason: "Exact API nomination" }], mappings: [], coverage_run_ids: [], linking_complete: true });
      const request = { source_workspace_id: workspace_id, source_file_ids: [source.id], pack_id: body.pack_id,
        mixed: { assembly_id: assembly.id, fingerprint: assembly.fingerprint }, baseline: { assembly_id: assembly.id, fingerprint: assembly.fingerprint } };
      const response = await post(request);
      expect(response.status).toBe(201);
      const { comparison } = await response.json() as { comparison: import("@/accuracy/experiments/mixed-types").MixedComparisonRecord };
      for (const attempt of Object.values(comparison.attempts)) if (attempt) workspaces.push(attempt.workspace_id);
      expect(comparison.status).toBe("completed");
      expect(comparison.header.request.actor).toEqual(session.actor);
      for (const attempt of Object.values(comparison.attempts)) expect(attempt!.calls.length).toBeGreaterThan(0);
      // Mutate original and copied live projections; exports must retain terminal artifacts.
      await accuracyDb().update(t.accuracyParseBlocks).set({ text: "Changed live text" }).where(eq(t.accuracyParseBlocks.workspace_id, workspace_id));
      for (const id of workspaces) await accuracyDb().update(t.accuracyClaims).set({ statement: "Changed live claim" }).where(eq(t.accuracyClaims.workspace_id, id));
      const query = `source_workspace_id=${workspace_id}&comparison_id=${comparison.header.id}`;
      mocks.sessionContext.mockResolvedValue({ ...session, role: "viewer" });
      for (const format of ["json", "jsonl"]) {
        const exported = await get(`${query}&format=${format}`);
        expect(exported.status).toBe(200);
        expect(JSON.parse(await exported.text())).toEqual(comparison);
      }
      expect((await get(`source_workspace_id=${comparison.attempts.mixed!.workspace_id}&comparison_id=${comparison.header.id}`)).status).toBe(404);
      mocks.sessionContext.mockResolvedValue({ ...session, session: { subject: "ungranted" } });
      expect((await get(query)).status).toBe(404);
      expect((await post(request)).status).toBe(404);
    } finally {
      await accuracyDb().delete(t.accuracyMixedComparisons).where(eq(t.accuracyMixedComparisons.source_workspace_id, workspace_id));
      for (const id of workspaces.reverse()) await tenant.deleteWorkspace(id);
    }
  });
});
