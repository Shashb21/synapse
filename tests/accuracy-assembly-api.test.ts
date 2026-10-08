import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { GET, POST } from "@/app/api/accuracy/assemblies/route";
import { AssemblyFeedbackError } from "@/accuracy/domain/assembly-feedback";
import * as feedbackStore from "@/accuracy/store/assembly-feedback-store";
import { createAssembly } from "@/accuracy/store/assembly-store";
import { publishGeneratedItemHistory } from "@/accuracy/store/item-history-store";
import { accuracyDb, ensureAccuracySchema } from "@/accuracy/store/db";
import * as t from "@/accuracy/store/schema";
import { createOrganization, createWorkspace, deleteWorkspace, grantOrganizationAccess } from "@/accuracy/store/tenant";
import { insertSourceFile } from "@/accuracy/store/source-store";
import { persistParseBlocks } from "@/accuracy/store/parse-store";
import { newId, nowIso } from "@/modules/kernel/ids";

const { sessionContext } = vi.hoisted(() => ({ sessionContext: vi.fn() }));
vi.mock("@/modules/auth/session", () => ({ sessionContext }));

const actor = { name: "Assembly reader", function: "medical_affairs" as const };
const session = { signed_in: true, demo: false, role: "viewer" as const, actor,
  session: { subject: "assembly-reader", provider_id: "test-provider", actor } };
const workspaces: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const workspace_id of workspaces.splice(0)) await deleteWorkspace(workspace_id);
});

async function fixture() {
  await ensureAccuracySchema();
  sessionContext.mockResolvedValue(session);
  const org_id = await createOrganization(newId("assembly-api-org"));
  const workspace_id = await createWorkspace({ org_id, name: "Assembly API", slug: newId("assembly-api") });
  workspaces.push(workspace_id);
  await grantOrganizationAccess({ subject: session.session.subject, org_id });
  const source = await insertSourceFile({ workspace_id, org_id, filename: "source.txt", mime: "text/plain", checksum: newId("sum") });
  const block_id = newId("block");
  await persistParseBlocks({ workspace_id, source_file_id: source.id, parser: "test",
    blocks: [{ id: block_id, source_file_id: source.id, index: 0, kind: "prose", heading: null, text: "Supported source text." }] });
  const gap = { id: "gap-api", statement: "API gap", external_id: null,
    provenance: [{ source_file_id: source.id, block_id, quote: "Supported source" }] };
  const run_id = newId("arun");
  const now = nowIso();
  await accuracyDb().insert(t.accuracyModuleRuns).values({ id: run_id, org_id, workspace_id, call_kind: "need_extract",
    agent_role: "proposer", module_id: "test", module_version: "1", status: "ok", started_at: now, finished_at: now,
    actor_name: actor.name, actor_function: actor.function,
    input: { workspace_id, source_file_id: source.id }, output: { workspace_id, source_file_id: source.id, gaps: [gap] }, steps: [] });
  await publishGeneratedItemHistory({ workspace_id, source_file_id: source.id, run_id, claim_type: "gap",
    final_claims: [{ id: gap.id, workspace_id, source_file_id: source.id, claim_type: "gap", statement: gap.statement }] });
  const [version] = await accuracyDb().select().from(t.accuracyItemVersions).where(eq(t.accuracyItemVersions.workspace_id, workspace_id));
  const assembly = await createAssembly({ workspace_id, actor, source_file_ids: [source.id],
    selections: [{ item_version_id: version!.id, reason: "readable" }], mappings: [], coverage_run_ids: [], linking_complete: true,
    extraction_runs: [{ call_kind: "need_extract", run_id, source_file_id: source.id, item_count: 1,
      outcome: "items", evaluation_context: "production" }] });
  return { org_id, workspace_id, assembly };
}

function get(query: string) {
  return GET(new Request(`http://localhost/api/accuracy/assemblies?${query}`));
}

function post(body: unknown) {
  return POST(new Request("http://localhost/api/accuracy/assemblies", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));
}

function feedbackBody(scope: Awaited<ReturnType<typeof fixture>>) {
  return { action: "feedback", workspace_id: scope.workspace_id, assembly_id: scope.assembly.id,
    expected_fingerprint: scope.assembly.fingerprint, approval_review_id: "review-1",
    consumer_run_id: "consumer-1", selected_item_version_ids: [], category: "edited", rationale: "Adjusted wording." };
}

describe("authorized assembly API", () => {
  it("requires a signed-in authorized workspace and supports strict list/read queries", async () => {
    const scope = await fixture();
    const list = await get(`workspace_id=${scope.workspace_id}`);
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({ assemblies: [scope.assembly] });

    const read = await get(`workspace_id=${scope.workspace_id}&assembly_id=${scope.assembly.id}`);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      assembly: scope.assembly,
      can_review: false,
      can_feedback: false,
      feedback: [],
      feedback_runs: [],
      review_state: { assembly_id: scope.assembly.id, status: "stale", expected_review_id: null, latest_decision: null },
    });

    sessionContext.mockResolvedValue({ ...session, signed_in: false, session: null });
    expect((await get(`workspace_id=${scope.workspace_id}`)).status).toBe(401);

    sessionContext.mockResolvedValue({ ...session, session: { subject: "foreign" } });
    expect((await get(`workspace_id=${scope.workspace_id}`)).status).toBe(404);
    expect((await get(`workspace_id=${scope.workspace_id}&assembly_id=missing`)).status).toBe(404);
  });

  it("keeps list lightweight and exposes exact feedback history and eligible runs to authorized readers", async () => {
    const scope = await fixture();
    const feedback = [{ id: "feedback-1", assembly_id: scope.assembly.id, rationale: "Edited" }];
    const runs = [{ run_id: "consumer-1", approval_review_id: "review-1", consumed_item_version_ids: ["item-1"] }];
    const history = vi.spyOn(feedbackStore, "listAssemblyFeedback").mockResolvedValue(feedback as never);
    const eligible = vi.spyOn(feedbackStore, "listAssemblyFeedbackRuns").mockResolvedValue(runs as never);
    const listBody = await (await get(`workspace_id=${scope.workspace_id}`)).json();
    expect(listBody).not.toHaveProperty("feedback");
    expect(listBody).not.toHaveProperty("feedback_runs");
    expect(history).not.toHaveBeenCalled();
    expect(eligible).not.toHaveBeenCalled();
    const detail = await get(`workspace_id=${scope.workspace_id}&assembly_id=${scope.assembly.id}`);
    expect(await detail.json()).toMatchObject({ feedback, feedback_runs: runs, can_feedback: false });
    expect(history).toHaveBeenCalledWith(scope.workspace_id, scope.assembly.id);
    expect(eligible).toHaveBeenCalledWith(scope.workspace_id, scope.assembly.id);
    sessionContext.mockResolvedValue({ ...session, role: "contributor" });
    const contributorDetail = await get(`workspace_id=${scope.workspace_id}&assembly_id=${scope.assembly.id}`);
    expect(await contributorDetail.json()).toMatchObject({ can_feedback: true });
  });

  it("requires a signed-in authorized contributor for feedback", async () => {
    const scope = await fixture();
    const body = feedbackBody(scope);
    sessionContext.mockResolvedValue({ ...session, signed_in: false, session: null });
    expect((await post(body)).status).toBe(401);
    sessionContext.mockResolvedValue(session);
    expect((await post(body)).status).toBe(403);
    sessionContext.mockResolvedValue({ ...session, role: "medical_affairs" });
    expect((await post(body)).status).toBe(403);
    sessionContext.mockResolvedValue({ ...session, role: "contributor", session: { ...session.session, subject: "foreign" } });
    expect((await post(body)).status).toBe(404);
  });

  it("rejects forged identity and unknown feedback fields before persistence", async () => {
    const scope = await fixture();
    sessionContext.mockResolvedValue({ ...session, role: "contributor" });
    const create = vi.spyOn(feedbackStore, "createAssemblyFeedback");
    for (const extra of [{ contributor: { subject: "forged" } }, { actor: actor }, { unexpected: true }]) {
      const response = await post({ ...feedbackBody(scope), ...extra });
      expect(response.status).toBe(400);
    }
    expect(create).not.toHaveBeenCalled();
  });

  it("saves feedback for an exact assembly with server session identity", async () => {
    const scope = await fixture();
    sessionContext.mockResolvedValue({ ...session, role: "contributor" });
    const created = { id: "feedback-1", actor_subject: session.session.subject, actor_provider: session.session.provider_id };
    const create = vi.spyOn(feedbackStore, "createAssemblyFeedback").mockResolvedValue(created as never);
    const body = { ...feedbackBody(scope), selected_item_version_ids: ["item-1"] };
    const response = await post(body);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, feedback: created });
    expect(create).toHaveBeenCalledWith({
      workspace_id: scope.workspace_id, assembly_id: scope.assembly.id,
      expected_fingerprint: scope.assembly.fingerprint, approval_review_id: "review-1",
      consumer_run_id: "consumer-1", selected_item_version_ids: ["item-1"],
      category: "edited", rationale: "Adjusted wording.",
      contributor: { subject: session.session.subject, provider: "test-provider", actor },
    });
  });

  it("maps invalid consumer and subset proofs to a useful validation response", async () => {
    const scope = await fixture();
    sessionContext.mockResolvedValue({ ...session, role: "contributor" });
    const invalidConsumer = await post(feedbackBody(scope));
    expect(invalidConsumer.status).toBe(400);
    expect(await invalidConsumer.json()).toMatchObject({ code: "invalid_input" });
    const create = vi.spyOn(feedbackStore, "createAssemblyFeedback")
      .mockRejectedValue(new AssemblyFeedbackError("invalid_input", "Selected item version was not consumed from this assembly."));
    const invalidSubset = await post({ ...feedbackBody(scope), selected_item_version_ids: ["foreign-item"] });
    expect(invalidSubset.status).toBe(400);
    expect(await invalidSubset.json()).toEqual({ error: "Selected item version was not consumed from this assembly.", code: "invalid_input" });
    expect(create).toHaveBeenCalledOnce();
  });

  it.each(["", "workspace_id=", "workspace_id=w&workspace_id=w", "workspace_id=w&assembly_id=", "workspace_id=w&assembly_id=a&assembly_id=a", "workspace_id=w&extra=1"])
  ("rejects malformed or extra query parameters: %s", async query => {
    sessionContext.mockResolvedValue(session);
    expect((await get(query)).status).toBe(400);
  });

  it("logs runtime faults and returns a generic 500", async () => {
    const scope = await fixture();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(await import("@/accuracy/store/assembly-store"), "listAssemblies").mockRejectedValue(new Error("private database detail"));
    const response = await get(`workspace_id=${scope.workspace_id}`);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Could not read assemblies" });
    expect(log).toHaveBeenCalledOnce();
  });
});

it("reports guarded split approval conflicts without hiding the actionable reason", async () => {
  const scope = await fixture();
  sessionContext.mockResolvedValue({ ...session, role: "contributor" });
  const review = await import("@/accuracy/store/assembly-review-store");
  const { SplitError } = await import("@/accuracy/store/partial-split-store");
  vi.spyOn(review, "reviewAssembly").mockRejectedValueOnce(new SplitError("rollback_blocked", "Later human priority placement blocks approval."));
  const response = await post({ workspace_id: scope.workspace_id, assembly_id: scope.assembly.id,
    expected_fingerprint: scope.assembly.fingerprint, decision: "approve", rationale: "Reviewed exact candidate" });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: "rollback_blocked", error: "Later human priority placement blocks approval." });
});
