import postgres from "postgres";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (name: string) => jar.has(name) ? { name, value: jar.get(name)! } : undefined,
  set: (name: string, value: string) => void jar.set(name, value), delete: (name: string) => void jar.delete(name) }), headers: async () => new Headers() }));
import { POST as applyPost } from "@/app/api/accuracy/claims/split/apply/route";
import { POST as proposalPost } from "@/app/api/accuracy/claims/split/propose/route";
import { POST as rollbackPost } from "@/app/api/accuracy/claims/split/rollback/route";
import { createSession, signOut } from "@/modules/auth/session";
import { listClaims, getClaim, claimMetadata } from "@/accuracy/store/claim-store";
import { deleteWorkspace } from "@/accuracy/store/tenant";
import { accuracyTransactionActive } from "@/accuracy/store/db";
import { accuracyRouteConfig, setAccuracyRouteConfig } from "@/accuracy/kernel/routing";
import { openAi } from "@/modules/llm/provider";
import { GET as splitGet } from "@/app/api/accuracy/claims/split/route";
import { aiSwitch, setAiEnabled } from "@/modules/kernel/ai-switch";
import { updateClaim } from "@/accuracy/store/claim-edit";
import { splitActor, splitFixture } from "./support/accuracy-split";

const workspaces: string[] = [];
let stubBefore: string | undefined;
beforeEach(() => { stubBefore = process.env.SYNAPSE_TEST_STUB_LLM; process.env.SYNAPSE_TEST_STUB_LLM = ""; });
afterEach(async () => { if (stubBefore === undefined) delete process.env.SYNAPSE_TEST_STUB_LLM; else process.env.SYNAPSE_TEST_STUB_LLM = stubBefore; await signOut(); jar.clear(); for (const id of workspaces.splice(0)) await deleteWorkspace(id); });
async function fixture() { const f = await splitFixture(); workspaces.push(f.workspace_id); return f; }
async function session(role: "operator" | "viewer" = "operator") {
  await createSession({ provider_id: "demo", subject: crypto.randomUUID(), actor_name: "Authenticated reviewer", actor_function: "medical_affairs", role });
}
const req = (body: unknown) => new Request("http://localhost/api/accuracy/claims/split", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
describe("Accuracy split API", () => {
  it("requires confirmation, applies exact human input with the session actor, and restores the parent", async () => {
    const f = await fixture(); await session();
    const body = { workspace_id: f.workspace_id, proposal: f.proposal, operation_key: "api-split", rationale: "Human confirms both slices", actor_name: "Forged actor", actor_function: "heor" };
    expect((await applyPost(req({ ...body, proposal: { ...body.proposal, confirmed: false } }))).status).toBe(400);
    expect(await listClaims(f.workspace_id)).toHaveLength(2);
    const response = await applyPost(req(body)); expect(response.status).toBe(200);
    const result = await response.json();
    expect(claimMetadata((await getClaim(f.workspace_id, result.addressed_gap_id))!).edit_history).toEqual([expect.objectContaining({ by: "Authenticated reviewer", by_function: "medical_affairs" })]);
    expect((await rollbackPost(req({ workspace_id: f.workspace_id, operation_id: result.operation_id, rationale: "Restore original input" }))).status).toBe(200);
    expect(await getClaim(f.workspace_id, f.parent.id)).toEqual(f.parent);
  });
  it("refuses viewer writes, unknown workspaces, malformed requests and wrong-workspace proposals", async () => {
    const f = await fixture(); await session("viewer");
    const body = { workspace_id: f.workspace_id, proposal: f.proposal, operation_key: "denied", rationale: "Cannot write" };
    expect((await applyPost(req(body))).status).toBe(403);
    await signOut(); await session();
    expect((await applyPost(req({ ...body, workspace_id: "missing" }))).status).toBe(404);
    expect((await applyPost(req({ ...body, proposal: { ...f.proposal, workspace_id: "other" } }))).status).toBe(404);
    expect((await applyPost(new Request("http://localhost", { method: "POST", body: "{" }))).status).toBe(400);
    expect(await listClaims(f.workspace_id)).toHaveLength(2);
  });
  it("runs the reused proposer/critic/judge outside the lock; accepted model output still requires human confirmation", async () => {
    const f = await fixture(); await session();
    const previousStub = process.env.SYNAPSE_TEST_STUB_LLM, previousKey = process.env.OPENAI_API_KEY;
    const config = await accuracyRouteConfig("partial_split", "proposer");
    process.env.SYNAPSE_TEST_STUB_LLM = ""; process.env.OPENAI_API_KEY = "fixture-provider-key";
    const calls: string[] = []; let reject = false;
    const provider = vi.spyOn(openAi, "complete").mockImplementation(async ({ user }) => {
      expect(accuracyTransactionActive()).toBe(false);
      const input = JSON.parse(user); expect(input.gap.id).toBe(f.parent.id); expect(input.permitted_evidence).toContainEqual(f.evidence[0]);
      if (input.last_critique) { calls.push("judge"); return JSON.stringify({ verdict: reject ? "reject" : "accept", confidence: 90, note: "Only outcomes are closed" }); }
      if (input.proposal) { calls.push("critic"); return JSON.stringify({ verdict: "keep", confidence: 90, note: "Comparison remains open", issues: [] }); }
      calls.push("proposer"); return JSON.stringify({ ...f.proposal, rationale: "Outcomes supported, comparator missing" });
    });
    try {
      await setAccuracyRouteConfig({ call_kind: "partial_split", agent_role: "proposer", provider_id: "openai", model: openAi.default_model, fallbacks: [], actor_name: "fixture" });
      const before = await listClaims(f.workspace_id);
      const response = await proposalPost(req({ workspace_id: f.workspace_id, gap_id: f.parent.id }));
      expect(response.status).toBe(200); const suggested = (await response.json()).proposal;
      expect(suggested).toMatchObject({ confirmed: false, parent_gap_id: f.parent.id, addressed_evidence: f.evidence });
      expect(calls).toEqual(["proposer", "critic", "critic", "critic", "judge"]);
      expect(await listClaims(f.workspace_id)).toEqual(before);
      expect((await applyPost(req({ workspace_id: f.workspace_id, proposal: suggested, operation_key: "model", rationale: "Not confirmed" }))).status).toBe(400);
      reject = true;
      expect((await (await proposalPost(req({ workspace_id: f.workspace_id, gap_id: f.parent.id }))).json()).proposal).toBeNull();
      expect(await listClaims(f.workspace_id)).toEqual(before);
    } finally {
      provider.mockRestore();
      if (previousStub === undefined) delete process.env.SYNAPSE_TEST_STUB_LLM; else process.env.SYNAPSE_TEST_STUB_LLM = previousStub;
      if (previousKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousKey;
      await setAccuracyRouteConfig({ ...config, actor_name: config.updated_by, temperature: config.params.temperature, max_tokens: config.params.max_tokens });
    }
  });
});

it("returns a sanitized server error and no partial data when persistence fails", async () => {
  const f = await fixture(); await session();
  const connection = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
  const trigger = `split_api_failure_${Date.now()}`;
  try {
    await connection.unsafe(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.workspace_id = '${f.workspace_id}' AND NEW.statement = 'Need comparative evidence against standard care.' THEN RAISE EXCEPTION 'private database failure'; END IF; RETURN NEW; END $$`);
    await connection.unsafe(`CREATE TRIGGER ${trigger} BEFORE INSERT ON accuracy_claims FOR EACH ROW EXECUTE FUNCTION ${trigger}()`);
    const response = await applyPost(req({ workspace_id: f.workspace_id, proposal: f.proposal, operation_key: "failure", rationale: "Confirmed slices" }));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, error: "Split action failed" });
    expect(await listClaims(f.workspace_id)).toHaveLength(2);
  } finally {
    await connection.unsafe(`DROP TRIGGER IF EXISTS ${trigger} ON accuracy_claims`);
    await connection.unsafe(`DROP FUNCTION IF EXISTS ${trigger}()`);
    await connection.end({ timeout: 5 });
  }
});

it("serves manual revisions and history with AI off, blocks proposals and permits confirmed apply", async () => {
  const f = await fixture(); await session();
  const before = await aiSwitch();
  try {
    await setAiEnabled({ enabled: false, actor_name: "Fixture admin" });
    const manual = await splitGet(new Request(`http://localhost/api/accuracy/claims/split?workspace_id=${f.workspace_id}&gap_id=${f.parent.id}`));
    expect(manual.status).toBe(200);
    expect(await manual.json()).toMatchObject({ ...pickRevisions(f.proposal), permitted_evidence: f.evidence, operations: [] });
    const proposed = await proposalPost(req({ workspace_id: f.workspace_id, gap_id: f.parent.id }));
    expect(proposed.status).toBe(409); expect(await proposed.json()).toMatchObject({ code: "ai_off" });
    const applied = await applyPost(req({ workspace_id: f.workspace_id, proposal: f.proposal, operation_key: "manual-off", rationale: "Human confirmed without AI" }));
    expect(applied.status).toBe(200);
    const result = await applied.json();
    const history = await splitGet(new Request(`http://localhost/api/accuracy/claims/split?workspace_id=${f.workspace_id}`));
    expect((await history.json()).operations).toEqual([expect.objectContaining({ id: result.operation_id, state: "applied" })]);
    await updateClaim({ workspace_id: f.workspace_id, claim_id: result.open_residual_gap_id, patch: { priority: "low" }, actor: splitActor, rationale: "Later residual priority" });
    const rollback = await rollbackPost(req({ workspace_id: f.workspace_id, operation_id: result.operation_id, rationale: "Blocked inverse" }));
    expect(rollback.status).toBe(409); expect(await rollback.json()).toMatchObject({ code: "rollback_blocked" });
  } finally { await setAiEnabled({ enabled: before.enabled, actor_name: "Fixture restore" }); }
});
function pickRevisions(proposal: Awaited<ReturnType<typeof splitFixture>>["proposal"]) {
  return { expected_parent_revision: proposal.expected_parent_revision, expected_coverage_revision: proposal.expected_coverage_revision };
}
