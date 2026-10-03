import { afterEach, describe, expect, it } from "vitest";
import { accuracyDb } from "@/accuracy/store/db";
import * as t from "@/accuracy/store/schema";
import { createOrganization, createWorkspace, deleteWorkspace } from "@/accuracy/store/tenant";
import { insertSourceFile } from "@/accuracy/store/source-store";
import { publishGeneratedItemHistory, readItemHistory, proposeItemRelationship, decideItemRelationship } from "@/accuracy/store/item-history-store";
import { newId, nowIso } from "@/modules/kernel/ids";
import { eq } from "drizzle-orm";
import { isDownstreamClaim } from "@/accuracy/domain/item-history";

const workspaces: string[] = [];
const actor = { name: "Contributor", function: "medical_affairs" as const };
const span = { source_file_id: "", block_id: "", quote: "Evidence" };

async function fixture() {
  const org_id = await createOrganization("history test");
  const workspace_id = await createWorkspace({ org_id, name: "history", slug: newId("slug") });
  workspaces.push(workspace_id);
  const source = await insertSourceFile({ workspace_id, filename: "input.txt", mime: "text/plain", checksum: newId("sum") });
  const block_id = newId("block");
  await accuracyDb().insert(t.accuracyParseBlocks).values({ id: block_id, workspace_id, source_file_id: source.id,
    index: 0, kind: "paragraph", heading: null, text: "Evidence", parser: "test", created_at: nowIso() });
  return { org_id, workspace_id, source_file_id: source.id, block_id };
}

async function run(scope: Awaited<ReturnType<typeof fixture>>, outputs: unknown[], final: unknown) {
  const id = newId("run");
  const now = nowIso();
  await accuracyDb().insert(t.accuracyModuleRuns).values({ id, org_id: scope.org_id, workspace_id: scope.workspace_id,
    call_kind: "need_extract", agent_role: "proposer", module_id: "test", module_version: "1", status: "ok",
    started_at: now, finished_at: now, actor_name: actor.name, actor_function: actor.function,
    input: { workspace_id: scope.workspace_id, source_file_id: scope.source_file_id }, output: final, steps: [] });
  for (const [iteration, output] of outputs.entries()) await accuracyDb().insert(t.accuracyAgentEvents).values({
    id: newId("event"), run_id: id, workspace_id: scope.workspace_id, event_type: "snapshot", iteration,
    payload: { event_type: "snapshot", iteration, output }, recorded_at: now,
  });
  return id;
}

function gap(scope: Awaited<ReturnType<typeof fixture>>, statement: string, id = newId("gap")) {
  return { id, statement, external_id: null, provenance: [{ ...span, source_file_id: scope.source_file_id, block_id: scope.block_id }] };
}

async function seedClaims(scope: Awaited<ReturnType<typeof fixture>>, count: number) {
  const items = Array.from({ length: count }, (_, index) => gap(scope, `Question ${index}`));
  const output = { workspace_id: scope.workspace_id, source_file_id: scope.source_file_id, gaps: items };
  const run_id = await run(scope, [output], output);
  await publishGeneratedItemHistory({ ...scope, run_id, claim_type: "gap", final_claims: items.map(item => ({
    id: item.id, workspace_id: scope.workspace_id, claim_type: "gap", statement: item.statement, source_file_id: scope.source_file_id,
  })) });
  return items.map(item => item.id);
}

afterEach(async () => { for (const id of workspaces.splice(0)) await deleteWorkspace(id); });

describe("generated item history store", () => {
  it("retains two source-backed alternatives under one exact entry and keeps origins", async () => {
    const scope = await fixture();
    const item = gap(scope, "What is needed?");
    const output = { workspace_id: scope.workspace_id, source_file_id: scope.source_file_id, gaps: [item] };
    const firstRun = await run(scope, [output, { ...output, gaps: [{ ...item, id: "other" }] }], output);
    const first = await publishGeneratedItemHistory({ ...scope, run_id: firstRun, claim_type: "gap", final_claims: [{ id: item.id, workspace_id: scope.workspace_id, claim_type: "gap", statement: item.statement, source_file_id: scope.source_file_id }] });
    const history = await readItemHistory(scope.workspace_id, first.claim_ids[0]);
    expect(history?.versions).toHaveLength(2);
    expect(history?.versions.map(v => [v.run_id, v.iteration, v.claim_id])).toEqual([[firstRun, 0, item.id], [firstRun, 1, item.id]]);
  });

  it("leaves pending identity proposals review-only, then confirms a join without changing version origins", async () => {
    const scope = await fixture();
    const a = gap(scope, "First draft"); const b = gap(scope, "Final question");
    const output = { workspace_id: scope.workspace_id, source_file_id: scope.source_file_id, gaps: [b] };
    const run_id = await run(scope, [{ ...output, gaps: [a] }], output);
    const published = await publishGeneratedItemHistory({ ...scope, run_id, claim_type: "gap", final_claims: [{ id: b.id, workspace_id: scope.workspace_id, claim_type: "gap", statement: b.statement, source_file_id: scope.source_file_id }] });
    const before = await readItemHistory(scope.workspace_id, b.id);
    expect(before?.versions).toHaveLength(1);
    const draft = await accuracyDb().select().from(t.accuracyClaims);
    const draftId = draft.find(row => row.id !== b.id && row.workspace_id === scope.workspace_id)?.id;
    expect(draftId).toBeTruthy();
    const [proposal] = await accuracyDb().select().from(t.accuracyItemRelationshipProposals);
    expect(proposal?.basis_version_ids).toHaveLength(2);
    expect((await readItemHistory(scope.workspace_id, b.id))?.versions).toHaveLength(1);
    const decided = await decideItemRelationship({ workspace_id: scope.workspace_id, proposal_id: proposal.id, action: "confirm", rationale: "Confirmed revision", actor });
    expect(decided[0]?.versions).toHaveLength(2);
    expect(decided[0]?.versions.find(v => v.iteration === 0)?.claim_id).toBe(draftId);
    await expect(decideItemRelationship({ workspace_id: scope.workspace_id, proposal_id: proposal.id, action: "reject", rationale: "Too late", actor })).rejects.toMatchObject({ code: "conflict" });
    expect(published.claim_ids).toEqual([b.id]);
  });

  it("rejects cross-workspace, duplicate, and self relationships before writing", async () => {
    const owner = await fixture(); const other = await fixture();
    const [a, b] = await seedClaims(owner, 2);
    const [foreign] = await seedClaims(other, 1);
    const base = { workspace_id: owner.workspace_id, kind: "same_item" as const,
      predecessor_ids: [a], successor_ids: [b], rationale: "Review identity", actor };
    await expect(proposeItemRelationship({ ...base, successor_ids: [foreign] })).rejects.toMatchObject({ code: "not_found" });
    await expect(proposeItemRelationship({ ...base, predecessor_ids: [a, a] })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(proposeItemRelationship({ ...base, successor_ids: [a] })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(proposeItemRelationship(base)).rejects.toMatchObject({ code: "conflict" });
    const proposals = await accuracyDb().select().from(t.accuracyItemRelationshipProposals).where(eq(t.accuracyItemRelationshipProposals.workspace_id, owner.workspace_id));
    expect(proposals).toHaveLength(0);
  });

  it("enforces split and merge cardinality, history-only successors, and one decision", async () => {
    const scope = await fixture();
    const [a, b, c, d] = await seedClaims(scope, 4);
    const base = { workspace_id: scope.workspace_id, rationale: "Distinct generated descendants", actor };
    await expect(proposeItemRelationship({ ...base, kind: "split", predecessor_ids: [a], successor_ids: [b] })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(proposeItemRelationship({ ...base, kind: "merge", predecessor_ids: [a], successor_ids: [b] })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(proposeItemRelationship({ ...base, kind: "split", predecessor_ids: [a], successor_ids: [b, c] })).rejects.toMatchObject({ code: "invalid_input" });
    for (const id of [b, c, d]) await accuracyDb().update(t.accuracyClaims).set({ metadata: { history_only: true } }).where(eq(t.accuracyClaims.id, id));
    const proposal = await proposeItemRelationship({ ...base, kind: "split", predecessor_ids: [a], successor_ids: [b, c] });
    expect((await readItemHistory(scope.workspace_id, a))?.relationships[0]?.decision).toBeNull();
    await decideItemRelationship({ ...base, proposal_id: proposal.id, action: "reject" });
    expect((await readItemHistory(scope.workspace_id, a))?.canonical_claim_id).toBe(a);
    await expect(decideItemRelationship({ ...base, proposal_id: proposal.id, action: "confirm" })).rejects.toMatchObject({ code: "conflict" });
    const merge = await proposeItemRelationship({ ...base, kind: "merge", predecessor_ids: [a, b], successor_ids: [d] });
    await decideItemRelationship({ ...base, proposal_id: merge.id, action: "confirm" });
    await expect(proposeItemRelationship({ ...base, kind: "split", predecessor_ids: [d], successor_ids: [b, c] })).rejects.toMatchObject({ code: "conflict" });
  });

  it("publishes concurrently exactly once and rolls back a mismatched final claim", async () => {
    const scope = await fixture();
    const item = gap(scope, "Question");
    const output = { workspace_id: scope.workspace_id, source_file_id: scope.source_file_id, gaps: [item] };
    const run_id = await run(scope, [output], output);
    const request = { ...scope, run_id, claim_type: "gap" as const, final_claims: [{ id: item.id,
      workspace_id: scope.workspace_id, claim_type: "gap" as const, statement: item.statement, source_file_id: scope.source_file_id }] };
    await expect(publishGeneratedItemHistory({ ...request, final_claims: [{ ...request.final_claims[0], statement: "wrong" }] }))
      .rejects.toMatchObject({ code: "invalid_input" });
    expect(await accuracyDb().select().from(t.accuracyItemVersions).where(eq(t.accuracyItemVersions.workspace_id, scope.workspace_id))).toHaveLength(0);
    const results = await Promise.all([publishGeneratedItemHistory(request), publishGeneratedItemHistory(request)]);
    expect(results).toEqual([{ claim_ids: [item.id] }, { claim_ids: [item.id] }]);
    expect((await readItemHistory(scope.workspace_id, item.id))?.versions).toHaveLength(1);
    const deleted = await deleteWorkspace(scope.workspace_id);
    workspaces.splice(workspaces.indexOf(scope.workspace_id), 1);
    expect(deleted.deleted.item_versions).toBe(1);
  });

  it("keeps a judged final canonical when it exactly matches a prior history-only draft", async () => {
    const scope = await fixture();
    const alternative = gap(scope, "Earlier wording");
    const firstFinal = gap(scope, "Different final");
    const firstOutput = { workspace_id: scope.workspace_id, source_file_id: scope.source_file_id, gaps: [firstFinal] };
    const firstRun = await run(scope, [{ ...firstOutput, gaps: [alternative] }], firstOutput);
    await publishGeneratedItemHistory({ ...scope, run_id: firstRun, claim_type: "gap", final_claims: [{ id: firstFinal.id,
      workspace_id: scope.workspace_id, claim_type: "gap", statement: firstFinal.statement, source_file_id: scope.source_file_id }] });
    const [pending] = await accuracyDb().select().from(t.accuracyItemRelationshipProposals)
      .where(eq(t.accuracyItemRelationshipProposals.workspace_id, scope.workspace_id));
    await decideItemRelationship({ workspace_id: scope.workspace_id, proposal_id: pending.id, action: "reject", rationale: "Separate questions", actor });
    const priorDraftId = pending.predecessor_ids[0];
    const judged = { ...alternative, id: newId("gap") };
    const secondOutput = { workspace_id: scope.workspace_id, source_file_id: scope.source_file_id, gaps: [judged] };
    const secondRun = await run(scope, [secondOutput], secondOutput);
    const published = await publishGeneratedItemHistory({ ...scope, run_id: secondRun, claim_type: "gap", final_claims: [{ id: judged.id,
      workspace_id: scope.workspace_id, claim_type: "gap", statement: judged.statement, source_file_id: scope.source_file_id }] });
    expect(published.claim_ids).toEqual([judged.id]);
    const history = await readItemHistory(scope.workspace_id, priorDraftId);
    expect(history?.canonical_claim_id).toBe(judged.id);
    expect(history?.versions.map(v => v.claim_id)).toEqual([priorDraftId, judged.id]);
    expect(isDownstreamClaim(history!.claim)).toBe(true);
    const [retired] = await accuracyDb().select().from(t.accuracyClaims).where(eq(t.accuracyClaims.id, priorDraftId));
    expect(retired.metadata).toMatchObject({ history_only: true, merged_into: judged.id });
  });
});
