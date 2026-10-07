import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { GET, POST } from "@/app/api/accuracy/claims/priority/route";
import { createSession, signOut, SESSION_COOKIE } from "@/modules/auth/session";
import { aiSwitch, setAiEnabled } from "@/modules/kernel/ai-switch";
import { createOrganization, createWorkspace, deleteWorkspace } from "@/accuracy/store/tenant";
import { applyClaimValidation, insertClaim } from "@/accuracy/store/claim-store";
import { newId } from "@/modules/kernel/ids";
import { coverageProvenance } from "./support/coverage-provenance";
import { accuracyTransactionActive } from "@/accuracy/store/db";
import { openAi } from "@/modules/llm/provider";
import { accuracyRouteConfig, setAccuracyRouteConfig } from "@/accuracy/kernel/routing";
import { inArray, sql } from "drizzle-orm";
import { db, ensurePlatformSchema, sharedDb } from "@/modules/kernel/db";
import { priorityAxes } from "@/modules/kernel/schema";
import { DEFAULT_AXES, loadAxes, saveAxes, saveScopeAxes } from "@/modules/stages/s8-prioritization/axes";
import { runInWorkspace, WORKSPACE_COOKIE, workspaceCookieValue } from "@/modules/workspaces/context";
import { createWorkspace as createPlanWorkspace } from "@/modules/workspaces/store";
import { listAccuracyPlacements } from "@/accuracy/store/priority-store";
const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (name: string) => jar.has(name) ? { value: jar.get(name)! } : undefined,
  set: (name: string, value: string) => void jar.set(name, value), delete: (name: string) => void jar.delete(name) }), headers: async () => new Headers() }));
const ids: string[] = [];
let suiteStub: string | undefined;
beforeEach(() => { suiteStub = process.env.SYNAPSE_TEST_STUB_LLM; process.env.SYNAPSE_TEST_STUB_LLM = ""; });
afterEach(async () => { if (suiteStub === undefined) delete process.env.SYNAPSE_TEST_STUB_LLM; else process.env.SYNAPSE_TEST_STUB_LLM = suiteStub; await signOut(); jar.clear(); for (const id of ids.splice(0)) await deleteWorkspace(id); });
const req = (body: unknown) => new Request("http://localhost/api/accuracy/claims/priority", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
async function fixture(settings?: string[]) {
  const org_id = await createOrganization("Priority API"), workspace_id = await createWorkspace({ org_id, name: "Priority", slug: newId("priority") }); ids.push(workspace_id);
  const evidence = await coverageProvenance(workspace_id, "Need patient outcomes.");
  const actor = { name: "Fixture", function: "heor" as const };
  const gap = await insertClaim({ workspace_id, claim_type: "gap", source_file_id: evidence[0].source_file_id, statement: "Need patient outcomes.", metadata: { provenance: evidence, ...(settings ? { settings } : {}) } });
  await applyClaimValidation({ workspace_id, claim_ids: [gap.id], action: "validate", actor, rationale: "Verified source facts" });
  await createSession({ provider_id: "demo", subject: crypto.randomUUID(), actor_name: "Session reviewer", actor_function: "medical_affairs", role: "operator" });
  return { workspace_id, gap };
}
it("serves revision-bound manual configuration/validation with AI off and authenticates the actor", async () => {
  const f = await fixture(), prior = await aiSwitch();
  try {
    await setAiEnabled({ enabled: false, actor_name: "Fixture" });
    const read = await GET(new Request(`http://localhost/api/accuracy/claims/priority?workspace_id=${f.workspace_id}&gap_id=${f.gap.id}`));
    expect(read.status).toBe(200); const state = await read.json();
    expect(state).toMatchObject({ eligible: true, placements: [], expected_input_revision: expect.any(String), expected_config_revision: expect.any(String) });
    const body = { workspace_id: f.workspace_id, gap_id: f.gap.id, action: "validate", band: "defer", rationale: "Human decides to defer this cycle",
      expected_input_revision: state.expected_input_revision, expected_config_revision: state.expected_config_revision, actor_name: "Forged actor" };
    const response = await POST(req(body)); expect(response.status).toBe(200);
    expect((await response.json()).placement).toMatchObject({ validated: true, actor_name: "Session reviewer", validation: { by: "Session reviewer", freshness: "current" } });
    expect((await POST(req({ ...body, expected_input_revision: "stale" }))).status).toBe(409);
    expect((await POST(req({ ...body, rationale: "" }))).status).toBe(400);
    const suggestion = await POST(req({ action: "suggest", workspace_id: f.workspace_id, gap_ids: [f.gap.id] }));
    expect(suggestion.status).toBe(409); expect(await suggestion.json()).toMatchObject({ code: "ai_off" });
  } finally { await setAiEnabled({ enabled: prior.enabled, actor_name: "Fixture restore" }); }
});
it("saves source-backed planning context through the workspace configuration boundary", async () => {
  const f = await fixture();
  const state = await (await GET(new Request(`http://localhost/api/accuracy/claims/priority?workspace_id=${f.workspace_id}&gap_id=${f.gap.id}`))).json();
  const response = await POST(req({ action: "configure", workspace_id: f.workspace_id, expected_config_revision: state.config.revision,
    context: { key_decision: "Patient outcomes dossier" }, considerations: { payer_relevance: { text: "Need patient outcomes.", references: state.references } }, rationale: "Use verified patient evidence" }));
  expect(response.status).toBe(200);
  const after = await (await GET(new Request(`http://localhost/api/accuracy/claims/priority?workspace_id=${f.workspace_id}&gap_id=${f.gap.id}`))).json();
  expect(after).toMatchObject({ context: { key_decision: "Patient outcomes dossier" }, considerations: { payer_relevance: { state: "supported", references: state.references } } });
  expect(after.limitations).not.toContain("Missing context: payer_relevance");
  const before = after.config.revision;
  const invalid = await POST(req({ action: "configure", workspace_id: f.workspace_id, expected_config_revision: before,
    considerations: { payer_relevance: { text: "Untrusted quote", references: [{ ...state.references[0], block_id: "other-workspace-block" }] } }, rationale: "Invalid reference must fail atomically" }));
  expect(invalid.status).toBe(400);
  expect((await (await GET(new Request(`http://localhost/api/accuracy/claims/priority?workspace_id=${f.workspace_id}`))).json()).config.revision).toBe(before);
});

it("runs the real provider/API boundary outside transactions, persists unvalidated suggestions, and sanitizes provider errors", async () => {
  const f = await fixture(), saved = await accuracyRouteConfig("prioritize", "proposer"), oldStub = process.env.SYNAPSE_TEST_STUB_LLM, oldKey = process.env.OPENAI_API_KEY;
  process.env.SYNAPSE_TEST_STUB_LLM = ""; process.env.OPENAI_API_KEY = "fixture-key";
  let fail = false; const calls: string[] = [];
  const provider = vi.spyOn(openAi, "complete").mockImplementation(async ({ user }) => {
    expect(accuracyTransactionActive()).toBe(false);
    if (fail) throw new Error("Private provider failure with credential details");
    const data = JSON.parse(user);
    expect(data.considerations).toHaveProperty("unmet_need.state", "missing");
    if (data.gaps) {
      calls.push("proposer"); expect(data.gaps[0].evidence.references).toHaveLength(1);
      return JSON.stringify({ gaps: data.gaps.map((g: { id: string }) => ({ gap_id: g.id, scores: { effort_cost: 90, decision_impact: 10 }, rationale: "High effort and limited impact" })) });
    }
    calls.push("critic"); return JSON.stringify({ reviews: data.placements.map((p: { gap_id: string }) => ({ gap_id: p.gap_id, verdict: "keep", confidence: 85, note: "Both score directions are defensible with missing context explicit" })) });
  });
  try {
    await setAccuracyRouteConfig({ call_kind: "prioritize", agent_role: "proposer", provider_id: "openai", model: openAi.default_model, fallbacks: [], actor_name: "Fixture" });
    const request = { action: "suggest", workspace_id: f.workspace_id, gap_ids: [f.gap.id], x_axis: "effort_cost", y_axis: "decision_impact" };
    const result = await POST(req(request)); expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ run_id: expect.any(String), placements: [expect.objectContaining({ band: "defer", suggested_band: "defer", validated: false })] });
    expect(calls).toEqual(["proposer", "critic", "critic", "critic"]);
    const before = await (await GET(new Request(`http://localhost/api/accuracy/claims/priority?workspace_id=${f.workspace_id}`))).json();
    fail = true;
    const error = await POST(req(request)); expect(error.status).toBe(500); expect(await error.json()).toEqual({ ok: false, error: "Priority action failed" });
    expect((await (await GET(new Request(`http://localhost/api/accuracy/claims/priority?workspace_id=${f.workspace_id}`))).json()).placements).toEqual(before.placements);
  } finally {
    provider.mockRestore();
    if (oldStub === undefined) delete process.env.SYNAPSE_TEST_STUB_LLM; else process.env.SYNAPSE_TEST_STUB_LLM = oldStub;
    if (oldKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldKey;
    await setAccuracyRouteConfig({ ...saved, actor_name: saved.updated_by, temperature: saved.params.temperature, max_tokens: saved.params.max_tokens });
  }
});
it("denies viewers and unknown workspaces and rejects malformed JSON", async () => {
  const f = await fixture(); await signOut();
  await createSession({ provider_id: "demo", subject: crypto.randomUUID(), actor_name: "Viewer", actor_function: "heor", role: "viewer" });
  expect((await GET(new Request(`http://localhost/api/accuracy/claims/priority?workspace_id=${f.workspace_id}`))).status).toBe(403);
  expect((await POST(req({ action: "suggest", workspace_id: f.workspace_id }))).status).toBe(403);
  await signOut(); await createSession({ provider_id: "demo", subject: crypto.randomUUID(), actor_name: "Owner", actor_function: "heor", role: "operator" });
  expect((await GET(new Request("http://localhost/api/accuracy/claims/priority?workspace_id=missing"))).status).toBe(404);
  expect((await POST(new Request("http://localhost", { method: "POST", body: "{" }))).status).toBe(400);
});

const defaultWorkspace = { workspace_id: "default", schema: "public" };
const savedPairs = {
  all: { x_axis: "patient_impact", y_axis: "payer_value" },
  "1l": { x_axis: "effort_cost", y_axis: "decision_impact" },
  perioperative: { x_axis: "time_pressure", y_axis: "strategic_fit" },
};
// Preserve the real Default rows around the test's public-owner fixture writes.
async function withSavedDefaultAxes(check: () => Promise<void>) {
  const ids = ["default", ...Object.keys(savedPairs).map(scope => `scope:${scope}`)];
  const prior = await runInWorkspace(defaultWorkspace, async () => {
    await ensurePlatformSchema();
    return db().select().from(priorityAxes).where(inArray(priorityAxes.id, ids));
  });
  try {
    await runInWorkspace(defaultWorkspace, async () => {
      await saveAxes({ config: DEFAULT_AXES, actor_name: "Default seed reviewer" });
      for (const [scope, pair] of Object.entries(savedPairs)) {
        await saveScopeAxes({ scope, ...pair, actor_name: "Default seed reviewer" });
      }
    });
    await check();
  } finally {
    await runInWorkspace(defaultWorkspace, async () => {
      await db().delete(priorityAxes).where(inArray(priorityAxes.id, ids));
      if (prior.length) await db().insert(priorityAxes).values(prior);
    });
  }
}
it.each(["general GET", "list", "1L", "Perioperative"])("inherits every saved scope independent of the first %s read", async first => {
  await withSavedDefaultAxes(async () => {
    const f = await fixture(["1L", "Perioperative"]);
    const url = `http://localhost/api/accuracy/claims/priority?workspace_id=${f.workspace_id}`;
    if (first === "list") expect(await listAccuracyPlacements(f.workspace_id)).toEqual([]);
    else expect((await GET(new Request(url + (first === "general GET" ? "" : `&setting=${first}`)))).status).toBe(200);
    const general = await (await GET(new Request(url))).json();
    expect(general.config).toMatchObject({ catalog: { x_axis: "decision_impact", y_axis: "time_pressure" }, scopes: savedPairs });
    for (const [setting, pair] of Object.entries(savedPairs)) {
      const response = await GET(new Request(`${url}&gap_id=${f.gap.id}&setting=${setting}`));
      expect(response.status).toBe(200);
      const state = await response.json();
      expect(state).toMatchObject({ ...pair, pair_chosen: true, eligible: true, config: general.config });
      expect(state.axes.map((axis: { id: string }) => axis.id)).toEqual([pair.x_axis, pair.y_axis]);
      expect(state.expected_config_revision).not.toBe(state.config.revision);
      if (setting === "1l") expect(state.axes[0]).toMatchObject({ id: "effort_cost", higher_is_priority: false });
    }
  });
});

it("snapshots Default once across concurrent reads and keeps Accuracy edits isolated from later Default edits and an unrelated cookie", async () => {
  await withSavedDefaultAxes(async () => {
    const f = await fixture(["1L", "Perioperative"]), reverse = await fixture();
    const plan = await createPlanWorkspace({ name: "Unrelated priority cookie", owner: "priority-cookie@fixture.test" });
    try {
      await runInWorkspace({ workspace_id: plan.id, schema: plan.schema_name }, async () => {
        await saveAxes({ config: { ...DEFAULT_AXES, x_axis: "strategic_fit", y_axis: "effort_cost" }, actor_name: "Unrelated reviewer" });
        await saveScopeAxes({ scope: "1L", x_axis: "payer_value", y_axis: "patient_impact", actor_name: "Unrelated reviewer" });
      });
      jar.set(WORKSPACE_COOKIE, workspaceCookieValue(plan.id, jar.get(SESSION_COOKIE)!));
      expect(await loadAxes()).toMatchObject({ x_axis: "strategic_fit", y_axis: "effort_cost" });
      const url = `http://localhost/api/accuracy/claims/priority?workspace_id=${f.workspace_id}`;
      const reads = await Promise.all([GET(new Request(url)), GET(new Request(`${url}&setting=1L`)), listAccuracyPlacements(f.workspace_id)]);
      expect(reads[2]).toEqual([]);
      const general = await (reads[0] as Response).json(), setting = await (reads[1] as Response).json();
      expect(general.config).toMatchObject({ catalog: { x_axis: "decision_impact", y_axis: "time_pressure" }, scopes: savedPairs });
      expect(setting.config).toEqual(general.config);
      const reverseUrl = `http://localhost/api/accuracy/claims/priority?workspace_id=${reverse.workspace_id}`;
      expect((await (await GET(new Request(`${reverseUrl}&setting=Perioperative`))).json()).config).toEqual(general.config);
      expect((await (await GET(new Request(reverseUrl))).json()).config).toEqual(general.config);

      const config = { ...general.config.catalog, axes: general.config.catalog.axes.map((axis: { id: string }) => axis.id === "effort_cost" ? { ...axis, higher_is_priority: true } : axis) };
      const response = await POST(req({ action: "configure", workspace_id: f.workspace_id, config, scope: "1L",
        x_axis: "decision_impact", y_axis: "effort_cost", expected_config_revision: general.config.revision, rationale: "Accuracy owns this direction and pair" }));
      expect(response.status).toBe(200);
      const edited = (await response.json()).config;
      const stateUrl = `${url}&gap_id=${f.gap.id}&setting=1L`;
      const state = await (await GET(new Request(stateUrl))).json();
      expect(state).toMatchObject({ x_axis: "decision_impact", y_axis: "effort_cost", config: edited });
      expect(state.axes[1]).toMatchObject({ id: "effort_cost", higher_is_priority: true });
      expect(state.expected_config_revision).not.toBe(edited.revision);
      const placed = await POST(req({ action: "validate", workspace_id: f.workspace_id, gap_id: f.gap.id, setting: "1L", band: "medium",
        axis_scores: { decision_impact: 10, effort_cost: 90 }, expected_input_revision: state.expected_input_revision,
        expected_config_revision: state.expected_config_revision, rationale: "Validate the configured vertical-only favourable quadrant" }));
      expect(placed.status).toBe(200);
      const placement = (await placed.json()).placement;
      expect(placement).toMatchObject({ suggested_band: "medium", band: "medium", score: 50, validated: true });
      await runInWorkspace(defaultWorkspace, async () => {
        await saveAxes({ config: { ...DEFAULT_AXES, x_axis: "payer_value", y_axis: "patient_impact" }, actor_name: "Later Default editor" });
        await saveScopeAxes({ scope: "1L", x_axis: "strategic_fit", y_axis: "time_pressure", actor_name: "Later Default editor" });
      });
      jar.delete(WORKSPACE_COOKIE);
      const after = await (await GET(new Request(stateUrl))).json();
      expect(after.config).toEqual(edited);
      expect(after.expected_config_revision).toBe(state.expected_config_revision);
      expect(after.placements).toEqual([placement]);
      expect((await (await GET(new Request(reverseUrl))).json()).config).toEqual(general.config);
    } finally {
      jar.delete(WORKSPACE_COOKIE);
      // The plan owner has no deletion API; remove only this disposable cookie fixture.
      await sharedDb().execute(sql`drop schema ${sql.identifier(plan.schema_name)} cascade`);
      await sharedDb().execute(sql`delete from workspace_members where workspace_id = ${plan.id}`);
      await sharedDb().execute(sql`delete from workspaces where id = ${plan.id}`);
    }
  });
});
