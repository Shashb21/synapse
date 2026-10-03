/** Exercise real tenant grants and persisted item history through the authenticated API. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { accuracyDb } from "@/accuracy/store/db";
import * as t from "@/accuracy/store/schema";
import * as historyStore from "@/accuracy/store/item-history-store";
import { createOrganization, createWorkspace, deleteWorkspace, grantOrganizationAccess } from "@/accuracy/store/tenant";
import { insertSourceFile } from "@/accuracy/store/source-store";
import * as tenant from "@/accuracy/store/tenant";
import { newId, nowIso } from "@/modules/kernel/ids";

const { sessionContext } = vi.hoisted(() => ({ sessionContext: vi.fn() }));
vi.mock("@/modules/auth/session", () => ({ sessionContext }));
import { GET } from "@/app/api/accuracy/claims/history/route";
import { POST } from "@/app/api/accuracy/claims/relationships/route";

const session = { signed_in: true, session: { subject: "item-history-api-subject" },
  role: "contributor" as const, actor: { name: "Server contributor", function: "medical_affairs" as const } };
const workspaces: string[] = [];
beforeEach(() => sessionContext.mockResolvedValue(session));
afterEach(async () => {
  vi.restoreAllMocks();
  for (const id of workspaces.splice(0)) await deleteWorkspace(id);
});

async function fixture() {
  const org_id = await createOrganization(newId("history-api-org"));
  const workspace_id = await createWorkspace({ org_id, name: "History API", slug: newId("slug") });
  workspaces.push(workspace_id);
  await grantOrganizationAccess({ subject: session.session.subject, org_id });
  const source = await insertSourceFile({ workspace_id, filename: "source.txt", mime: "text/plain", checksum: newId("sum") });
  const block_id = newId("block"); const now = nowIso(); const run_id = newId("run"); const claim_id = newId("gap");
  await accuracyDb().insert(t.accuracyParseBlocks).values({ id: block_id, workspace_id, source_file_id: source.id,
    index: 0, kind: "paragraph", heading: null, text: "Evidence", parser: "test", created_at: now });
  const provenance = [{ source_file_id: source.id, block_id, quote: "Evidence" }];
  const final = { workspace_id, source_file_id: source.id, gaps: [{ id: claim_id, statement: "Final question", external_id: null, provenance }] };
  await accuracyDb().insert(t.accuracyModuleRuns).values({ id: run_id, org_id, workspace_id, call_kind: "need_extract",
    agent_role: "proposer", module_id: "test", module_version: "1", status: "ok", started_at: now, finished_at: now,
    actor_name: "Extractor", actor_function: "medical_affairs", input: { workspace_id, source_file_id: source.id }, output: final, steps: [] });
  await accuracyDb().insert(t.accuracyAgentEvents).values({ id: newId("event"), run_id, workspace_id,
    event_type: "snapshot", iteration: 0, payload: { output: { ...final, gaps: [{ ...final.gaps[0], statement: "Earlier question" }] } }, recorded_at: now });
  await historyStore.publishGeneratedItemHistory({ workspace_id, source_file_id: source.id, run_id, claim_type: "gap",
    final_claims: [{ id: claim_id, workspace_id, source_file_id: source.id, claim_type: "gap", statement: "Final question" }] });
  const [proposal] = await accuracyDb().select().from(t.accuracyItemRelationshipProposals)
    .where(eq(t.accuracyItemRelationshipProposals.workspace_id, workspace_id));
  return { workspace_id, claim_id, proposal_id: proposal.id, predecessor_ids: proposal.predecessor_ids, successor_ids: proposal.successor_ids };
}
function get(workspace_id: string, claim_id: string) {
  return GET(new Request(`http://localhost/api/accuracy/claims/history?${new URLSearchParams({ workspace_id, claim_id })}`));
}
function post(body: unknown) {
  return POST(new Request("http://localhost/api/accuracy/claims/relationships", { method: "POST", body: JSON.stringify(body) }));
}
function decision(scope: Awaited<ReturnType<typeof fixture>>, action = "confirm") {
  return { action, workspace_id: scope.workspace_id, proposal_id: scope.proposal_id, rationale: "  Reviewed source evidence  " };
}
async function decisions(proposal_id: string) {
  return accuracyDb().select().from(t.accuracyItemRelationshipDecisions).where(eq(t.accuracyItemRelationshipDecisions.proposal_id, proposal_id));
}

describe("authorized item history API", () => {
  it("requires a signed-in session for both endpoints", async () => {
    sessionContext.mockResolvedValue({ ...session, signed_in: false });
    expect((await get("workspace", "claim")).status).toBe(401);
    expect((await post({})).status).toBe(401);
  });
  it.each(["propose", "confirm", "reject"])("forbids viewer %s without a write", async action => {
    const scope = await fixture(); sessionContext.mockResolvedValue({ ...session, role: "viewer" });
    const boundary = vi.spyOn(historyStore, "decideItemRelationship");
    const proposalBoundary = vi.spyOn(historyStore, "proposeItemRelationship");
    expect((await post({ ...decision(scope), action })).status).toBe(403);
    expect(await decisions(scope.proposal_id)).toEqual([]);
    expect(boundary).not.toHaveBeenCalled(); expect(proposalBoundary).not.toHaveBeenCalled();
  });
  it.each(["viewer", "contributor", "operator", "medical_affairs"])("reads granted history and derives %s decision capability", async role => {
    const scope = await fixture(); sessionContext.mockResolvedValue({ ...session, role });
    const response = await get(scope.workspace_id, scope.claim_id);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ can_decide: role !== "viewer", history: { canonical_claim_id: scope.claim_id,
      versions: [{ run_id: expect.any(String), snapshot_id: null, iteration: null, claim_id: scope.claim_id }] } });
  });
  it("denies ungranted read, proposal and decision with no persistence access", async () => {
    const scope = await fixture(); sessionContext.mockResolvedValue({ ...session, session: { subject: "ungranted-subject" } });
    const read = vi.spyOn(historyStore, "readItemHistory"); const decide = vi.spyOn(historyStore, "decideItemRelationship");
    const propose = vi.spyOn(historyStore, "proposeItemRelationship");
    expect((await get(scope.workspace_id, scope.claim_id)).status).toBe(404);
    expect((await post(decision(scope))).status).toBe(404);
    expect((await post({ action: "propose", ...scope, claim_id: undefined, proposal_id: undefined, kind: "same_item", rationale: "Distinct items" })).status).toBe(404);
    expect(read).not.toHaveBeenCalled(); expect(decide).not.toHaveBeenCalled(); expect(propose).not.toHaveBeenCalled();
    expect(await decisions(scope.proposal_id)).toEqual([]);
  });
  it.each(["", "workspace_id=w", "workspace_id=&claim_id=c", "workspace_id=w&claim_id=", "workspace_id=w&claim_id=c&claim_id=c",
    "workspace_id=w&workspace_id=w&claim_id=c", "workspace_id=w&claim_id=c&actor=forged", "workspace_id=w&claim_id=%20"])
  ("rejects invalid or extra query parameters: %s", async query => {
    const read = vi.spyOn(historyStore, "readItemHistory");
    expect((await GET(new Request(`http://localhost/api/accuracy/claims/history?${query}`))).status).toBe(400);
    expect(read).not.toHaveBeenCalled();
  });
  it("scopes existing foreign claims and proposals exactly like missing ones", async () => {
    const owner = await fixture(); const other = await fixture();
    expect((await get(owner.workspace_id, other.claim_id)).status).toBe(404);
    expect((await get(owner.workspace_id, "missing")).status).toBe(404);
    expect((await post({ ...decision(owner), proposal_id: other.proposal_id })).status).toBe(404);
    expect((await post({ ...decision(owner), proposal_id: "missing" })).status).toBe(404);
    expect(await decisions(other.proposal_id)).toEqual([]);
  });
  it.each(["confirm", "reject"])("persists contributor %s with trimmed rationale and server actor", async action => {
    const scope = await fixture(); const response = await post(decision(scope, action));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ histories: expect.any(Array) });
    expect(await decisions(scope.proposal_id)).toMatchObject([{ action, rationale: "Reviewed source evidence",
      actor_name: session.actor.name, actor_function: session.actor.function }]);
    expect((await get(scope.workspace_id, scope.predecessor_ids[0])).status).toBe(200);
    expect((await post(decision(scope))).status).toBe(409);
    expect(await decisions(scope.proposal_id)).toHaveLength(1);
  });
  it("proposes a relationship with server identity after a prior rejection", async () => {
    const scope = await fixture(); await post(decision(scope, "reject"));
    const response = await post({ action: "propose", workspace_id: scope.workspace_id, kind: "same_item",
      predecessor_ids: scope.predecessor_ids, successor_ids: scope.successor_ids, rationale: "  Review again  " });
    expect(response.status).toBe(201); const body = await response.json(); expect(body.proposal.id).toEqual(expect.any(String));
    const [stored] = await accuracyDb().select().from(t.accuracyItemRelationshipProposals).where(eq(t.accuracyItemRelationshipProposals.id, body.proposal.id));
    expect(stored).toMatchObject({ actor_name: session.actor.name, actor_function: session.actor.function, rationale: "Review again" });
  });
  it.each([{ actor: { name: "forged" } }, { actor_name: "forged" }, { org_id: "forged" }, { kind: "same_item" },
    { rationale: " ab " }, { proposal_id: " " }, { action: "delete" }, { workspace_id: "" }])("rejects invalid decision fields %j before writes", async extra => {
    const scope = await fixture(); const boundary = vi.spyOn(historyStore, "decideItemRelationship");
    expect((await post({ ...decision(scope), ...extra })).status).toBe(400);
    expect(boundary).not.toHaveBeenCalled(); expect(await decisions(scope.proposal_id)).toEqual([]);
  });
  it.each([{ predecessor_ids: [] }, { predecessor_ids: ["a", " a "] }, { successor_ids: [" "] }, { kind: "invalid" },
    { actor: session.actor }, { proposal_id: "forged" }, { rationale: "ab" }])("rejects invalid proposal fields %j before writes", async extra => {
    const boundary = vi.spyOn(historyStore, "proposeItemRelationship");
    expect((await post({ action: "propose", workspace_id: "workspace", kind: "same_item", predecessor_ids: ["a"], successor_ids: ["b"], rationale: "Review identity", ...extra })).status).toBe(400);
    expect(boundary).not.toHaveBeenCalled();
  });
  it("requires a session subject even when signed_in is true", async () => {
    const scope = await fixture(); sessionContext.mockResolvedValue({ ...session, session: null });
    expect((await get(scope.workspace_id, scope.claim_id)).status).toBe(404);
    expect((await post(decision(scope))).status).toBe(404);
    expect(await decisions(scope.proposal_id)).toEqual([]);
  });
  it("returns 409 for a proposal already participating in a pending relationship", async () => {
    const scope = await fixture();
    expect((await post({ action: "propose", workspace_id: scope.workspace_id, kind: "same_item",
      predecessor_ids: scope.predecessor_ids, successor_ids: scope.successor_ids, rationale: "Review identity" })).status).toBe(409);
    const proposals = await accuracyDb().select().from(t.accuracyItemRelationshipProposals)
      .where(eq(t.accuracyItemRelationshipProposals.workspace_id, scope.workspace_id));
    expect(proposals).toHaveLength(1);
  });
  it("allows operators to use the existing cross-organization access policy", async () => {
    const scope = await fixture(); sessionContext.mockResolvedValue({ ...session, role: "operator", session: { subject: "operator-without-grant" } });
    expect((await get(scope.workspace_id, scope.claim_id)).status).toBe(200);
    expect((await post(decision(scope, "reject"))).status).toBe(200);
  });
  it("logs authorization storage faults with generic responses", async () => {
    const scope = await fixture(); const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(tenant, "getAuthorizedWorkspace").mockRejectedValue(new Error("private grant table details"));
    const read = await get(scope.workspace_id, scope.claim_id); const write = await post(decision(scope));
    expect(read.status).toBe(500); expect(await read.json()).toEqual({ error: "Could not read item history" });
    expect(write.status).toBe(500); expect(await write.json()).toEqual({ error: "Could not review item relationship" });
    expect(log).toHaveBeenCalledTimes(2); expect(await decisions(scope.proposal_id)).toEqual([]);
  });
  it("rejects malformed JSON", async () => {
    expect((await POST(new Request("http://localhost/api/accuracy/claims/relationships", { method: "POST", body: "{" }))).status).toBe(400);
  });
  it("maps store invalid input and foreign proposal claims to 400 and 404", async () => {
    const scope = await fixture(); const other = await fixture();
    const base = { action: "propose", workspace_id: scope.workspace_id, kind: "same_item", predecessor_ids: scope.predecessor_ids, rationale: "Review identity" };
    expect((await post({ ...base, successor_ids: scope.predecessor_ids })).status).toBe(400);
    expect((await post({ ...base, successor_ids: [other.claim_id] })).status).toBe(404);
  });
  it("returns 409 for a stale proposal without recording a decision", async () => {
    const scope = await fixture();
    const [version] = await accuracyDb().select().from(t.accuracyItemVersions).where(eq(t.accuracyItemVersions.claim_id, scope.claim_id));
    await accuracyDb().insert(t.accuracyItemVersions).values({ ...version, id: newId("iver"), origin_key: newId("origin") });
    expect((await post(decision(scope))).status).toBe(409); expect(await decisions(scope.proposal_id)).toEqual([]);
  });
  it("logs runtime read and write faults without exposing their details", async () => {
    const scope = await fixture(); const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(historyStore, "readItemHistory").mockRejectedValue(new Error("private database password"));
    vi.spyOn(historyStore, "decideItemRelationship").mockRejectedValue(new Error("private database password"));
    vi.spyOn(historyStore, "proposeItemRelationship").mockRejectedValue(new Error("private database password"));
    const responses = [await get(scope.workspace_id, scope.claim_id), await post(decision(scope)), await post({ action: "propose",
      workspace_id: scope.workspace_id, kind: "same_item", predecessor_ids: scope.predecessor_ids, successor_ids: scope.successor_ids, rationale: "Review identity" })];
    for (const response of responses) { expect(response.status).toBe(500); expect(JSON.stringify(await response.json())).not.toContain("private"); }
    expect(log).toHaveBeenCalledTimes(3);
  });
});
